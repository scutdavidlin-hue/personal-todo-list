import ActivityKit
import Foundation
import SwiftUI
import UserNotifications

struct SavedProjection: Codable {
    let generatedAt: Double
    let plan: DeviceReminderPlan
}

struct DeviceCountdown {
    let id: String
    let taskId: String
    let eventAt: Double
    let active: Bool
}

@MainActor
protocol DeviceCountdownStore: AnyObject {
    var enabled: Bool { get }
    var supportsScheduling: Bool { get }
    var activities: [DeviceCountdown] { get }
    func start(_ plan: DeviceReminderPlan, scheduled: Bool) throws -> String
    func end(id: String) async
}

@MainActor
final class SystemDeviceCountdownStore: DeviceCountdownStore {
    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var supportsScheduling: Bool { if #available(iOS 26.0, *) { return true }; return false }
    var activities: [DeviceCountdown] {
        Activity<CountdownAttributes>.activities.map {
            DeviceCountdown(id: $0.id, taskId: $0.attributes.taskId, eventAt: $0.content.state.eventEpoch,
                active: $0.activityState != .ended && $0.activityState != .dismissed)
        }
    }
    func start(_ plan: DeviceReminderPlan, scheduled: Bool) throws -> String {
        let state = CountdownAttributes.ContentState(startEpoch: plan.liveActivityStartAt!, eventEpoch: plan.eventAt!)
        let attributes = CountdownAttributes(taskId: plan.taskId, title: plan.title)
        let content = ActivityContent(state: state, staleDate: plan.eventDate)
        let activity: Activity<CountdownAttributes>
        if scheduled {
            guard #available(iOS 26.0, *) else { throw CompanionError.schedulingUnavailable }
            activity = try Activity<CountdownAttributes>.request(attributes: attributes,
                content: content, pushType: nil, style: .standard,
                alertConfiguration: AlertConfiguration(title: "Personal OS 倒计时",
                    body: "执行前一小时倒计时开始，可随时关闭。", sound: .default), start: plan.startDate!)
        } else {
            activity = try Activity<CountdownAttributes>.request(attributes: attributes, content: content, pushType: nil)
        }
        return String(describing: activity.activityState)
    }
    func end(id: String) async {
        if let activity = Activity<CountdownAttributes>.activities.first(where: { $0.id == id }) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

@MainActor
protocol DeviceProjectionStore: AnyObject {
    func load() throws -> [SavedProjection]
    func save(_ projections: [SavedProjection]) throws
}

@MainActor
final class FileDeviceProjectionStore: DeviceProjectionStore {
    private let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("device-projections.json")
    func load() throws -> [SavedProjection] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([SavedProjection].self, from: Data(contentsOf: url))
    }
    func save(_ projections: [SavedProjection]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(projections).write(to: url, options: [.atomic, .completeFileProtection])
    }
}

@MainActor
protocol DeviceClosedWindowStore: AnyObject {
    func pending() throws -> [ClosedDeviceWindow]
    func record(taskId: String, eventAt: Double, now: Date) throws
}

@MainActor
final class FileDeviceClosedWindowStore: DeviceClosedWindowStore {
    func pending() throws -> [ClosedDeviceWindow] { try DeviceCloseOutbox.pending() }
    func record(taskId: String, eventAt: Double, now: Date) throws { try DeviceCloseOutbox.record(taskId: taskId, eventAt: eventAt, now: now) }
}

@MainActor
final class CompanionModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var projections: [SavedProjection] = []
    @Published var preview: ReminderSnapshot?
    @Published var status = "导入配置、允许通知后，点安排提醒。iOS 26 可另外预约提前一小时倒计时。"
    @Published var busy = false
    @Published var permissionState: DevicePermissions?
    let scheduler: NotificationScheduler
    private let countdowns: any DeviceCountdownStore
    private let storage: any DeviceProjectionStore
    private let closedWindows: any DeviceClosedWindowStore
    private let clock: () -> Date
    private var revisions: [String: UUID] = [:]
    private var changing: Set<String> = []

    override convenience init() {
        self.init(scheduler: NotificationScheduler(), countdowns: SystemDeviceCountdownStore(),
                  storage: FileDeviceProjectionStore(), closedWindows: FileDeviceClosedWindowStore())
        UNUserNotificationCenter.current().delegate = self
    }

    // This initializer has no system-center, ActivityKit or file-store default.
    init(scheduler: NotificationScheduler, countdowns: any DeviceCountdownStore,
         storage: any DeviceProjectionStore, closedWindows: any DeviceClosedWindowStore,
         clock: @escaping () -> Date = { .now }) {
        self.scheduler = scheduler
        self.countdowns = countdowns
        self.storage = storage
        self.closedWindows = closedWindows
        self.clock = clock
        super.init()
        do {
            let loaded = try storage.load()
            for item in loaded { try item.plan.validate() }
            projections = loaded
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
            try snapshot.validate(now: clock())
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
        var tickets: [String: UUID] = [:]
        defer {
            for (id, ticket) in tickets where revisions[id] == ticket { changing.remove(id) }
            busy = false
        }
        do {
            try snapshot.validate(now: clock())
            for plan in snapshot.plans {
                if let old = projections.first(where: { $0.plan.taskId == plan.taskId }), old.generatedAt > snapshot.generatedAt {
                    throw CompanionError.olderSnapshot
                }
            }
            let resultingIds = Set(projections.map { $0.plan.taskId }).union(snapshot.plans.map(\.taskId))
            guard resultingIds.count <= 20 else { throw CompanionError.invalidSnapshot }
            for plan in snapshot.plans {
                let ticket = UUID()
                revisions[plan.taskId] = ticket
                tickets[plan.taskId] = ticket
                changing.insert(plan.taskId)
            }
            var receipts: [String] = []
            for plan in snapshot.plans {
                let ticket = tickets[plan.taskId]!
                try check(plan.taskId, ticket)
                // Always terminate the old countdown on a re-import, including
                // reschedule, none and completion. Starting again is explicit.
                await endActivity(taskId: plan.taskId)
                try check(plan.taskId, ticket)
                let receipt = try await scheduler.replace(plan)
                try check(plan.taskId, ticket)
                projections.removeAll { $0.plan.taskId == plan.taskId }
                projections.append(SavedProjection(generatedAt: snapshot.generatedAt, plan: plan))
                do { try save() }
                catch {
                    projections.removeAll { $0.plan.taskId == plan.taskId }
                    await scheduler.remove(plan)
                    throw error
                }
                receipts.append("\(plan.title)：\(receipt.message)")
            }
            if preview?.generatedAt == snapshot.generatedAt && preview?.plans == snapshot.plans { preview = nil }
            status = receipts.joined(separator: "\n")
        } catch { status = "部分配置可能已安排，请查看本机列表。\(error.localizedDescription)" }
    }

    private func save() throws {
        try storage.save(projections)
    }

    private func check(_ id: String, _ ticket: UUID) throws {
        guard revisions[id] == ticket else { throw CancellationError() }
    }

    private func checkStart(_ plan: DeviceReminderPlan, revision: UUID?) throws {
        guard revisions[plan.taskId] == revision, !changing.contains(plan.taskId),
              projections.contains(where: { $0.plan == plan }) else { throw CompanionError.olderSnapshot }
    }

    func startActivity(_ plan: DeviceReminderPlan, scheduled: Bool = false) async {
        do {
            try plan.validate()
            let revision = revisions[plan.taskId]
            try checkStart(plan, revision: revision)
            if scheduled {
                guard countdowns.supportsScheduling else { throw CompanionError.schedulingUnavailable }
                guard plan.canSchedule(at: clock()) else { throw CompanionError.scheduleWindowPassed }
                let permissions = await scheduler.permissionSnapshot()
                permissionState = permissions
                // Removal, identical reimport, dismissal or time may change here.
                try checkStart(plan, revision: revision)
                guard permissions.automaticStartPermissionReady else { throw CompanionError.notificationsDenied }
                guard plan.canSchedule(at: clock()) else { throw CompanionError.scheduleWindowPassed }
            } else {
                guard plan.canStart(at: clock()) else { throw CompanionError.outsideWindow }
            }
            if try closedWindows.pending().contains(where: { $0.taskId == plan.taskId && $0.eventAt == plan.eventAt }) {
                status = "本次倒计时已手动关闭，不会恢复此窗口。"; return
            }
            guard countdowns.enabled else { throw CompanionError.activitiesDisabled }
            if countdowns.activities.contains(where: { $0.taskId == plan.taskId && $0.active }) {
                status = "这条任务已有倒计时或预约，不会重复创建。"; return
            }
            let state = try countdowns.start(plan, scheduled: scheduled)
            status = scheduled
                ? "系统已接受 \(plan.startDate!.formatted()) 的倒计时预约（\(state)）；尚未验证实际出现。原本机通知仍保留。"
                : "系统已接受倒计时（\(state)）；请锁屏并查看灵动岛，界面显示需真机确认。"
        } catch { status = error.localizedDescription }
    }

    func endActivity(taskId: String) async {
        // Capture IDs once. An awaited end must never terminate a later activity.
        for activity in countdowns.activities where activity.taskId == taskId {
            await countdowns.end(id: activity.id)
        }
    }

    func closeActivity(_ plan: DeviceReminderPlan) async {
        if let eventAt = plan.eventAt {
            do { try closedWindows.record(taskId: plan.taskId, eventAt: eventAt, now: clock()) }
            catch { status = "本机关闭记录未保存：\(error.localizedDescription)"; await endActivity(taskId: plan.taskId); return }
        }
        await endActivity(taskId: plan.taskId)
        status = "已结束本机倒计时或预约，并保存本次关闭记录。原提醒设置不变。"
    }

    func remove(_ plan: DeviceReminderPlan) async {
        let revision = UUID()
        revisions[plan.taskId] = revision
        changing.insert(plan.taskId)
        // Invalidate the projection before any await, including a pending import.
        projections.removeAll { $0.plan.taskId == plan.taskId }
        var persistenceError: Error?
        do { try save() } catch { persistenceError = error }
        await scheduler.remove(plan)
        guard revisions[plan.taskId] == revision else { return }
        await endActivity(taskId: plan.taskId)
        if revisions[plan.taskId] == revision {
            changing.remove(plan.taskId)
            status = persistenceError.map { "本机移除记录未保存：\($0.localizedDescription)" } ?? "已移除本机提醒与倒计时。"
        }
    }

    func foreground() async {
        permissionState = await scheduler.permissionSnapshot()
        var closed: [ClosedDeviceWindow] = []
        do { closed = try closedWindows.pending() }
        catch {
            // Expiry cleanup remains independent of ledger readability.
            // startActivity still fails closed when this ledger is unreadable.
            status = "本机关闭记录无法读取：\(error.localizedDescription)"
        }
        for activity in countdowns.activities where activity.eventAt <= clock().timeIntervalSince1970 || closed.contains(where: {
            $0.taskId == activity.taskId && $0.eventAt == activity.eventAt
        }) { await countdowns.end(id: activity.id) }
        // No background timer and no automatic restart on foreground entry.
    }

    func demo(scheduled: Bool = false) {
        let now = floor(clock().timeIntervalSince1970)
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
