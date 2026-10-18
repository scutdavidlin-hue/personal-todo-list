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

    func testSchedulingHandsOffAtTheExactOneHourBoundary() throws {
        let p = plan()
        try p.validate()
        XCTAssertTrue(p.canSchedule(at: now))
        XCTAssertTrue(p.canSchedule(at: now.addingTimeInterval(3599)))
        XCTAssertFalse(p.canSchedule(at: now.addingTimeInterval(3600)))
        XCTAssertTrue(p.canStart(at: now.addingTimeInterval(3600)))
        XCTAssertFalse(p.canSchedule(at: now.addingTimeInterval(7200)))
        // Scheduling is a projection of these same instants, never a date edit.
        XCTAssertEqual(p.eventAt, now.timeIntervalSince1970 + 7200)
        XCTAssertEqual(p.liveActivityStartAt, p.reminderAt.first)
    }

    func testDisabledAndAlreadyStartedWindowsCannotBeScheduled() throws {
        let disabled = DeviceReminderPlan(taskId: "synthetic-none", title: "无提醒", timezone: "Asia/Shanghai", enabled: false,
                                         eventAt: nil, liveActivityStartAt: nil, reminderAt: [])
        try disabled.validate()
        XCTAssertFalse(disabled.canSchedule(at: now))
        XCTAssertFalse(plan().canSchedule(at: now.addingTimeInterval(3601)))
        XCTAssertFalse(plan().canSchedule(at: now.addingTimeInterval(7201)))
    }

    @MainActor
    func testBothDemosStaySyntheticAndUseTheExistingWindowContract() async throws {
        let h = SyntheticLifecycle()
        let model = h.model
        for scheduled in [false, true] {
            let before = h.clock.now
            model.demo(scheduled: scheduled)
            let snapshot = try XCTUnwrap(model.preview)
            try snapshot.validate(now: h.clock.now)
            let p = try XCTUnwrap(snapshot.plans.first)
            XCTAssertTrue(p.taskId.hasPrefix("synthetic-"))
            XCTAssertTrue(p.title.contains("不是真实任务"))
            XCTAssertEqual(p.eventAt! - p.liveActivityStartAt!, 3600)
            XCTAssertEqual(p.canSchedule(at: h.clock.now), scheduled)
            XCTAssertEqual(p.canStart(at: h.clock.now), !scheduled)
            if scheduled {
                XCTAssertEqual(p.reminderAt, [p.liveActivityStartAt!])
                XCTAssertTrue((29...31).contains(p.liveActivityStartAt! - before.timeIntervalSince1970))
            }
        }
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

// All lifecycle tests below use in-memory ports and a fixed clock. No system
// center, authorization prompt, ActivityKit request, app-support file or network.
@MainActor
private final class SyntheticGate {
    private var used = false
    private var released = false
    private let entered = XCTestExpectation(description: "synthetic dependency reached its await gate")
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    func pauseOnce() async {
        guard !used else { return }
        used = true
        entered.fulfill()
        guard !released else { return }
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }
    }
    func waitUntilPaused() async {
        let result = await XCTWaiter.fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(result, .completed, "The production method never reached the expected await")
        if result != .completed { release() }
    }
    func release() { released = true; releaseContinuation?.resume(); releaseContinuation = nil }
}

@MainActor
private final class SyntheticSignal {
    private var signalled = false
    private var observers: [CheckedContinuation<Void, Never>] = []
    func signal() { signalled = true; observers.forEach { $0.resume() }; observers.removeAll() }
    func wait() async { if !signalled { await withCheckedContinuation { observers.append($0) } } }
}

private enum SyntheticFailure: Error { case injected }

@MainActor
private final class SyntheticClock {
    var now = Date(timeIntervalSince1970: 1_792_000_000)
}

