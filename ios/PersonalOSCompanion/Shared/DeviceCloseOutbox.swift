import Foundation

struct ClosedDeviceWindow: Codable, Equatable {
    let taskId: String
    let eventAt: Double
    let closedAt: Double
}

// LiveActivityIntent runs in the app process. No App Group, token collection or
// upload is enabled here. A future authorized client must acknowledge this
// durable queue to the backend before following another automatic window.
enum DeviceCloseOutbox {
    static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("closed-device-windows.json")
    }
    static func pending(at url: URL = fileURL) throws -> [ClosedDeviceWindow] {
        if !FileManager.default.fileExists(atPath: url.path) { return [] }
        return try JSONDecoder().decode([ClosedDeviceWindow].self, from: Data(contentsOf: url))
    }
    static func record(taskId: String, eventAt: Double, now: Date = .now, at url: URL = fileURL) throws {
        var rows = try pending(at: url)
        rows.removeAll { $0.closedAt < now.timeIntervalSince1970 - 7 * 86400 || ($0.taskId == taskId && $0.eventAt == eventAt) }
        rows.append(ClosedDeviceWindow(taskId: taskId, eventAt: eventAt, closedAt: now.timeIntervalSince1970))
        guard rows.count <= 100 else { throw CompanionError.invalidSnapshot }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(rows).write(to: url, options: [.atomic, .completeFileProtection])
    }
}
