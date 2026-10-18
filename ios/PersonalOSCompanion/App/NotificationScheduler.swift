import Foundation
import ActivityKit
import UserNotifications

struct NotificationReceipt {
    let expected: Int
    let verified: Int
    let skippedPast: Int
    var message: String { "系统待发送列表已核实 \(verified)/\(expected) 条；跳过 \(skippedPast) 条已过时刻。尚未验证送达。" }
}

// Fakes never obtain the system center or ask for notification authorization.
struct ScheduledDeviceNotification: Equatable {
    let identifier: String
    let taskId: String
    let title: String
    let eventAt: Double
    let fireAt: Double?
}

@MainActor
protocol DeviceNotificationCenter: AnyObject {
    func requestPermission() async throws -> Bool
    func permissions() async -> DevicePermissions
    func pending() async -> [ScheduledDeviceNotification]
    func deliveredIdentifiers() async -> [String]
    func add(_ notification: ScheduledDeviceNotification) async throws
    func removePending(_ identifiers: [String])
    func removeDelivered(_ identifiers: [String])
}

@MainActor
final class SystemDeviceNotificationCenter: DeviceNotificationCenter {
    private let center = UNUserNotificationCenter.current()
    func requestPermission() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound, .badge])
    }
    func permissions() async -> DevicePermissions {
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
    func pending() async -> [ScheduledDeviceNotification] {
        await center.pendingNotificationRequests().map { request in
            ScheduledDeviceNotification(identifier: request.identifier, taskId: request.content.userInfo["taskId"] as? String ?? "",
                title: request.content.title, eventAt: request.content.userInfo["eventAt"] as? Double ?? 0,
                fireAt: (request.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()?.timeIntervalSince1970)
        }
    }
    func deliveredIdentifiers() async -> [String] {
        await center.deliveredNotifications().map { $0.request.identifier }
    }
    func removePending(_ identifiers: [String]) { center.removePendingNotificationRequests(withIdentifiers: identifiers) }
    func removeDelivered(_ identifiers: [String]) { center.removeDeliveredNotifications(withIdentifiers: identifiers) }
    func add(_ notification: ScheduledDeviceNotification) async throws {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = "\(Date(timeIntervalSince1970: notification.eventAt).formatted(date: .abbreviated, time: .shortened)) 开始。打开 App，可在提前一小时内启动倒计时。"
        content.sound = .default
        content.userInfo = ["taskId": notification.taskId, "eventAt": notification.eventAt]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: notification.fireAt!))
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        try await center.add(UNNotificationRequest(identifier: notification.identifier, content: content,
            trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
    }
}

@MainActor
final class NotificationScheduler {
    private let center: any DeviceNotificationCenter
    private let clock: () -> Date
    private var revisions: [String: UUID] = [:]
    private var tails: [String: Task<Void, Never>] = [:]

    init(center: any DeviceNotificationCenter, clock: @escaping () -> Date = { .now }) {
        self.center = center
        self.clock = clock
    }
    convenience init() { self.init(center: SystemDeviceNotificationCenter()) }
    func requestPermission() async throws -> Bool { try await center.requestPermission() }
    func permissionSnapshot() async -> DevicePermissions { await center.permissions() }

    // Invalidate before waiting. Per-task queues finish old add/cleanup before
    // a new generation reuses the deterministic identifiers.
    func remove(_ plan: DeviceReminderPlan) async {
        let revision = UUID()
        revisions[plan.taskId] = revision
        let previous = tails[plan.taskId]
        let operation = Task { @MainActor in
            await previous?.value
            guard self.revisions[plan.taskId] == revision else { return }
            await self.clear(plan)
        }
        tails[plan.taskId] = operation
        await operation.value
    }
    func replace(_ plan: DeviceReminderPlan, now: Date? = nil) async throws -> NotificationReceipt {
        try plan.validate()
        let revision = UUID()
        revisions[plan.taskId] = revision
        let previous = tails[plan.taskId]
        let operation = Task { @MainActor in
            await previous?.value
            try self.check(plan, revision)
            return try await self.performReplace(plan, revision: revision, now: now)
        }
        tails[plan.taskId] = Task { _ = try? await operation.value }
        return try await operation.value
    }
    private func check(_ plan: DeviceReminderPlan, _ revision: UUID) throws {
        guard revisions[plan.taskId] == revision else { throw CancellationError() }
    }
    private func clear(_ plan: DeviceReminderPlan) async {
        let pending = await center.pending()
        center.removePending(pending.filter { $0.identifier.hasPrefix(plan.notificationPrefix) }.map(\.identifier))
        let delivered = await center.deliveredIdentifiers()
        center.removeDelivered(delivered.filter { $0.hasPrefix(plan.notificationPrefix) })
    }
    private func performReplace(_ plan: DeviceReminderPlan, revision: UUID, now: Date?) async throws -> NotificationReceipt {
        if plan.enabled {
            let permissions = await center.permissions()
            try check(plan, revision)
            guard permissions.notificationAuthorization == "authorized" else { throw CompanionError.notificationsDenied }
        }
        try check(plan, revision)
        await clear(plan)
        do {
            try check(plan, revision)
            // Permission/cleanup may have crossed a reminder instant.
            let instant = (now ?? clock()).timeIntervalSince1970
            let future = plan.enabled ? plan.reminderAt.filter { $0 > instant } : []
            for at in future {
                try await center.add(ScheduledDeviceNotification(identifier: plan.notificationId(at: at),
                    taskId: plan.taskId, title: plan.title, eventAt: plan.eventAt!, fireAt: at))
                try check(plan, revision)
            }
            let actual = await center.pending().filter { $0.identifier.hasPrefix(plan.notificationPrefix) }
            try check(plan, revision)
            let expected = Set(future.map { plan.notificationId(at: $0) })
            guard Set(actual.map(\.identifier)) == expected, actual.allSatisfy({ request in
                guard let date = request.fireAt else { return false }
                return future.contains { abs($0 - date) < 1 }
            }) else { throw CompanionError.readbackFailed }
            return NotificationReceipt(expected: future.count, verified: actual.count, skippedPast: plan.reminderAt.count - future.count)
        } catch {
            await clear(plan)
            throw error
        }
    }
}