@MainActor
private final class SyntheticNotificationCenter: DeviceNotificationCenter {
    var rows: [ScheduledDeviceNotification] = []
    var delivered: [String] = []
    var permissionGate: SyntheticGate?
    var addGate: SyntheticGate?
    var readbackGate: SyntheticGate?
    var failAddAt: Int?
    var corruptReadbackAt: Int?
    var pendingCalls = 0
    var addCalls = 0
    var authorizationRequests = 0
    var permission = DevicePermissions(notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true,
        liveActivitiesEnabled: true, observedAt: 1_792_000_000)
    func requestPermission() async throws -> Bool { authorizationRequests += 1; return true }
    func permissions() async -> DevicePermissions { await permissionGate?.pauseOnce(); return permission }
    func pending() async -> [ScheduledDeviceNotification] {
        pendingCalls += 1
        if pendingCalls == 2 { await readbackGate?.pauseOnce() }
        if pendingCalls == corruptReadbackAt {
            return rows.map { ScheduledDeviceNotification(identifier: $0.identifier, taskId: $0.taskId,
                title: $0.title, eventAt: $0.eventAt, fireAt: ($0.fireAt ?? 0) + 10) }
        }
        return rows
    }
    func deliveredIdentifiers() async -> [String] { delivered }
    func add(_ notification: ScheduledDeviceNotification) async throws {
        addCalls += 1
        await addGate?.pauseOnce()
        // Simulate a late accepted add even if the caller was superseded.
        rows.removeAll { $0.identifier == notification.identifier }
        rows.append(notification)
        if addCalls == failAddAt { throw SyntheticFailure.injected }
    }
    func removePending(_ identifiers: [String]) { rows.removeAll { identifiers.contains($0.identifier) } }
    func removeDelivered(_ identifiers: [String]) { delivered.removeAll { identifiers.contains($0) } }
}

@MainActor
private final class SyntheticCountdownStore: DeviceCountdownStore {
    var enabled = true
    var supportsScheduling = true
    var activities: [DeviceCountdown] = []
    var starts: [(DeviceReminderPlan, Bool)] = []
    var ended: [String] = []
    var endGate: SyntheticGate?
    func start(_ plan: DeviceReminderPlan, scheduled: Bool) throws -> String {
        starts.append((plan, scheduled))
        activities.append(DeviceCountdown(id: UUID().uuidString, taskId: plan.taskId, eventAt: plan.eventAt!, active: true))
        return "synthetic-accepted"
    }
    func end(id: String) async {
        await endGate?.pauseOnce()
        ended.append(id)
        activities.removeAll { $0.id == id }
    }
}

@MainActor
private final class SyntheticProjectionStore: DeviceProjectionStore {
    var rows: [SavedProjection] = []
    var failSave = false
    func load() throws -> [SavedProjection] { rows }
    func save(_ projections: [SavedProjection]) throws {
        if failSave { throw SyntheticFailure.injected }
        rows = projections
    }
}

@MainActor
private final class SyntheticClosedWindowStore: DeviceClosedWindowStore {
    var rows: [ClosedDeviceWindow] = []
    var failRead = false
    func pending() throws -> [ClosedDeviceWindow] { if failRead { throw SyntheticFailure.injected }; return rows }
    func record(taskId: String, eventAt: Double, now: Date) throws {
        rows.removeAll { $0.taskId == taskId && $0.eventAt == eventAt }
        rows.append(ClosedDeviceWindow(taskId: taskId, eventAt: eventAt, closedAt: now.timeIntervalSince1970))
    }
}

@MainActor
private final class SyntheticLifecycle {
    let clock = SyntheticClock()
    let center = SyntheticNotificationCenter()
    let activities = SyntheticCountdownStore()
    let storage = SyntheticProjectionStore()
    let closed = SyntheticClosedWindowStore()
    lazy var scheduler = NotificationScheduler(center: center, clock: { [clock] in clock.now })
    lazy var model = reopen()
    func reopen() -> CompanionModel {
        CompanionModel(scheduler: scheduler, countdowns: activities, storage: storage, closedWindows: closed, clock: { [clock] in clock.now })
    }
    func plan(_ id: String = "synthetic-lifecycle", offset: Double = 7200, reminders: [Double]? = nil) -> DeviceReminderPlan {
        let event = clock.now.timeIntervalSince1970 + offset
        return DeviceReminderPlan(taskId: id, title: "Synthetic lifecycle", timezone: "Asia/Shanghai", enabled: true,
            eventAt: event, liveActivityStartAt: event - 3600, reminderAt: reminders ?? [event - 3600])
    }
    func notification(_ p: DeviceReminderPlan) -> ScheduledDeviceNotification {
        ScheduledDeviceNotification(identifier: p.notificationId(at: p.reminderAt[0]), taskId: p.taskId,
            title: p.title, eventAt: p.eventAt!, fireAt: p.reminderAt[0])
    }
    func snapshot(_ plans: [DeviceReminderPlan], stamp: Double? = nil) -> ReminderSnapshot {
        ReminderSnapshot(version: 1, source: "personal-os", generatedAt: stamp ?? clock.now.timeIntervalSince1970, plans: plans)
    }
    func seed(_ p: DeviceReminderPlan) {
        storage.rows = [SavedProjection(generatedAt: clock.now.timeIntervalSince1970 - 1, plan: p)]
        center.rows = [notification(p)]
        center.delivered = [p.notificationId(at: p.reminderAt[0])]
        activities.activities = [DeviceCountdown(id: "synthetic-old", taskId: p.taskId, eventAt: p.eventAt!, active: true)]
    }
}

