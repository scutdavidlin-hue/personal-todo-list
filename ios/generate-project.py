#!/usr/bin/env python3
"""Generate the checked-in Xcode project using only Python's standard library.

No package manager, account, network request or signing credentials are used.
"""
import hashlib
import json
from pathlib import Path
import plistlib

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT / "PersonalOSCompanion.xcodeproj"
OBJECTS = {}

def ident(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()

def obj(object_key, isa, **values):
    key = ident(object_key)
    OBJECTS[key] = dict(isa=isa, **values)
    return key

def encode(value, depth=0):
    pad = "\t" * depth
    if isinstance(value, dict):
        return "{\n" + "".join(f'{pad}\t{encode(k)} = {encode(v, depth+1)};\n' for k, v in value.items()) + pad + "}"
    if isinstance(value, list):
        return "(\n" + "".join(f'{pad}\t{encode(v, depth+1)},\n' for v in value) + pad + ")"
    return json.dumps(str(value), ensure_ascii=False)

shared = ["Shared/CountdownAttributes.swift", "Shared/CloseCountdownIntent.swift"]
files = {
    "app": ["App/PersonalOSCompanionApp.swift", "App/CompanionModel.swift", "App/NotificationScheduler.swift", "Shared/ReminderSnapshot.swift"] + shared,
    "widget": ["Widget/CountdownWidget.swift"] + shared,
    "tests": ["Tests/ReminderSnapshotTests.swift"],
}
refs = {}
for path in sorted(set(sum(files.values(), []))):
    refs[path] = obj("file:"+path, "PBXFileReference", lastKnownFileType="sourcecode.swift", path="PersonalOSCompanion/"+path, sourceTree="<group>")
fixture = obj("fixture", "PBXFileReference", lastKnownFileType="text.json", path="../test/fixtures/mobile-kpl-synthetic.json", sourceTree="<group>")
products = {
    "app": obj("product:app", "PBXFileReference", explicitFileType="wrapper.application", path="PersonalOSCompanion.app", sourceTree="BUILT_PRODUCTS_DIR"),
    "widget": obj("product:widget", "PBXFileReference", explicitFileType="wrapper.app-extension", path="PersonalOSCountdown.appex", sourceTree="BUILT_PRODUCTS_DIR"),
    "tests": obj("product:tests", "PBXFileReference", explicitFileType="wrapper.cfbundle", path="PersonalOSCompanionTests.xctest", sourceTree="BUILT_PRODUCTS_DIR"),
}
product_group = obj("products", "PBXGroup", name="Products", children=list(products.values()), sourceTree="<group>")
main_group = obj("main-group", "PBXGroup", children=list(refs.values()) + [fixture, product_group], sourceTree="<group>")

common = {"IPHONEOS_DEPLOYMENT_TARGET":"17.0", "SDKROOT":"iphoneos", "SWIFT_VERSION":"5.0", "SWIFT_STRICT_CONCURRENCY":"targeted", "CLANG_ENABLE_MODULES":"YES", "TARGETED_DEVICE_FAMILY":"1", "MARKETING_VERSION":"0.1.0", "CURRENT_PROJECT_VERSION":"1"}

def configs(name, settings):
    ids = []
    for mode in ("Debug", "Release"):
        build = dict(common, **settings)
        build.update(SWIFT_OPTIMIZATION_LEVEL="-Onone" if mode == "Debug" else "-O")
        if mode == "Debug": build.update(ENABLE_TESTABILITY="YES", SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG")
        ids.append(obj(name+":"+mode, "XCBuildConfiguration", name=mode, buildSettings=build))
    return obj(name+":configs", "XCConfigurationList", buildConfigurations=ids, defaultConfigurationIsVisible="0", defaultConfigurationName="Release")

target_ids = {kind: ident("target:"+kind) for kind in files}

def dependency(owner, dest):
    proxy = obj(owner+":proxy:"+dest, "PBXContainerItemProxy", containerPortal=ident("project"), proxyType="1", remoteGlobalIDString=target_ids[dest], remoteInfo=dest)
    return obj(owner+":depends:"+dest, "PBXTargetDependency", target=target_ids[dest], targetProxy=proxy)

for kind, paths in files.items():
    sources = [obj("build:"+kind+":"+path, "PBXBuildFile", fileRef=refs[path]) for path in paths]
    source_phase = obj(kind+":sources", "PBXSourcesBuildPhase", buildActionMask="2147483647", files=sources, runOnlyForDeploymentPostprocessing="0")
    resources = [obj("build:fixture", "PBXBuildFile", fileRef=fixture)] if kind == "tests" else []
    resource_phase = obj(kind+":resources", "PBXResourcesBuildPhase", buildActionMask="2147483647", files=resources, runOnlyForDeploymentPostprocessing="0")
    framework_phase = obj(kind+":frameworks", "PBXFrameworksBuildPhase", buildActionMask="2147483647", files=[], runOnlyForDeploymentPostprocessing="0")
    phases, deps = [source_phase, framework_phase, resource_phase], []
    settings = {"CODE_SIGN_STYLE":"Automatic", "DEVELOPMENT_TEAM":"", "PRODUCT_NAME":"$(TARGET_NAME)", "GENERATE_INFOPLIST_FILE":"NO"}
    if kind == "app":
        name, product_type = "PersonalOSCompanion", "com.apple.product-type.application"
        settings.update(PRODUCT_BUNDLE_IDENTIFIER="com.example.personalos.companion", INFOPLIST_FILE="PersonalOSCompanion/App/Info.plist")
        embed = obj("embed-widget", "PBXBuildFile", fileRef=products["widget"], settings={"ATTRIBUTES":["RemoveHeadersOnCopy"]})
        phases.append(obj("embed-phase", "PBXCopyFilesBuildPhase", buildActionMask="2147483647", dstPath="", dstSubfolderSpec="13", name="Embed App Extensions", files=[embed], runOnlyForDeploymentPostprocessing="0"))
        deps.append(dependency(kind, "widget"))
    elif kind == "widget":
        name, product_type = "PersonalOSCountdown", "com.apple.product-type.app-extension"
        settings.update(PRODUCT_BUNDLE_IDENTIFIER="com.example.personalos.companion.countdown", INFOPLIST_FILE="PersonalOSCompanion/Widget/Info.plist", APPLICATION_EXTENSION_API_ONLY="YES", SKIP_INSTALL="YES")
    else:
        name, product_type = "PersonalOSCompanionTests", "com.apple.product-type.bundle.unit-test"
        settings.update(PRODUCT_BUNDLE_IDENTIFIER="com.example.personalos.companion.tests", GENERATE_INFOPLIST_FILE="YES", TEST_HOST="$(BUILT_PRODUCTS_DIR)/PersonalOSCompanion.app/PersonalOSCompanion", BUNDLE_LOADER="$(TEST_HOST)")
        deps.append(dependency(kind, "app"))
    obj("target:"+kind, "PBXNativeTarget", name=name, productName=name, productReference=products[kind], productType=product_type,
        buildConfigurationList=configs(kind, settings), buildPhases=phases, buildRules=[], dependencies=deps)

obj("project", "PBXProject", attributes={"LastUpgradeCheck":"1600"}, buildConfigurationList=configs("project", {}), compatibilityVersion="Xcode 14.0", developmentRegion="zh-Hans", hasScannedForEncodings="0", knownRegions=["en", "zh-Hans", "Base"], mainGroup=main_group, productRefGroup=product_group, projectDirPath="", projectRoot="", targets=list(target_ids.values()))
PROJECT.mkdir(exist_ok=True)
(PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n" + encode({"archiveVersion":"1", "classes":{}, "objectVersion":"56", "objects":OBJECTS, "rootObject":ident("project")}) + "\n")

base = {"CFBundleDevelopmentRegion":"$(DEVELOPMENT_LANGUAGE)", "CFBundleExecutable":"$(EXECUTABLE_NAME)", "CFBundleIdentifier":"$(PRODUCT_BUNDLE_IDENTIFIER)", "CFBundleInfoDictionaryVersion":"6.0", "CFBundleName":"$(PRODUCT_NAME)", "CFBundleShortVersionString":"$(MARKETING_VERSION)", "CFBundleVersion":"$(CURRENT_PROJECT_VERSION)"}
app_plist = dict(base, CFBundlePackageType="APPL", CFBundleDisplayName="Personal OS", NSSupportsLiveActivities=True, UILaunchScreen={}, UISupportedInterfaceOrientations=["UIInterfaceOrientationPortrait"], LSSupportsOpeningDocumentsInPlace=True, CFBundleDocumentTypes=[{"CFBundleTypeName":"Personal OS Reminder Snapshot", "LSItemContentTypes":["public.json"], "LSHandlerRank":"Alternate"}])
widget_plist = dict(base, CFBundlePackageType="XPC!", NSExtension={"NSExtensionPointIdentifier":"com.apple.widgetkit-extension"})
for folder, value in (("App", app_plist), ("Widget", widget_plist)):
    (ROOT / "PersonalOSCompanion" / folder / "Info.plist").write_bytes(plistlib.dumps(value))

scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
  <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target_ids['app']}" BuildableName="PersonalOSCompanion.app" BlueprintName="PersonalOSCompanion" ReferencedContainer="container:PersonalOSCompanion.xcodeproj"/></BuildActionEntry>
 </BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target_ids['tests']}" BuildableName="PersonalOSCompanionTests.xctest" BlueprintName="PersonalOSCompanionTests" ReferencedContainer="container:PersonalOSCompanion.xcodeproj"/></TestableReference></Testables></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target_ids['app']}" BuildableName="PersonalOSCompanion.app" BlueprintName="PersonalOSCompanion" ReferencedContainer="container:PersonalOSCompanion.xcodeproj"/></BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
 <AnalyzeAction buildConfiguration="Debug"/>
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>'''
scheme_folder = PROJECT / "xcshareddata" / "xcschemes"
scheme_folder.mkdir(parents=True, exist_ok=True)
(scheme_folder / "PersonalOSCompanion.xcscheme").write_text(scheme)
print("Generated unsigned project: app, Live Activity extension, XCTest target.")
