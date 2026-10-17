import Foundation

struct DeviceRegistration: Codable {
    let deviceId: String
    let bundleId: String
    let environment: String
    let iosVersion: String
    let permissions: DevicePermissions
    let automaticCountdownEnabled: Bool
    let expectedRevision: Int
    // Supplied only by a future explicitly authorized ActivityKit token adapter.
    // No native token stream is read or enabled in this candidate.
    var pushToStartToken: String? = nil
}

struct DeviceRegistrationReceipt: Decodable {
    let deviceId: String
    let revision: Int
    let registered: Bool
    let pushToStartTokenRegistered: Bool
}

protocol MobileDeviceTransport {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

enum MobileDeviceClientError: Error {
    case notConfigured, unsafeEndpoint, unauthorized, operationRejected, outcomeUnknown
}

struct MobileDeviceClient {
    // Nil by default: no production endpoint, auth, token, upload or automatic
    // account setup. Tests inject an in-memory transport with synthetic data.
    var endpoint: URL? = nil
    var transport: (any MobileDeviceTransport)? = nil

    private func request(path: String, method: String, body: Data, accessToken: String) throws -> URLRequest {
        guard let endpoint, transport != nil else { throw MobileDeviceClientError.notConfigured }
        guard endpoint.scheme == "https", endpoint.host != nil, endpoint.user == nil,
              endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil else { throw MobileDeviceClientError.unsafeEndpoint }
        guard !accessToken.isEmpty else { throw MobileDeviceClientError.unauthorized }
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        let prefix = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = prefix + "/" + path
        guard let url = components.url else { throw MobileDeviceClientError.unsafeEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    func register(_ registration: DeviceRegistration, accessToken: String) async throws -> DeviceRegistrationReceipt {
        let request = try request(path: "devices", method: "POST", body: JSONEncoder().encode(registration), accessToken: accessToken)
        let data: Data, code: Int
        do { (data, code) = try await transport!.send(request) }
        catch { throw MobileDeviceClientError.outcomeUnknown }
        guard (200...299).contains(code) else {
            if code >= 500 || code == 408 || code == 429 { throw MobileDeviceClientError.outcomeUnknown }
            throw MobileDeviceClientError.operationRejected
        }
        guard let receipt = try? JSONDecoder().decode(DeviceRegistrationReceipt.self, from: data),
              receipt.registered, receipt.deviceId == registration.deviceId,
              receipt.revision == registration.expectedRevision + 1,
              registration.pushToStartToken == nil || receipt.pushToStartTokenRegistered else { throw MobileDeviceClientError.outcomeUnknown }
        return receipt
    }

    func close(_ window: ClosedDeviceWindow, deviceId: String, accessToken: String) async throws {
        guard UUID(uuidString: deviceId) != nil else { throw MobileDeviceClientError.operationRejected }
        let taskId = window.taskId.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let body = try JSONSerialization.data(withJSONObject: ["eventAt": window.eventAt])
        let request = try request(path: "devices/\(deviceId)/tasks/\(taskId)/close", method: "POST", body: body, accessToken: accessToken)
        do {
            let (data, code) = try await transport!.send(request)
            guard (200...299).contains(code), let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  receipt["closed"] as? Bool == true, receipt["automaticRestartAllowed"] as? Bool == false,
                  receipt["deviceId"] as? String == deviceId,
                  receipt["taskId"] as? String == window.taskId, receipt["eventAt"] as? Double == window.eventAt else {
                throw MobileDeviceClientError.outcomeUnknown
            }
        } catch { throw MobileDeviceClientError.outcomeUnknown }
    }
}
