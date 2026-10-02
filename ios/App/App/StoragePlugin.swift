import Capacitor
import Foundation

@objc(IdeaDockStoragePlugin)
public final class StoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IdeaDockStoragePlugin"
    public let jsName = "IdeaDockStorage"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise)]
    private var database: RecordDatabase?
    private let queue = DispatchQueue(label: "io.github.hongzhiyin.ideadock.storage")

    @objc func execute(_ call: CAPPluginCall) {
        guard let toolId = call.getString("toolId"), let operation = call.getString("operation"),
              let collection = call.getString("collection") else {
            call.reject("无效的存储请求。")
            return
        }
        queue.async {
            do {
                if self.database == nil { self.database = try RecordDatabase() }
                let records = try self.database!.execute(toolId: toolId, operation: operation,
                    collection: collection, id: call.getString("id"), json: call.getString("json"))
                call.resolve(["records": records])
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
