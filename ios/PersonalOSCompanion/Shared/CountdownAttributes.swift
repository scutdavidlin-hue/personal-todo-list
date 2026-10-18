import ActivityKit
import Foundation

struct CountdownAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        // Unix epochs deliberately avoid JSONEncoder's Date reference epoch.
        let startEpoch: Double
        let eventEpoch: Double
        var startDate: Date { Date(timeIntervalSince1970: startEpoch) }
        var eventDate: Date { Date(timeIntervalSince1970: eventEpoch) }
    }
    let taskId: String
    let title: String
}
