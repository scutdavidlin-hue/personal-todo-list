import Foundation

// This is a replaceable device projection, never a Task source of truth.
struct ReminderSnapshot: Codable {
    let version: Int
    let source: String
    let generatedAt: Double
    let plans: [DeviceReminderPlan]

    func validate(now: Date = .now) throws {
        guard version == 1, source == "personal-os", generatedAt.isFinite,
              generatedAt > now.timeIntervalSince1970 - 86400, generatedAt <= now.timeIntervalSince1970 + 300,
              (1...20).contains(plans.count), Set(plans.map(\.taskId)).count == plans.count else {
            throw CompanionError.invalidSnapshot
        }
        for plan in plans { try plan.validate() }
    }
}

struct DeviceReminderPlan: Codable, Identifiable, Equatable {
    var id: String { taskId }
    let taskId: String
    let title: String
    let timezone: String
    let enabled: Bool
    let eventAt: Double?
    let liveActivityStartAt: Double?
    let reminderAt: [Double]

    var eventDate: Date? { eventAt.map { Date(timeIntervalSince1970: $0) } }
    var startDate: Date? { liveActivityStartAt.map { Date(timeIntervalSince1970: $0) } }

    func validate() throws {
        guard !taskId.isEmpty, taskId.utf8.count <= 1024,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              title.utf8.count <= 1024, TimeZone(identifier: timezone) != nil else { throw CompanionError.invalidSnapshot }
        if !enabled {
            guard eventAt == nil, liveActivityStartAt == nil, reminderAt.isEmpty else { throw CompanionError.invalidSnapshot }
            return
        }
        guard let end = eventAt, let start = liveActivityStartAt,
              end.isFinite, start.isFinite, end > 0, start == end - 3600,
              (1...3).contains(reminderAt.count), Set(reminderAt).count == reminderAt.count,
              reminderAt.allSatisfy({ $0.isFinite && $0 > 0 && $0 <= end }) else { throw CompanionError.invalidSnapshot }
    }

    func canStart(at now: Date = .now) -> Bool {
        guard enabled, let startDate, let eventDate else { return false }
        return startDate <= now && now < eventDate
    }

    // iOS 26 can ask the system to start this projection later, without a
    // background timer or device token. The execution date is never changed.
    func canSchedule(at now: Date = .now) -> Bool {
        guard enabled, let startDate, let eventDate else { return false }
        return now < startDate && startDate < eventDate
    }

    // Hex encoding makes IDs stable and injective; cancelling task "a" cannot
    // accidentally cancel task "ab". No random ID on re-import/reschedule.
    var notificationPrefix: String {
        "personal-os." + taskId.utf8.map { String(format: "%02x", $0) }.joined() + "."
    }
    func notificationId(at instant: Double) -> String { notificationPrefix + String(format: "%.0f", instant) }
}

enum CompanionError: LocalizedError {
    case invalidSnapshot, olderSnapshot, notificationsDenied, readbackFailed, outsideWindow, activitiesDisabled, fileTooLarge, schedulingUnavailable, scheduleWindowPassed
    var errorDescription: String? {
        switch self {
        case .invalidSnapshot: return "提醒文件无效，请从 Personal OS 重新导出。"
        case .olderSnapshot: return "这条任务已有更新的导入记录，已拒绝旧文件。"
        case .notificationsDenied: return "通知未获授权，请在系统设置中开启。"
        case .readbackFailed: return "系统待发送列表未核实，不能确认提醒已安排。"
        case .outsideWindow: return "倒计时只能在执行时刻前一小时内启动。"
        case .activitiesDisabled: return "实时活动未开启，请在系统设置中开启。"
        case .fileTooLarge: return "提醒文件超过 128 KB，请只导出所需任务。"
        case .schedulingUnavailable: return "本机预约倒计时需要 iOS 26 或更新版本；当前可在提前一小时内手动启动。"
        case .scheduleWindowPassed: return "预约启动时刻已到或已过，请在提前一小时内手动启动。"
        }
    }
}
