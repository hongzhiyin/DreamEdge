import XCTest

final class ReadingPersistenceTests: XCTestCase {
    func testReadingSurvivesApplicationRestart() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let content = app.webViews.textViews["阅读内容"]
        XCTAssertTrue(content.waitForExistence(timeout: 30), "阅读工具必须加载并连接原生存储")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            guard let field = object as? XCUIElement else { return false }
            return field.exists && field.isEnabled
        }, object: content)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed, app.debugDescription)
        content.tap()
        content.typeText("iPhone persistence verification")
        app.webViews.firstMatch.swipeUp()
        let save = app.buttons["保存记录"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        save.tap()
        let saved = app.staticTexts["记录已保存到本机。"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        let record = app.staticTexts["iPhone persistence verification"]
        for _ in 0..<4 {
            if record.exists { break }
            app.webViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(record.waitForExistence(timeout: 10), "重启后必须从原生 SQLite 读回记录")
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "iPhone 阅读记录重启恢复"
        image.lifetime = .keepAlways
        add(image)
    }
}