extension ReminderSnapshotTests {
    func testHostedXCTestDisablesNormalSystemLifecycle() {
        XCTAssertEqual(ProcessInfo.processInfo.environment["PERSONAL_OS_SYNTHETIC_XCTEST"], "1")
    }

    @MainActor
    func testImportRescheduleReplacesOnlyOwnedNotificationsAndEndsOldActivity() async throws {
        let h = SyntheticLifecycle(), old = SyntheticLifecycle()
        let p = h.plan(), other = old.plan("synthetic-other")
        h.seed(p)
        h.center.rows.append(h.notification(other))
        h.center.delivered.append(other.notificationId(at: other.reminderAt[0]))
        let moved = h.plan(offset: 10800)
        h.model.preview = h.snapshot([moved])
        await h.model.installPreview()
        XCTAssertEqual(h.model.projections.map(\.plan), [moved])
        XCTAssertEqual(h.storage.rows.map(\.plan), [moved])
        XCTAssertEqual(Set(h.center.rows.map(\.identifier)), Set([h.notification(moved).identifier, h.notification(other).identifier]))
        XCTAssertEqual(h.center.delivered, [h.notification(other).identifier])
        XCTAssertEqual(h.activities.ended, ["synthetic-old"])
        XCTAssertTrue(h.activities.starts.isEmpty)
        XCTAssertEqual(h.center.authorizationRequests, 0)
    }

    @MainActor
    func testDisabledImportRemovesAlertsAndCountdownWithoutRestart() async {
        let h = SyntheticLifecycle(), p = SyntheticLifecycle().plan()
        h.seed(p)
        let disabled = DeviceReminderPlan(taskId: p.taskId, title: p.title, timezone: p.timezone, enabled: false,
            eventAt: nil, liveActivityStartAt: nil, reminderAt: [])
        h.model.preview = h.snapshot([disabled])
        await h.model.installPreview()
        XCTAssertEqual(h.model.projections.map(\.plan), [disabled])
        XCTAssertTrue(h.center.rows.isEmpty)
        XCTAssertTrue(h.center.delivered.isEmpty)
        XCTAssertTrue(h.activities.activities.isEmpty)
        await h.model.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
    }

