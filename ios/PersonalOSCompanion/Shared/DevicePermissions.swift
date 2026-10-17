import Foundation

struct DevicePermissions: Codable, Equatable {
    let notificationAuthorization: String
    let alertsEnabled: Bool
    let soundEnabled: Bool
    let liveActivitiesEnabled: Bool
    let observedAt: Double

    var automaticStartPermissionReady: Bool {
        notificationAuthorization == "authorized" && alertsEnabled && liveActivitiesEnabled
    }
    var displayText: String {
        let labels = ["notDetermined": "尚未允许", "denied": "已拒绝", "authorized": "已允许", "provisional": "静默许可", "ephemeral": "临时许可"]
        return "通知：\(labels[notificationAuthorization] ?? "未知") · 横幅：\(alertsEnabled ? "开启" : "关闭") · 声音：\(soundEnabled ? "开启" : "关闭") · 实时活动：\(liveActivitiesEnabled ? "开启" : "关闭")"
    }
}
