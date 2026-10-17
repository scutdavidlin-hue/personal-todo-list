import ActivityKit
import Foundation
import SwiftUI
import UserNotifications

struct SavedProjection: Codable {
    let generatedAt: Double
    let plan: DeviceReminderPlan
}

@MainActor
final class CompanionModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var projections: [SavedProjection] = []
    @Published var preview: ReminderSnapshot?
    @Published var status = "导入配置、允许通知后，点安排提醒。iOS 26 可另外预约提前一小时倒计时。"
    @Published var busy = false
    @Published var permissionState: DevicePermissions?
    let scheduler = NotificationScheduler()
    private let fileURL: URL

    override init() {
        fileURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("device-projections.json")
        super.init()
        UNUserNotificationCenter.current().delegate = self
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                let loaded = try JSONDecoder().decode([SavedProjection].self, from: Data(contentsOf: fileURL))
                for item in loaded { try item.plan.validate() }
                projections = loaded
            }
        } catch { status = "本机配置未能恢复：\(error.localizedDescription)" }
    }

    func importFile(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 131_072 else { throw CompanionError.fileTooLarge }
            let data = try Data(contentsOf: url)
            guard data.count <= 131_072 else { throw CompanionError.fileTooLarge }
            let snapshot = try JSONDecoder().decode(ReminderSnapshot.self, from: data)
            try snapshot.validate()
            preview = snapshot
            status = "已读取 \(snapshot.plans.count) 条配置，尚未安排。核对时刻后点安排提醒。"
        } catch { preview = nil; status = error.localizedDescription }
    }

    func requestPermission() async {
        do { status = try await scheduler.requestPermission() ? "已允许通知。请安排导入的提醒。" : "未允许通知。" }
        catch { status = error.localizedDescription }
        permissionState = await scheduler.permissionSnapshot()
    }

    func installPreview() async {
        guard !busy, let snapshot = preview else { return }
        busy = true
        defer { busy = false }
        do {
            try snapshot.validate()
            for plan in snapshot.plans {
                if let old = projections.first(where: { $0.plan.taskId == plan.taskId }), old.generatedAt > snapshot.generatedAt {
                    throw CompanionError.olderSnapshot
                }
            }
            let resultingIds = Set(projections.map { $0.plan.taskId }).union(snapshot.plans.map(\.taskId))
            guard resultingIds.count <= 20 else { throw CompanionError.invalidSnapshot }
            var receipts: [String] = []
            for plan in snapshot.plans {
                // Always terminate the old countdown on a re-import, including
                // reschedule, none and completion. Starting again is explicit.
                await endActivity(taskId: plan.taskId)
                let receipt = try await scheduler.replace(plan)
                projections.removeAll { $0.plan.taskId == plan.taskId }
                projections.append(SavedProjection(generatedAt: snapshot.generatedAt, plan: plan))
                try save()
                receipts.append("\(plan.title)：\(receipt.message)")
            }
            preview = nil
            status = receipts.joined(separator: "\n")
        } catch { status = "部分配置可能已安排，请查看本机列表。\(error.localizedDescription)" }
    }

    private func save() throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(projections).write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    func startActivity(_ plan: DeviceReminderPlan, scheduled: Bool = false) async {
        do {
            try plan.validate()
            if scheduled {
                guard #available(iOS 26.0, *) else { throw CompanionError.schedulingUnavailable }
                guard plan.canSchedule() else { throw CompanionError.scheduleWindowPassed }
                let permissions = await scheduler.permissionSnapshot()
                permissionState = permissions
                guard permissions.automaticStartPermissionReady else { throw CompanionError.notificationsDenied }
                // Permissions are an await point: removal/rescheduling or the
                // start instant may have occurred while the system answered.
                guard projections.contains(where: { $0.plan == plan }) else { throw CompanionError.olderSnapshot }
                guard plan.canSchedule() else { throw CompanionError.scheduleWindowPassed }
            } else {
                guard plan.canStart() else { throw CompanionError.outsideWindow }
            }
            // An unreadable close record is not permission to resurrect a window.
            if try DeviceCloseOutbox.pending().contains(where: { $0.taskId == plan.taskId && $0.eventAt == plan.eventAt }) {
                status = "本次倒计时已手动关闭，不会恢复此窗口。"; return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw CompanionError.activitiesDisabled }
            if Activity<CountdownAttributes>.activities.contains(where: { $0.attributes.taskId == plan.taskId && $0.activityState != .ended && $0.activityState != .dismissed }) {
                status = "这条任务已有倒计时或预约，不会重复创建。"; return
            }
            let state = CountdownAttributes.ContentState(startEpoch: plan.liveActivityStartAt!, eventEpoch: plan.eventAt!)
            let attributes = CountdownAttributes(taskId: plan.taskId, title: plan.title)
            let content = ActivityContent(state: state, staleDate: plan.eventDate)
            let activity: Activity<CountdownAttributes>
            if scheduled, #available(iOS 26.0, *) {
                activity = try Activity<CountdownAttributes>.request(attributes: attributes,
                    content: content, pushType: nil, style: .standard,
                    alertConfiguration: AlertConfiguration(title: "Personal OS 倒计时",
                        body: "执行前一小时倒计时开始，可随时关闭。", sound: .default),
                    start: plan.startDate!)
            } else {
                activity = try Activity<CountdownAttributes>.request(attributes: attributes,
                    content: content, pushType: nil)
            }
            status = scheduled
                ? "系统已接受 \(plan.startDate!.formatted()) 的倒计时预约（\(activity.activityState)）；尚未验证实际出现。原本机通知仍保留。"
                : "系统已接受倒计时（\(activity.activityState)）；请锁屏并查看灵动岛，界面显示需真机确认。"
        } catch { status = error.localizedDescription }
    }

    func endActivity(taskId: String) async {
        for activity in Activity<CountdownAttributes>.activities where activity.attributes.taskId == taskId {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func closeActivity(_ plan: DeviceReminderPlan) async {
        if let eventAt = plan.eventAt {
            do { try DeviceCloseOutbox.record(taskId: plan.taskId, eventAt: eventAt) }
            catch { status = "本机关闭记录未保存：\(error.localizedDescription)"; await endActivity(taskId: plan.taskId); return }
        }
        await endActivity(taskId: plan.taskId)
        status = "已结束本机倒计时或预约，并保存本次关闭记录。原提醒设置不变。"
    }

    func remove(_ plan: DeviceReminderPlan) async {
        await scheduler.remove(plan)
        await endActivity(taskId: plan.taskId)
        projections.removeAll { $0.plan.taskId == plan.taskId }
        do { try save(); status = "已移除本机提醒与倒计时。" } catch { status = error.localizedDescription }
    }

    func foreground() async {
        permissionState = await scheduler.permissionSnapshot()
        // No background timer and no automatic restart after user dismissal.
        for activity in Activity<CountdownAttributes>.activities where activity.content.state.eventDate <= .now {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        // Suppress any reappearing matching window locally. Server suppression
        // additionally requires the future authenticated close acknowledgement.
        if let closed = try? DeviceCloseOutbox.pending() {
            for activity in Activity<CountdownAttributes>.activities where closed.contains(where: {
                $0.taskId == activity.attributes.taskId && $0.eventAt == activity.content.state.eventEpoch
            }) { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    func demo(scheduled: Bool = false) {
        let now = floor(Date.now.timeIntervalSince1970)
        let eventAt = scheduled ? now + 3630 : now + 120
        preview = ReminderSnapshot(version: 1, source: "personal-os", generatedAt: now, plans: [
            DeviceReminderPlan(taskId: scheduled ? "synthetic-scheduled-demo" : "synthetic-device-demo", title: "模拟通知 · 不是真实任务", timezone: "Asia/Shanghai", enabled: true,
                               eventAt: eventAt, liveActivityStartAt: eventAt - 3600, reminderAt: [now + 30])
        ])
        status = scheduled
            ? "模拟配置：30 秒后为提前一小时窗口。先点安排提醒，再点预约提前一小时倒计时，随后离开 App 验收。"
            : "模拟配置：30 秒后通知、两分钟后开始。点安排提醒后，可立即启动倒计时。"
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // Opening an alert never silently starts a Live Activity.
        await MainActor.run { self.status = "提醒已打开。请核对任务，在提前一小时内点启动倒计时。" }
    }
}
