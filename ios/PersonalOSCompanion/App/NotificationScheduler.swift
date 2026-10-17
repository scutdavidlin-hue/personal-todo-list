import Foundation
import ActivityKit
import UserNotifications

struct NotificationReceipt {
    let expected: Int
    let verified: Int
    let skippedPast: Int
    var message: String { "系统待发送列表已核实 \(verified)/\(expected) 条；跳过 \(skippedPast) 条已过时刻。尚未验证送达。" }
}

struct NotificationScheduler {
    let center = UNUserNotificationCenter.current()

    func requestPermission() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func permissionSnapshot() async -> DevicePermissions {
        let settings = await center.notificationSettings()
        let state: String
        switch settings.authorizationStatus {
        case .notDetermined: state = "notDetermined"
        case .denied: state = "denied"
        case .authorized: state = "authorized"
        case .provisional: state = "provisional"
        case .ephemeral: state = "ephemeral"
        @unknown default: state = "unknown"
        }
        return DevicePermissions(notificationAuthorization: state, alertsEnabled: settings.alertSetting == .enabled,
                                 soundEnabled: settings.soundSetting == .enabled,
                                 liveActivitiesEnabled: ActivityAuthorizationInfo().areActivitiesEnabled,
                                 observedAt: Date.now.timeIntervalSince1970)
    }

    func remove(_ plan: DeviceReminderPlan) async {
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.identifier.hasPrefix(plan.notificationPrefix) }.map(\.identifier))
        let delivered = await center.deliveredNotifications()
        center.removeDeliveredNotifications(withIdentifiers: delivered.filter { $0.request.identifier.hasPrefix(plan.notificationPrefix) }.map { $0.request.identifier })
    }

    func replace(_ plan: DeviceReminderPlan, now: Date = .now) async throws -> NotificationReceipt {
        try plan.validate()
        if plan.enabled {
            let settings = await center.notificationSettings()
            guard settings.authorizationStatus == .authorized else { throw CompanionError.notificationsDenied }
        }
        // Deterministic replacement cancels stale dates and cleared reminders.
        await remove(plan)
        let future = plan.enabled ? plan.reminderAt.filter { $0 > now.timeIntervalSince1970 } : []
        do {
            for at in future {
                let content = UNMutableNotificationContent()
                content.title = plan.title
                content.body = "\(plan.eventDate!.formatted(date: .abbreviated, time: .shortened)) 开始。打开 App，可在提前一小时内启动倒计时。"
                content.sound = .default
                content.userInfo = ["taskId": plan.taskId]
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(secondsFromGMT: 0)!
                var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: at))
                components.calendar = calendar
                components.timeZone = calendar.timeZone
                let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
                let request = UNNotificationRequest(identifier: plan.notificationId(at: at), content: content, trigger: trigger)
                try await center.add(request)
            }
            let actual = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(plan.notificationPrefix) }
            let expected = Set(future.map { plan.notificationId(at: $0) })
            guard Set(actual.map(\.identifier)) == expected,
                  actual.allSatisfy({ request in
                    guard let trigger = request.trigger as? UNCalendarNotificationTrigger,
                          let date = trigger.nextTriggerDate() else { return false }
                    return future.contains { abs($0 - date.timeIntervalSince1970) < 1 }
                  }) else { throw CompanionError.readbackFailed }
            return NotificationReceipt(expected: future.count, verified: actual.count, skippedPast: plan.reminderAt.count - future.count)
        } catch {
            // A failed replacement is not a successful scheduling receipt.
            await remove(plan)
            throw error
        }
    }
}
