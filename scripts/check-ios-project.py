#!/usr/bin/env python3
"""Linux structural checks; explicitly not an Xcode build or iPhone test."""
import json
from pathlib import Path
import plistlib
import subprocess
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
generator = root / "ios/generate-project.py"
project = root / "ios/PersonalOSCompanion.xcodeproj/project.pbxproj"
before = project.read_bytes()
subprocess.run(["python3", str(generator)], check=True, capture_output=True)
assert before == project.read_bytes(), "Project generation must be reproducible"
app = plistlib.loads((root / "ios/PersonalOSCompanion/App/Info.plist").read_bytes())
widget = plistlib.loads((root / "ios/PersonalOSCompanion/Widget/Info.plist").read_bytes())
assert app["NSSupportsLiveActivities"] is True
assert widget["NSExtension"]["NSExtensionPointIdentifier"] == "com.apple.widgetkit-extension"
assert "UIBackgroundModes" not in app, "No pretend background clock"
scheme = ET.parse(root / "ios/PersonalOSCompanion.xcodeproj/xcshareddata/xcschemes/PersonalOSCompanion.xcscheme")
assert scheme.findall("./TestAction/Testables/TestableReference")
fixture = json.loads((root / "test/fixtures/mobile-kpl-synthetic.json").read_text())
assert fixture["plans"][0]["eventAt"] - fixture["plans"][0]["reminderAt"][0] == 3600
assert not list((root / "ios").rglob("*.entitlements")), "Push entitlements must wait for authorization"
print("PASS: reproducible Xcode project, plist, scheme and synthetic protocol structure; Swift compilation NOT run.")
