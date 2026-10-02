import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import xcode from 'xcode';

const filename = 'ios/App/App.xcodeproj/project.pbxproj';
const project = xcode.project(filename);
project.parseSync();
const app = project.getFirstTarget();
const groups = project.hash.project.objects.PBXGroup;
const appGroup = Object.entries(groups).find(([, value]) => value.path === 'App')[0];
for (const source of ['RecordDatabase.swift', 'StoragePlugin.swift', 'AppBridgeViewController.swift']) {
  if (!project.hasFile(source)) project.addSourceFile(source, { target: app.uuid }, appGroup);
}
if (!project.hasFile('PrivacyInfo.xcprivacy')) {
  const resource = project.addFile('PrivacyInfo.xcprivacy', appGroup);
  Object.assign(resource, { uuid: project.generateUuid(), target: app.uuid, group: 'Resources' });
  project.addToPbxBuildFileSection(resource);
  project.addToPbxResourcesBuildPhase(resource);
}
let tests = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value.name?.replaceAll('"', '') === 'AppUITests');
if (!tests) {
  const original = [...app.firstTarget.dependencies];
  const target = project.addTarget('AppUITests', 'unit_test_bundle', 'AppUITests', 'io.github.hongzhiyin.dreamedge.uitests');
  // xcode's helper supports unit bundles; set Apple's UI testing product type explicitly.
  target.pbxNativeTarget.productType = '"com.apple.product-type.bundle.ui-testing"';
  app.firstTarget.dependencies = original;
  project.addTargetDependency(target.uuid, [app.uuid]);
  project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  const group = project.addPbxGroup([], 'AppUITests', 'AppUITests');
  const root = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, root);
  project.addSourceFile('FrameworkLaunchTests.swift', { target: target.uuid }, group.uuid);
  const ref = project.pbxFileReferenceSection()[target.pbxNativeTarget.productReference];
  ref.path = '"AppUITests.xctest"';
  tests = [target.uuid, target.pbxNativeTarget];
}
project.hash.project.objects.PBXTargetDependency ??= {};
project.hash.project.objects.PBXContainerItemProxy ??= {};
if (tests[1].dependencies.length === 0) project.addTargetDependency(tests[0], [app.uuid]);
const attributes = project.getFirstProject().firstProject.attributes;
attributes.TargetAttributes ??= {};
attributes.TargetAttributes[tests[0]] = { CreatedOnToolsVersion: '26.0', TestTargetID: app.uuid };
const testProduct = project.pbxFileReferenceSection()[tests[1].productReference];
testProduct.path = '"AppUITests.xctest"';
testProduct.name = '"AppUITests.xctest"';
for (const file of Object.values(project.pbxFileReferenceSection())) {
  if (typeof file !== 'object') continue;
  for (const key of ['fileEncoding', 'explicitFileType', 'lastKnownFileType']) {
    if (file[key] === undefined || file[key] === 'undefined') delete file[key];
  }
  if (file.path?.includes('PrivacyInfo.xcprivacy')) file.lastKnownFileType = 'text.xml';
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
for (const [key, config] of Object.entries(project.pbxXCBuildConfigurationSection())) {
  if (key.endsWith('_comment')) continue;
  const settings = config.buildSettings;
  settings.IPHONEOS_DEPLOYMENT_TARGET = '16.0';
  if (settings.PRODUCT_BUNDLE_IDENTIFIER?.includes('dreamedge')) {
    settings.MARKETING_VERSION = version;
    settings.CURRENT_PROJECT_VERSION = '1';
  }
  if (settings.PRODUCT_BUNDLE_IDENTIFIER?.includes('uitests')) {
    delete settings.INFOPLIST_FILE;
    Object.assign(settings, { GENERATE_INFOPLIST_FILE: 'YES', TEST_TARGET_NAME: 'App', SWIFT_VERSION: '5.0', TARGETED_DEVICE_FAMILY: '"1,2"', CODE_SIGN_STYLE: 'Automatic' });
  }
}
writeFileSync(filename, project.writeSync());
const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
  <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${app.uuid}" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" /></BuildActionEntry>
 </BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>
  <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${tests[0]}" BuildableName="AppUITests.xctest" BlueprintName="AppUITests" ReferencedContainer="container:App.xcodeproj" /></TestableReference>
 </Testables></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${app.uuid}" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:App.xcodeproj" /></BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES" />
 <AnalyzeAction buildConfiguration="Debug" />
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES" />
</Scheme>`;
mkdirSync('ios/App/App.xcodeproj/xcshareddata/xcschemes', { recursive: true });
writeFileSync('ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', scheme);
console.log('Configured native storage, iOS 16 target and simulator UI tests.');
