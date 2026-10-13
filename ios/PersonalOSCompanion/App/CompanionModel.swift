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
    @Published var status = "导入配置、允许通知后，点安排提醒。自动后台上岛尚未接入。"
    @Published var busy = false
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

    func startActivity(_ plan: DeviceReminderPlan) async {
        do {
            try plan.validate()
            guard plan.canStart() else { throw CompanionError.outsideWindow }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw CompanionError.activitiesDisabled }
            if Activity<CountdownAttributes>.activities.contains(where: { $0.attributes.taskId == plan.taskId && $0.activityState == .active }) {
                status = "这条任务的倒计时已启动。"; return
            }
            let state = CountdownAttributes.ContentState(startEpoch: plan.liveActivityStartAt!, eventEpoch: plan.eventAt!)
            let activity = try Activity<CountdownAttributes>.request(
                attributes: CountdownAttributes(taskId: plan.taskId, title: plan.title),
                content: ActivityContent(state: state, staleDate: plan.eventDate), pushType: nil)
            status = "系统已接受倒计时（\(activity.activityState)）；请锁屏并查看灵动岛，界面显示需真机确认。"
        } catch { status = error.localizedDescription }
    }

    func endActivity(taskId: String) async {
        for activity in Activity<CountdownAttributes>.activities where activity.attributes.taskId == taskId {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func closeActivity(_ plan: DeviceReminderPlan) async {
        await endActivity(taskId: plan.taskId)
        status = "已结束本机倒计时，任务和定时提醒保持原配置。"
    }

    func remove(_ plan: DeviceReminderPlan) async {
        await scheduler.remove(plan)
        await endActivity(taskId: plan.taskId)
        projections.removeAll { $0.plan.taskId == plan.taskId }
        do { try save(); status = "已移除本机提醒与倒计时。" } catch { status = error.localizedDescription }
    }

    func foreground() async {
        // No background timer and no automatic restart after user dismissal.
        for activity in Activity<CountdownAttributes>.activities where activity.content.state.eventDate <= .now {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func demo() {
        let now = floor(Date.now.timeIntervalSince1970)
        preview = ReminderSnapshot(version: 1, source: "personal-os", generatedAt: now, plans: [
            DeviceReminderPlan(taskId: "synthetic-device-demo", title: "模拟通知 · 不是真实任务", timezone: "Asia/Shanghai", enabled: true,
                               eventAt: now + 120, liveActivityStartAt: now + 120 - 3600, reminderAt: [now + 30])
        ])
        status = "模拟配置：30 秒后通知、两分钟后开始。点安排提醒后，可立即启动倒计时。"
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // Opening an alert never silently starts a Live Activity.
        await MainActor.run { self.status = "提醒已打开。请核对任务，在提前一小时内点启动倒计时。" }
    }
}
