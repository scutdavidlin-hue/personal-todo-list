# PR #7: unsigned build and test readiness

Initial read-only check: 2026-10-13 against head `a79840b0a1938440d8bde8cb015a5a527f346f4d`.
Actual unsigned CI candidate: `2df2d4b8c85e3219e65998c3d025d1048cade650`.
The user's Mac has only Command Line Tools, according to the delegated Mac check;
that report is not an Xcode build. This cloud workspace is Linux and has no Apple
SDK, `xcodebuild` or `simctl`.

## Read-only evidence and costs

- GitHub repository metadata confirms `visibility: public`, repository ID
  `1277577732`, existing connected account write access, and PR #7 remains Draft.
- The PR head has zero pull-request workflow runs. The latest ten of 33 repository
  runs all show the generated `dynamic/pages/pages-build-deployment` path.
  Latest [Pages run](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/36950500165)
  has build, deploy and report-build-status jobs. This does not compile iOS.
- No checked-in workflow, Bitrise/Codemagic configuration or other macOS build
  integration was found in the PR tree. Workflow enumeration through the GitHub
  connector is unsupported; direct API network access is restricted. Therefore
  the evidence does not establish an existing registered/self-hosted Mac runner
  or any external service balance. No account credentials were enumerated.
- [GitHub standard runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  lists `macos-15` as a standard runner and states standard runners are free and
  unlimited for public repositories. This is the applicable free route; it does
  not depend on guessing remaining private-repository minutes.
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  says larger runners are charged even on public repositories, private quota
  overage can be billed, and artifact/cache storage can incur charges. The
  prepared job uses one public-only standard `macos-15` runner, 20-minute limit,
  no artifact uploads or caches, and no third-party service.
- GitHub's [macOS 15 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)
  provides full Xcode/SDK inventory. The script records the actual selected
  version/SDKs and fails if the installed simulator runtime is unavailable. It
  never silently downloads a runtime or substitutes Linux structure validation.
- The shell's existing `gh` token is invalid. No new token was created. An active
  workflow can run only if the existing GitHub connection is permitted to write
  the workflow/ref; repository `admin:true` metadata alone does not prove that
  the installation token has GitHub's separate workflow-write permission.

After reporting the public/free runner evidence, the existing connection did
successfully write the guarded workflow and update the PR branch. No credentials
or account were added. [Actual run 38374114519](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/38374114519)
completed successfully at 09:15:11 UTC. Raw job metadata confirms label
`macos-15` in the `GitHub Actions` runner group; the downloaded job log identifies
`macos-15-arm64`, macOS 15.7.9 and Xcode 16.4 (16F6).

## Prepared execution

`.github/workflows/personalos-ios-unsigned.yml` triggers only for changes under
`ios/` or that workflow on the isolated PR #7 branch. Its public-repository
condition is evaluated before runner allocation. It clones the exact commit
anonymously, runs the checked-in script, and publishes only the outcome summary
and normal job logs. It does not use a signing identity, persistent credential,
device registration, simulator/runtime purchase, App Store API or production
deploy operation.

`bash ios/run-unsigned-checks.sh` performs:

1. Full-Xcode and iPhoneOS/iPhoneSimulator SDK preflight; records versions.
2. Selects an existing available iOS 17+ iPhone simulator.
3. `xcodebuild ... -sdk iphoneos -destination generic/platform=iOS build` with
   `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, empty signing identity
   and team. This checks real device-target Swift/Apple framework compilation,
   but the unsigned app cannot be installed on a phone.
4. Simulator `build-for-testing`, then `test-without-building` for the shared
   scheme's five XCTest methods. Failures propagate through `pipefail`.
5. Writes separate device-build, simulator-build and Swift-test outcomes to
   `receipt.json`. Signing, physical installation, notification delivery and
   observed island fields remain false even if all native checks pass.

The script uses only existing runtimes. No automatic native compile run can be
reported as passed before actual runner logs and the phase receipt are read.

## Minimum Mac installation steps

1. Install **full Xcode** compatible with the Mac's macOS from Apple's Mac App
   Store or official developer download; Command Line Tools alone are
   insufficient. See [Apple's Xcode requirements](https://developer.apple.com/xcode/system-requirements).
2. Open Xcode once, complete Apple's license/first-launch component prompts and
   install the iOS platform plus an iPhone simulator runtime in **Xcode Settings
   → Components**. These are local installation/license actions for the user;
   this cloud task does not perform them.
3. In Xcode Settings → Locations, select this full Xcode's Command Line Tools.
   For a temporary shell selection without a system-wide change:

   ```sh
   export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
   xcodebuild -version
   xcrun --sdk iphoneos --show-sdk-version
   xcrun --sdk iphonesimulator --show-sdk-version
   xcrun simctl list devices available
   bash ios/run-unsigned-checks.sh
   ```

4. Complete the unsigned build/XCTest milestone first. Signing and installing
   on the actual iPhone still require the user's explicit approval, selection
   of an existing Apple team and device, and later notification/Live Activity
   permission plus device observation. No paid Developer Program membership is
   required just to compile or run these simulator tests.

## Result

The actual job log and phase receipt were read back, rather than relying solely
on the Actions green badge:

| Native phase | Verified result | Limit |
| --- | --- | --- |
| iPhoneOS build | `BUILD SUCCEEDED`, SDK 18.5 | Unsigned; no physical installation |
| iPhoneSimulator build-for-testing | `TEST BUILD SUCCEEDED`, SDK 18.5 | Compilation includes app, widget and XCTest target |
| Swift XCTest | Five methods executed, zero failures | Simulator iPhone SE (3rd generation), runtime iOS 26.2; logic tests only |
| Phone delivery / island rendering | Not performed | No iPhone, signing, push or UI observation |

The simulator model has no Dynamic Island. The XCTest methods check snapshot
decoding, UTC instants, one-hour boundaries, terminal data and stable ID isolation;
they do not assert UNUserNotificationCenter delivery, permission prompts or widget
display. Framework compilation and these logic tests are now verified; the
mobile feature is still not a signed, installed or accepted release.

Structured evidence is saved in `docs/ios-unsigned-ci-evidence.json`. The full log
is available in the linked Actions job; no artifact was uploaded. Warnings only
concern not stripping Apple's already signed simulator XCTest libraries. The app
build used `CODE_SIGNING_ALLOWED=NO` and no team/identity; no developer credential
was created or used.

Shell syntax, YAML public/free guard, Linux/CLT-only refusal probes, and the
existing Node regression (525 tests: 523 passed, two existing skips, zero failures)
also passed. These checks are recorded separately from native XCTest.

PR #7 remains Draft. There was no production deployment, Task edit, authentication
change, signing, TestFlight upload, App Store release or paid service creation.
The user's Mac still needs full Xcode/iOS components before local signing and
installation can be pursued with explicit approval.