    @MainActor
    func testRemovalDuringImportPermissionAwaitCannotRestoreProjection() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.model.preview = h.snapshot([p])
        h.center.permissionGate = gate
        let installing = Task { await h.model.installPreview() }
        await gate.waitUntilPaused()
        let began = SyntheticSignal()
        let removing = Task { began.signal(); await h.model.remove(p) }
        await began.wait()
        gate.release()
        await installing.value
        await removing.value
        XCTAssertTrue(h.model.projections.isEmpty)
        XCTAssertTrue(h.storage.rows.isEmpty)
        XCTAssertTrue(h.center.rows.isEmpty)
        XCTAssertEqual(h.center.addCalls, 0)
    }

    @MainActor
    func testUninstalledManualWindowCannotStart() async {
        let h = SyntheticLifecycle(), p = SyntheticLifecycle().plan(offset: 120)
        await h.model.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
    }

    @MainActor
    func testRemovalDuringScheduledPermissionAwaitPreventsStart() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.seed(p)
        h.activities.activities = []
        h.center.permissionGate = gate
        let starting = Task { await h.model.startActivity(p, scheduled: true) }
        await gate.waitUntilPaused()
        await h.model.remove(p)
        gate.release()
        await starting.value
        XCTAssertTrue(h.activities.starts.isEmpty)
        XCTAssertTrue(h.model.projections.isEmpty)
    }

    @MainActor
    func testRescheduleDuringScheduledPermissionAwaitPreventsOldStart() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.seed(p)
        h.activities.activities = []
        h.center.permissionGate = gate
        let starting = Task { await h.model.startActivity(p, scheduled: true) }
        await gate.waitUntilPaused()
        let moved = h.plan(offset: 10800)
        h.model.preview = h.snapshot([moved])
        await h.model.installPreview()
        gate.release()
        await starting.value
        XCTAssertTrue(h.activities.starts.isEmpty)
        XCTAssertEqual(h.model.projections.map(\.plan), [moved])
    }

    @MainActor
    func testIdenticalReimportDuringPermissionAwaitInvalidatesOldStart() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.seed(p)
        h.activities.activities = []
        h.center.permissionGate = gate
        let starting = Task { await h.model.startActivity(p, scheduled: true) }
        await gate.waitUntilPaused()
        h.model.preview = h.snapshot([p])
        await h.model.installPreview()
        gate.release()
        await starting.value
        XCTAssertTrue(h.activities.starts.isEmpty)
    }

    @MainActor
    func testPermissionAwaitCrossingStartInstantRejectsAppointment() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.seed(p)
        h.activities.activities = []
        h.center.permissionGate = gate
        let starting = Task { await h.model.startActivity(p, scheduled: true) }
        await gate.waitUntilPaused()
        h.clock.now = p.startDate!
        gate.release()
        await starting.value
        XCTAssertTrue(h.activities.starts.isEmpty)
    }

    @MainActor
    func testCloseDuringPermissionAwaitAndForegroundNeverRevivesWindow() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.seed(p)
        h.activities.activities = []
        h.center.permissionGate = gate
        let starting = Task { await h.model.startActivity(p, scheduled: true) }
        await gate.waitUntilPaused()
        await h.model.closeActivity(p)
        gate.release()
        await starting.value
        let reopened = h.reopen()
        h.activities.activities = [DeviceCountdown(id: "synthetic-reappeared", taskId: p.taskId, eventAt: p.eventAt!, active: true)]
        await reopened.foreground()
        await reopened.startActivity(p, scheduled: true)
        h.clock.now = p.startDate!
        await reopened.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
        XCTAssertTrue(h.activities.activities.isEmpty)
        XCTAssertEqual(h.closed.rows.map(\.eventAt), [p.eventAt!])
        XCTAssertFalse(h.center.rows.isEmpty) // Closing countdown preserves alerts.
    }

    @MainActor
    func testUnreadableCloseLedgerBlocksStart() async {
        let h = SyntheticLifecycle(), p = SyntheticLifecycle().plan(offset: 120)
        h.seed(p)
        h.activities.activities = []
        h.closed.failRead = true
        await h.model.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
    }

    @MainActor
    func testAddFailureAfterAcceptanceCleansAllPartialOwnedNotifications() async {
        let h = SyntheticLifecycle()
        let p = h.plan(reminders: [h.clock.now.timeIntervalSince1970 + 60, h.clock.now.timeIntervalSince1970 + 120])
        let other = h.plan("synthetic-other")
        h.center.rows = [h.notification(other)]
        h.center.failAddAt = 2
        do { _ = try await h.scheduler.replace(p); XCTFail("Must fail") } catch { }
        XCTAssertEqual(h.center.addCalls, 2)
        XCTAssertEqual(h.center.rows, [h.notification(other)])
    }

    @MainActor
    func testReadbackWrongTriggerCleansAcceptedNotifications() async {
        let h = SyntheticLifecycle(), p = SyntheticLifecycle().plan()
        h.center.corruptReadbackAt = 2
        do { _ = try await h.scheduler.replace(p); XCTFail("Must reject wrong trigger") }
        catch CompanionError.readbackFailed { }
        catch { XCTFail("Wrong error: \(error)") }
        XCTAssertTrue(h.center.rows.isEmpty)
    }

    @MainActor
    func testRemovalDuringLateAddCleansBeforeCompleting() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.center.addGate = gate
        let replacing = Task { try await h.scheduler.replace(p) }
        await gate.waitUntilPaused()
        let began = SyntheticSignal()
        let removing = Task { began.signal(); await h.scheduler.remove(p) }
        await began.wait()
        gate.release()
        do { _ = try await replacing.value; XCTFail("Superseded add must not succeed") }
        catch is CancellationError { } catch { XCTFail("Wrong error: \(error)") }
        await removing.value
        XCTAssertTrue(h.center.rows.isEmpty)
    }

    @MainActor
    func testNewReplacementWaitsForOldCleanupAndSurvivesIt() async throws {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan(), moved = h.plan(offset: 10800)
        h.center.addGate = gate
        let first = Task { try await h.scheduler.replace(p) }
        await gate.waitUntilPaused()
        let began = SyntheticSignal()
        let second = Task { began.signal(); return try await h.scheduler.replace(moved) }
        await began.wait()
        gate.release()
        do { _ = try await first.value; XCTFail("Old request must not succeed") }
        catch is CancellationError { } catch { XCTFail("Wrong error: \(error)") }
        let receipt = try await second.value
        XCTAssertEqual(receipt.verified, 1)
        XCTAssertEqual(h.center.rows, [h.notification(moved)])
    }

    @MainActor
    func testRemovalDuringReadbackCannotReturnSuccessfulReceipt() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.center.readbackGate = gate
        let replacing = Task { try await h.scheduler.replace(p) }
        await gate.waitUntilPaused()
        let began = SyntheticSignal()
        let removing = Task { began.signal(); await h.scheduler.remove(p) }
        await began.wait()
        gate.release()
        do { _ = try await replacing.value; XCTFail("Readback was superseded") }
        catch is CancellationError { } catch { XCTFail("Wrong error: \(error)") }
        await removing.value
        XCTAssertTrue(h.center.rows.isEmpty)
    }

    @MainActor
    func testPermissionWaitUsesFreshClockBeforeAddingReminder() async throws {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan()
        h.center.permissionGate = gate
        let replacing = Task { try await h.scheduler.replace(p) }
        await gate.waitUntilPaused()
        h.clock.now = p.startDate!
        gate.release()
        let receipt = try await replacing.value
        XCTAssertEqual(receipt.expected, 0)
        XCTAssertEqual(receipt.skippedPast, 1)
        XCTAssertEqual(h.center.addCalls, 0)
    }

    @MainActor
    func testPersistenceFailureCleansScheduledNotificationsWithoutSuccess() async {
        let h = SyntheticLifecycle(), p = SyntheticLifecycle().plan()
        h.model.preview = h.snapshot([p])
        h.storage.failSave = true
        await h.model.installPreview()
        XCTAssertTrue(h.model.projections.isEmpty)
        XCTAssertTrue(h.center.rows.isEmpty)
        XCTAssertNotNil(h.model.preview)
    }

    @MainActor
    func testInstalledEligibleWindowsReachOnlyFakeActivityRequestsAndDeduplicate() async {
        for scheduled in [false, true] {
            let h = SyntheticLifecycle()
            let p = h.plan(offset: scheduled ? 7200 : 120)
            h.seed(p)
            h.activities.activities = []
            await h.model.startActivity(p, scheduled: scheduled)
            await h.model.startActivity(p, scheduled: scheduled)
            XCTAssertEqual(h.activities.starts.count, 1)
            XCTAssertEqual(h.activities.starts.first?.0, p)
            XCTAssertEqual(h.activities.starts.first?.1, scheduled)
            XCTAssertEqual(h.center.authorizationRequests, 0)
        }
    }

    @MainActor
    func testClosedWindowStaysClosedAfterReimportButDifferentWindowCanStart() async {
        let h = SyntheticLifecycle()
        let p = h.plan(offset: 120)
        h.seed(p)
        await h.model.closeActivity(p)
        h.model.preview = h.snapshot([p])
        await h.model.installPreview()
        await h.model.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
        let moved = h.plan(offset: 240)
        h.model.preview = h.snapshot([moved])
        await h.model.installPreview()
        await h.model.startActivity(moved)
        XCTAssertEqual(h.activities.starts.count, 1)
        XCTAssertEqual(h.activities.starts.first?.0, moved)
        XCTAssertEqual(h.closed.rows.map(\.eventAt), [p.eventAt!])
    }

    @MainActor
    func testReimportEndAwaitBlocksManualStartAndRemovalPreventsRescheduling() async {
        let h = SyntheticLifecycle(), gate = SyntheticGate()
        let p = h.plan(offset: 120)
        h.seed(p)
        h.activities.endGate = gate
        h.model.preview = h.snapshot([p])
        let installing = Task { await h.model.installPreview() }
        await gate.waitUntilPaused()
        // Same exact installed plan, currently in its valid manual window.
        await h.model.startActivity(p)
        XCTAssertTrue(h.activities.starts.isEmpty)
        let began = SyntheticSignal()
        let removing = Task { began.signal(); await h.model.remove(p) }
        await began.wait()
        gate.release()
        await installing.value
        await removing.value
        XCTAssertTrue(h.model.projections.isEmpty)
        XCTAssertTrue(h.storage.rows.isEmpty)
        XCTAssertTrue(h.center.rows.isEmpty)
        XCTAssertEqual(h.center.addCalls, 0)
    }
}
