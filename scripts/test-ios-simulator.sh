#!/bin/bash
set -euo pipefail

mkdir -p artifacts
simulator_id=$(xcrun simctl list devices available -j | node -e '
let text=""; process.stdin.on("data",data=>text+=data); process.stdin.on("end",()=>{
  const lists=Object.entries(JSON.parse(text).devices).filter(([runtime])=>runtime.includes("iOS"));
  const device=lists.reverse().flatMap(([,devices])=>devices).find(device=>device.name.startsWith("iPhone") && device.isAvailable);
  if(!device) throw new Error("No available iPhone simulator runtime");
  process.stdout.write(device.udid);
});')

xcrun simctl boot "$simulator_id" || true
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl status_bar "$simulator_id" override --time '9:41' --batteryState charged --batteryLevel 100
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath artifacts/ios-build -resultBundlePath artifacts/ios-tests.xcresult \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test
container=$(xcrun simctl get_app_container "$simulator_id" io.github.hongzhiyin.dreamedge data)
database="$container/Library/Application Support/DreamEdge/dreamedge.sqlite"
test -f "$database"
record=$(sqlite3 "$database" "SELECT json_extract(value, '\$.content') FROM records WHERE tool_id='reading-log' AND collection='entries' LIMIT 1;")
test "$record" = 'iPhone persistence verification'
echo 'PASS: the iPhone UI wrote and recovered the record through native SQLite.'
xcrun xcresulttool export attachments --path artifacts/ios-tests.xcresult --output-path artifacts/ios-screenshots
ditto -c -k --sequesterRsrc --keepParent artifacts/ios-build/Build/Products/Debug-iphonesimulator/App.app artifacts/DreamEdge-iOS-simulator.zip
