import Foundation
import SQLite3

enum StorageFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class RecordDatabase {
    private var database: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(file: URL? = nil) throws {
        let location: URL
        if let file = file { location = file }
        else {
            location = try FileManager.default.url(for: .applicationSupportDirectory,
                in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("DreamEdge/dreamedge.sqlite")
        }
        let folder = location.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = location.path
        guard sqlite3_open_v2(filename, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(database); database = nil
            throw StorageFailure.message("无法打开手机本地数据库。")
        }
        sqlite3_busy_timeout(database, 3000)
        let setup = """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS records (
              tool_id TEXT NOT NULL, collection TEXT NOT NULL,
              id TEXT NOT NULL, value TEXT NOT NULL,
              PRIMARY KEY(tool_id, collection, id));
            """
        guard sqlite3_exec(database, setup, nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(database); database = nil
            throw StorageFailure.message("无法初始化手机本地数据库。")
        }
    }

    deinit { sqlite3_close(database) }

    func execute(toolId: String, operation: String, collection: String, id: String?, json: String?) throws -> [[String: String]] {
        // The current framework prototype exposes only its own application namespace.
        guard toolId == "hello-world" else { throw StorageFailure.message("工具未安装。") }
        try validateIdentifier(collection)
        if operation != "list" { try validateIdentifier(id ?? "") }
        var sql: String
        var values = [toolId, collection]
        switch operation {
        case "list":
            sql = "SELECT id, value FROM records WHERE tool_id=? AND collection=? ORDER BY id"
        case "put":
            guard let json = json, let data = json.data(using: .utf8), data.count <= 65536,
                  (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) != nil else {
                throw StorageFailure.message("记录必须是有效 JSON，且不超过 64 KB。")
            }
            sql = "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(tool_id,collection,id) DO UPDATE SET value=excluded.value"
            values += [id!, json]
        case "remove":
            sql = "DELETE FROM records WHERE tool_id=? AND collection=? AND id=?"
            values.append(id!)
        default:
            throw StorageFailure.message("不支持的存储操作。")
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            throw StorageFailure.message("无法准备本地存储操作。")
        }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            let status = value.withCString { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, transient) }
            guard status == SQLITE_OK else { throw StorageFailure.message("无法绑定存储参数。") }
        }
        var rows = [[String: String]]()
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW {
            guard let key = sqlite3_column_text(statement, 0), let value = sqlite3_column_text(statement, 1) else {
                throw StorageFailure.message("已有记录格式无法识别，数据已保留。")
            }
            rows.append(["id": String(cString: key), "json": String(cString: value)])
            status = sqlite3_step(statement)
        }
        guard status == SQLITE_DONE else { throw StorageFailure.message("本地存储操作失败，请重试。") }
        return rows
    }

    private func validateIdentifier(_ value: String) throws {
        guard value.range(of: "^[a-zA-Z0-9_-]{1,80}$", options: .regularExpression) != nil else {
            throw StorageFailure.message("无效的存储标识。")
        }
    }
}
