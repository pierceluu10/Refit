import Foundation

final class Store {
    func lastLaunch() -> Date? { UserDefaults.standard.object(forKey: "lastLaunch") as? Date }
    func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
}
