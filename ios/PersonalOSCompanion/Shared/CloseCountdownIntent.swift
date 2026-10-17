import ActivityKit
import AppIntents

struct CloseCountdownIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "关闭倒计时"
    static var openAppWhenRun = false
    @Parameter(title: "任务 ID") var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        // Ending the projection has no effect on Task completion or reminders.
        for activity in Activity<CountdownAttributes>.activities where activity.attributes.taskId == taskId {
            // Closing must still work if protected storage is unavailable while
            // locked. A failed local record cannot establish server suppression.
            try? DeviceCloseOutbox.record(taskId: taskId, eventAt: activity.content.state.eventEpoch)
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        return .result()
    }
}
