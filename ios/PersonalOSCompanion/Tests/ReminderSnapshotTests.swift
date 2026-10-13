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

    func testPermissionReadinessRequiresVisibleNotificationAndLiveActivity() {
        for state in ["denied", "notDetermined", "provisional", "ephemeral"] {
            XCTAssertFalse(DevicePermissions(notificationAuthorization: state, alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: true, observedAt: 100).automaticStartPermissionReady)
        }
        XCTAssertFalse(DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: false, soundEnabled: true, liveActivitiesEnabled: true, observedAt: 100).automaticStartPermissionReady)
        XCTAssertFalse(DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: false, observedAt: 100).automaticStartPermissionReady)
        XCTAssertTrue(DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: true, observedAt: 100).automaticStartPermissionReady)
    }

    func testUnconfiguredDeviceClientDoesNotUpload() async {
        let registration = DeviceRegistration(deviceId: "00000000-0000-4000-8000-000000000001", bundleId: "com.example.synthetic", environment: "sandbox", iosVersion: "17.2",
            permissions: DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: true, observedAt: 100), automaticCountdownEnabled: false, expectedRevision: 0)
        do { _ = try await MobileDeviceClient().register(registration, accessToken: "synthetic-only"); XCTFail("Must stop before transport") }
        catch MobileDeviceClientError.notConfigured { }
        catch { XCTFail("Wrong failure: \(error)") }
    }

    func testDeviceRegistrationUnknownReceiptNeverRetries() async throws {
        let transport = SyntheticDeviceTransport(response: Data("{}".utf8), code: 200)
        let client = MobileDeviceClient(endpoint: URL(string: "https://synthetic.invalid/device-api"), transport: transport)
        let registration = DeviceRegistration(deviceId: "00000000-0000-4000-8000-000000000001", bundleId: "com.example.synthetic", environment: "sandbox", iosVersion: "17.2",
            permissions: DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: true, observedAt: 100), automaticCountdownEnabled: false, expectedRevision: 0)
        do { _ = try await client.register(registration, accessToken: "synthetic-only"); XCTFail("Incomplete receipt") }
        catch MobileDeviceClientError.outcomeUnknown { }
        let calls = await transport.calls
        XCTAssertEqual(calls, 1)
    }

    func testCloseOutboxPersistsExactWindowAndDeduplicates() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("synthetic-close.json")
        try DeviceCloseOutbox.record(taskId: "synthetic/a", eventAt: now.timeIntervalSince1970 + 10, now: now, at: url)
        try DeviceCloseOutbox.record(taskId: "synthetic/a", eventAt: now.timeIntervalSince1970 + 10, now: now, at: url)
        try DeviceCloseOutbox.record(taskId: "synthetic/ab", eventAt: now.timeIntervalSince1970 + 10, now: now, at: url)
        let rows = try DeviceCloseOutbox.pending(at: url)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.filter { $0.taskId == "synthetic/a" }.count, 1)
    }

    func testCloseClientEncodesTaskIdentityAndChecksOwnedReceipt() async throws {
        let id = "00000000-0000-4000-8000-000000000001"
        let window = ClosedDeviceWindow(taskId: "synthetic/a+b", eventAt: now.timeIntervalSince1970, closedAt: now.timeIntervalSince1970)
        let data = try JSONSerialization.data(withJSONObject: ["deviceId": id, "taskId": window.taskId, "eventAt": window.eventAt, "closed": true, "automaticRestartAllowed": false])
        let transport = SyntheticDeviceTransport(response: data, code: 200)
        let client = MobileDeviceClient(endpoint: URL(string: "https://synthetic.invalid/device-api"), transport: transport)
        try await client.close(window, deviceId: id, accessToken: "synthetic-only")
        let request = await transport.lastRequest
        XCTAssertEqual(URLComponents(url: request!.url!, resolvingAgainstBaseURL: false)!.percentEncodedPath,
                       "/device-api/devices/\(id)/tasks/synthetic%2Fa%2Bb/close")
    }
}

private actor SyntheticDeviceTransport: MobileDeviceTransport {
    let response: Data
    let code: Int
    private(set) var calls = 0
    private(set) var lastRequest: URLRequest?
    init(response: Data, code: Int) { self.response = response; self.code = code }
    func send(_ request: URLRequest) async throws -> (Data, Int) { calls += 1; lastRequest = request; return (response, code) }
}
