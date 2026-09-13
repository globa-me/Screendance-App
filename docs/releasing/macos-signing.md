# macOS distribution

## Setup and handoff — 2026-09-08

Target: macOS 14+ with separate Apple Silicon (`arm64`) and Intel (`x64`) builds.
Signing identity: `Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)`.
The certificate and private key are available in the local Keychain.
`electron-builder.json5` now requires signing and signs the DMG as well as the app.
Hardened runtime and the existing entitlements remain enabled.

## Ready artifacts — 2026-09-11

Version 1.1.0 is signed, notarized and stapled for both architectures. The
current local distribution candidates are:

- `release/notarized-dual/Screendance App-arm64.dmg` — Apple Silicon;
- `release/notarized-dual/Screendance App-x64.dmg` — Intel.

The ZIP files in that directory contain the corresponding stapled apps.
`SHA256SUMS.txt`, blockmaps and `latest-mac.yml` reflect the final bytes.
Nothing has been published externally.

Keychain profile: `Screendance-notary`. Both app and DMG have Apple status
`Accepted` and pass Gatekeeper with `source=Notarized Developer ID`.
Old files under the other `release/` directories are historical or intermediate
artifacts; use `release/notarized-dual/` for this dual-architecture build.

The working tree already contained extensive development changes before this
signing task. The build includes them; they have not been committed or published.
No export/transcoding implementation was changed by the signing task.

## Store notarization credentials locally

Create an app-specific password at https://account.apple.com/ and run this in
Terminal. Enter the password only at the secure prompt, never in chat or Git:

```sh
xcrun notarytool store-credentials Screendance-notary \
  --apple-id global_corp@mail.ru --team-id BN3D9H4C7J
xcrun notarytool history --keychain-profile Screendance-notary
```

## Build and verify a distribution candidate

```sh
export APPLE_KEYCHAIN_PROFILE=Screendance-notary
xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
npm run build:mac -- --config.directories.output=release/notarized-dual
```

Require `notarization successful` in the build log. electron-builder can silently
skip notarization when credentials are missing; a successful build alone is not
proof of notarization. Its notarization integration staples the app before
creating the ZIP/DMG. Then notarize and staple the signed DMG:

```sh
for arch in arm64 x64; do
  xcrun notarytool submit "release/notarized-dual/Screendance App-${arch}.dmg" \
    --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple "release/notarized-dual/Screendance App-${arch}.dmg"
  xcrun stapler validate "release/notarized-dual/Screendance App-${arch}.dmg"
done
```

Mount the final DMG, verify the contained app, and test launching a downloaded,
quarantined copy on a supported Mac. Screen recording, microphone, camera and
Accessibility permissions remain normal macOS requirements after notarization.
Do not remove quarantine attributes as a distribution test.

Finalize only after stapling both the app and DMG:

```sh
node scripts/finalize-macos-release.mjs release/notarized-dual
```

This fails closed if code signatures, stapled tickets or Gatekeeper assessments
fail. It regenerates the DMG blockmap, SHA-512 update metadata and SHA256SUMS.
The existing updater URLs use electron-builder's GitHub-safe names (spaces
replaced with hyphens); preserve those names when publishing release assets.
No public release is authorized by this local signing task.

## Signed staging build (not notarized)

```sh
npm run build:mac -- --config.directories.output=release/signed-staging --config.mac.notarize=false
```

This is useful for diagnosing signing separately from notarization. Never ship
this directory as a Gatekeeper-approved release.

## Validation on 2026-09-08

- TypeScript compilation and `npx tsc --noEmit`: passed.
- Full Vitest suite: 75 files, 660 tests passed.
- Required export regression suite: 3 files, 89 tests passed.
- Vite build and Electron main CommonJS smoke: passed.
- Developer ID signatures of app and DMG: valid; app deep/strict verification passed.
- DMG integrity (`hdiutil verify`): passed.
- Packaged binary smoke: passed with explicit arm64 target and staging root.
- Gatekeeper assessment: rejected, `source=Unnotarized Developer ID` (expected until notarized).
- Notarization and Gatekeeper acceptance: pending credentials.

The host Node process reports x64 (Rosetta), so smoke checks must explicitly
target the packaged arm64 architecture. The smoke helper now supports a selected
root to avoid checking historical artifacts:

```sh
PACKAGED_SMOKE_ROOT=release/signed-staging PACKAGED_SMOKE_ARCH_TAGS=darwin-arm64 npm run smoke:packaged-binaries
```

## Completed notarization run — 2026-09-09

- Profile: `Screendance-notary` (credentials stay in Keychain).
- App submission: `b7874e37-2e08-44c1-bb29-ddbc624c9402` — Accepted.
- DMG submission: `bf6315cc-f2f0-492a-a6d2-71242ef49f3d` — Accepted.
- Reused the September 8 tested signed app; did not recompile source.
- Stapled candidate app, packaged with electron-builder `--prepackaged`, then
  notarized and stapled final DMG.
- All 34 embedded Mach-O signatures passed strict verification.
- App and DMG: stapler validation, code signatures and Gatekeeper assessments passed.
- Mounted DMG app: deep/strict signature, stapled ticket and Gatekeeper passed.
- Copied app with quarantine attribute: Gatekeeper accepted; quarantine was not removed.
- GUI launch could not be independently confirmed: an older app in Applications
  was already running and the single-instance lock forwarded launch to it.
  The existing user session was left running. A first launch on a separate clean
  Mac has not been tested; normal recording/privacy permissions still apply.
- Final DMG integrity: `hdiutil verify` passed after stapling.
- Finalizer rejection before DMG stapling and success after stapling both verified.
- Submission logs: `.tmp/screendance-app-notary-log.json` and
  `.tmp/screendance-dmg-notary-log.json`.

## Dual-architecture validation — 2026-09-11

- Both app bundles were built from the current working tree with
  `LSMinimumSystemVersion=14.0` and separate arm64/x86_64 Electron executables.
- Swift ScreenCaptureKit/window/cursor helpers were rebuilt for both architectures.
- The missing Intel Whisper runtime was built with portable CPU settings; both
  arm64 and x64 `whisper-cli --help` executions passed.
- FFmpeg is packaged as a universal binary. Architecture-correct FFprobe binaries
  are now staged for both targets instead of being excluded from the app.
- The packaged arm64 and x64 Electron runtimes launched in run-as-Node mode and
  loaded their matching `uiohook-napi` native modules. The x64 run executed under
  Rosetta on the Apple Silicon build host.
- Both DMGs were mounted and the contained executable architecture, deep code
  signature and stapled app ticket were verified.
- App and DMG signatures, stapler validation, Gatekeeper assessment, DMG integrity,
  packaged-binary smoke and final checksums passed for both architectures.
- Apple notarization submissions: arm64 DMG
  `59577e78-b091-433b-b4a7-95a477831a82`; x64 DMG
  `c3d8a35a-2210-4cb2-9de5-03b11331d805`. Both were `Accepted`.
- A physical Intel Mac was not available locally. The x64 executable and every
  critical x64 native component were run through Rosetta, but recording permissions,
  camera/microphone capture and end-to-end export should still receive a final
  hardware smoke test on Intel macOS 14 or 15 before public release.
