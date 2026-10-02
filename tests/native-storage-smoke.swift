import Foundation

@main struct NativeStorageSmoke {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("test.sqlite")
        var database: RecordDatabase? = try RecordDatabase(file: file)
        let json = "{\"content\":\"手机阅读记录\",\"minutes\":30}"
        _ = try database!.execute(toolId: "reading-log", operation: "put", collection: "entries", id: "entry-1", json: json)
        database = nil
        database = try RecordDatabase(file: file)
        let rows = try database!.execute(toolId: "reading-log", operation: "list", collection: "entries", id: nil, json: nil)
        precondition(rows == [["id": "entry-1", "json": json]], "关闭再打开数据库应保留 JSON 记录")
        for request in [("unknown", "list", "entries"), ("reading-log", "list", "../data"), ("reading-log", "exec", "entries")] {
            do {
                _ = try database!.execute(toolId: request.0, operation: request.1, collection: request.2, id: "entry-1", json: nil)
                fatalError("无效请求应被拒绝")
            } catch {}
        }
        _ = try database!.execute(toolId: "reading-log", operation: "remove", collection: "entries", id: "entry-1", json: nil)
        database = nil
        database = try RecordDatabase(file: file)
        let remaining = try database!.execute(toolId: "reading-log", operation: "list", collection: "entries", id: nil, json: nil)
        precondition(remaining.isEmpty)
        database = nil
        print("PASS: native SQLite persistence, JSON, request validation and durable deletion.")
    }
}
