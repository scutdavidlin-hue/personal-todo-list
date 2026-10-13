import XCTest
@testable import PersonalOSCompanion

final class ReminderSnapshotTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_792_000_000)
    func plan(_ id: String = "synthetic-kpl") -> DeviceReminderPlan {
        DeviceReminderPlan(taskId: id, title: "模拟抢票", timezone: "Asia/Shanghai", enabled: true,
                           eventAt: now.timeIntervalSince1970 + 7200,
                           liveActivityStartAt: now.timeIntervalSince1970 + 3600,
                           reminderAt: [now.timeIntervalSince1970 + 3600])
    }
    func testWindowIsExactlyOneHourAndExclusiveAtEnd() throws {
        let p = plan()
        try p.validate()
        XCTAssertFalse(p.canStart(at: now))
        XCTAssertFalse(p.canStart(at: now.addingTimeInterval(3599)))
        XCTAssertTrue(p.canStart(at: now.addingTimeInterval(3600)))
        XCTAssertTrue(p.canStart(at: now.addingTimeInterval(7199)))
        XCTAssertFalse(p.canStart(at: now.addingTimeInterval(7200)))
    }
    func testTerminalProjectionCannotCarryOldReminder() {
        let p = DeviceReminderPlan(taskId: "a", title: "停用", timezone: "Asia/Shanghai", enabled: false,
                                   eventAt: nil, liveActivityStartAt: nil, reminderAt: [now.timeIntervalSince1970])
        XCTAssertThrowsError(try p.validate())
    }
    func testNotificationIdentityDoesNotCollideByPrefix() {
        XCTAssertFalse(plan("ab").notificationId(at: 123).hasPrefix(plan("a").notificationPrefix))
        XCTAssertEqual(plan().notificationId(at: 123), plan().notificationId(at: 123))
    }
    func testSnapshotRejectsDuplicatesOldAndFutureData() {
        let stamp = now.timeIntervalSince1970
        for snapshot in [
            ReminderSnapshot(version: 1, source: "personal-os", generatedAt: stamp, plans: [plan(), plan()]),
            ReminderSnapshot(version: 1, source: "personal-os", generatedAt: stamp - 86401, plans: [plan()]),
            ReminderSnapshot(version: 1, source: "personal-os", generatedAt: stamp + 301, plans: [plan()])
        ] { XCTAssertThrowsError(try snapshot.validate(now: now)) }
    }
    func testWebFixtureUsesUnixEpochsAndPreservesKPLWindow() throws {
        let url = Bundle(for: Self.self).url(forResource: "mobile-kpl-synthetic", withExtension: "json")!
        let snapshot = try JSONDecoder().decode(ReminderSnapshot.self, from: Data(contentsOf: url))
        try snapshot.validate(now: Date(timeIntervalSince1970: snapshot.generatedAt))
        let p = snapshot.plans[0]
        XCTAssertEqual(p.eventAt, 1_792_123_200)
        XCTAssertEqual(p.reminderAt, [1_792_119_600])
        XCTAssertEqual(p.liveActivityStartAt, p.reminderAt[0])
    }
}
