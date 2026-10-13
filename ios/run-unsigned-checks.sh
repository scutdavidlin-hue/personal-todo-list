#!/bin/bash
# Compile device + simulator targets and execute XCTest. Never sign or install
# on a physical device; never download SDKs/runtimes or configure accounts.
set -euo pipefail

personal_os_root="$(cd "$(dirname "$0")/.." && pwd)"
personal_os_output="${1:-$(mktemp -d "${TMPDIR:-/tmp}/personal-os-ios-checks.XXXXXX")}"
mkdir -p "$personal_os_output"
personal_os_output="$(cd "$personal_os_output" && pwd)"
personal_os_phase=preflight
personal_os_device_build=not_run
personal_os_simulator_build=not_run
personal_os_tests=not_run
personal_os_simulator_id=""
personal_os_sha="$(git -C "$personal_os_root" rev-parse HEAD)"

write_receipt() {
  personal_os_exit=$?
  trap - EXIT
  python3 - "$personal_os_output/receipt.json" "$personal_os_exit" "$personal_os_phase" \
    "$personal_os_device_build" "$personal_os_simulator_build" "$personal_os_tests" \
    "$personal_os_sha" "${DEVELOPER_DIR:-}" "$personal_os_simulator_id" <<'PY'
import json, sys
path, code, phase, device, simulator, tests, sha, developer, destination = sys.argv[1:]
receipt = dict(commit=sha, overall="passed" if code == "0" else "blocked_or_failed",
               exit_code=int(code), last_phase=phase, iphoneos_build=device,
               iphonesimulator_build=simulator, swift_xctest=tests,
               signing=False, physical_device_install=False,
               phone_notification_delivery=False, dynamic_island_observed=False,
               developer_dir=developer, simulator_id=destination)
for field in ('iphoneos_build', 'iphonesimulator_build', 'swift_xctest'):
    if receipt[field] == 'running': receipt[field] = 'failed_or_interrupted'
with open(path, "w") as output: json.dump(receipt, output, indent=2)
print(json.dumps(receipt, indent=2))
PY
  printf 'Local evidence directory: %s\n' "$personal_os_output"
  exit "$personal_os_exit"
}
trap write_receipt EXIT

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'BLOCKED: macOS and full Xcode are required; Linux structure checks cannot compile iOS.' >&2
  exit 2
fi
if [ -z "${DEVELOPER_DIR:-}" ]; then
  DEVELOPER_DIR="$(xcode-select -p)"
fi
export DEVELOPER_DIR
case "$DEVELOPER_DIR" in
  *.app/Contents/Developer) ;;
  *) printf '%s\n' 'BLOCKED: only Command Line Tools are selected. Install full Xcode and select its Developer directory.' >&2; exit 2 ;;
esac
test -d "$DEVELOPER_DIR"
xcodebuild -version | tee "$personal_os_output/xcode-version.log"
xcodebuild -showsdks | tee "$personal_os_output/sdks.log"
xcrun --sdk iphoneos --show-sdk-version
xcrun --sdk iphonesimulator --show-sdk-version
xcrun simctl list devices available --json > "$personal_os_output/simulators.json"

personal_os_simulator_id="$(python3 - "$personal_os_output/simulators.json" <<'PY'
import json, re, sys
with open(sys.argv[1]) as source: devices = json.load(source)["devices"]
candidates = []
for runtime, entries in devices.items():
    match = re.search(r'\.iOS-(\d+(?:-\d+)*)$', runtime)
    if not match: continue
    version = tuple(map(int, match[1].split('-')))
    if version[0] < 17: continue
    for device in entries:
        if device.get('isAvailable') and device.get('name', '').startswith('iPhone'):
            candidates.append((version, device['name'], device['udid']))
if not candidates:
    sys.exit('BLOCKED: install an iOS 17+ iPhone simulator runtime in Xcode Settings > Components.')
print(max(candidates)[2])
PY
)"

personal_os_project="$personal_os_root/ios/PersonalOSCompanion.xcodeproj"
personal_os_options=(-project "$personal_os_project" -scheme PersonalOSCompanion -configuration Debug
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 'CODE_SIGN_IDENTITY=' 'DEVELOPMENT_TEAM=')

personal_os_phase=iphoneos_build
personal_os_device_build=running
xcodebuild "${personal_os_options[@]}" -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$personal_os_output/device-derived" build 2>&1 | tee "$personal_os_output/iphoneos-build.log"
personal_os_device_build=passed

personal_os_phase=iphonesimulator_build
personal_os_simulator_build=running
xcodebuild "${personal_os_options[@]}" -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$personal_os_simulator_id" \
  -derivedDataPath "$personal_os_output/simulator-derived" build-for-testing 2>&1 | tee "$personal_os_output/iphonesimulator-build.log"
personal_os_simulator_build=passed

personal_os_phase=swift_xctest
personal_os_tests=running
xcodebuild "${personal_os_options[@]}" -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$personal_os_simulator_id" \
  -derivedDataPath "$personal_os_output/simulator-derived" \
  -resultBundlePath "$personal_os_output/xctest.xcresult" \
  -parallel-testing-enabled NO test-without-building 2>&1 | tee "$personal_os_output/xctest.log"
python3 - "$personal_os_output/xctest.log" <<'PY'
import pathlib, re, sys
log = pathlib.Path(sys.argv[1]).read_text()
counts = re.findall(r'Executed (\d+) tests?, with 0 failures', log)
if not any(int(count) >= 5 for count in counts):
    sys.exit('UNVERIFIED: Xcode returned success but five executed XCTest methods were not confirmed in the log.')
PY
personal_os_tests=passed
personal_os_phase=completed
