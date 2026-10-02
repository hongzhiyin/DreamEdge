import XCTest

final class FrameworkLaunchTests: XCTestCase {
    func testFrameworkLaunchAndRestart() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["HelloWorld"].waitForExistence(timeout: 30), "框架页面必须加载")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["HelloWorld"].waitForExistence(timeout: 30), "框架重启后必须恢复页面")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "DreamEdge HelloWorld"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
