# macOS distribution

## G2 reissue — 2026-10-04 (build and verification in progress)

The requested reissue is **v1.5.0**, preserving macOS 14+, both `arm64` and
`x64`, DMG and ZIP, blockmaps and updater metadata. The current GitHub release
is https://github.com/globa-me/Screendance-App/releases/tag/v1.5.0 and still
contains the September 23 artifacts signed with the previous authority.
No GitHub assets or notes have been replaced during migration preparation.

The shared G2 certificate and private key are now installed and usable:
SHA-1 `6E99F92E9A1BA1273CD084FAFE940A7280DB0A30`, team `BN3D9H4C7J`, issuer
OU `G2`, serial `5299A0D81637760BD3C59CBF9835A32C`, valid from
2026-10-02 16:05:56 UTC until 2031-09-17 00:00:00 UTC.
The old certificate remains in Keychain; it was not revoked or deleted.

During the first real G2 build, electron-builder 26.7.0 selected the right
SHA-1 but its default app signer replaced it with the common name, which is
identical for both certificates. `scripts/sign-macos-g2.mjs`, configured as
`mac.sign`, preserves the selected fingerprint through the builder's signing
implementation. DMG signing already uses the fingerprint. Keep this hook
while both identities share a common name. Build logs are `.tmp/g2-build.log`
and `.tmp/g2-package.log`; final candidates are in `release/notarized-v1.5.0-g2`.
The first build completed TypeScript and production compilation; packaging
was resumed directly after fixing the signer. Five signing-policy tests and
92 export regression tests passed; Biome passed for the new signer.

Prepared release tooling:

- `npm run build:mac` / `build:mac:g2` select exactly one currently valid
  Developer ID Application from issuer OU `G2` with a usable private key for
  team `BN3D9H4C7J`. Selection is by public SHA-1, not the ambiguous name.
  `G2_SIGNING_SHA1` can pin the intended certificate when multiple G2 identities
  exist. The selected fingerprint is propagated to the signature checks.
- `build:mac:arm64` and `build:mac:x64` use the same preflight. All paths still
  build both sets of native helpers and Whisper runtimes. The underlying
  compilation/packaging command is `build:mac:package`; use the public wrapper
  for local releases so certificate availability is checked before building.
- Builder configuration explicitly requests Apple's timestamp service and
  `afterSign` checks the app's signature, team, actual leaf issuer and secure
  timestamp. A raw builder/CI invocation using the old certificate fails this
  guard. The release finalizer also checks both app and DMG before generating
  blockmaps, SHA-512 metadata and SHA256SUMS.
- No private key or signing password is stored in the project. Existing local
  cleanup notes and `test_transcode_ks.mov` were preserved.

Checks during preparation: TypeScript and the full Vitest suite passed
(76 files, 670 tests). The five signing-policy tests passed via
`node --test scripts/macos-g2-signing.test.mjs`. The real installed
`/Applications/Screendance App.app` was correctly rejected by the G2 guard
because its leaf issuer is the previous authority. Builder schema validation
and dynamic hook loading passed. Vite production build, Electron main CJS
normalization/smoke and Biome checks of the changed scripts passed.
The October 2 preflight had zero usable G2 identities. The October 4
preflight passes with the shared identity above. Publication remains pending
until all replacement artifacts have passed verification.

### Resume after the shared G2 identity is installed

Keep the previous local release intact until the replacements are verified:

```sh
npm run build:mac -- --check
APPLE_KEYCHAIN_PROFILE=Screendance-notary npm run build:mac -- \
  --config.directories.output=release/notarized-v1.5.0-g2
```

The preflight prints only public certificate metadata; record its fingerprint,
serial and expiry in this section. Require successful app notarization in the
build log. Then submit and staple both DMGs as in the build instructions below,
using the new `release/notarized-v1.5.0-g2` root, and run:

```sh
node scripts/finalize-macos-release.mjs release/notarized-v1.5.0-g2
PACKAGED_SMOKE_ROOT=release/notarized-v1.5.0-g2/mac-arm64 \
  PACKAGED_SMOKE_ARCH_TAGS=darwin-arm64 npm run smoke:packaged-binaries
PACKAGED_SMOKE_ROOT=release/notarized-v1.5.0-g2/mac \
  PACKAGED_SMOKE_ARCH_TAGS=darwin-x64 npm run smoke:packaged-binaries
```

Check both mounted DMGs, the ZIP contents, all embedded native code signatures,
Gatekeeper, secure timestamps and an actual app launch. A physical Intel Mac
remains a separate hardware check if unavailable; Rosetta is not proof of
recording behavior on Intel hardware.

Publication is authorized for this task. Replace the existing v1.5.0 assets
only after verification. Use the existing GitHub-safe filenames
`Screendance-App-{arm64,x64}.{dmg,zip}` and their blockmaps. Regenerate
`SHA256SUMS.txt` for those upload names, upload `latest-mac.yml` after the binaries
and update the existing release body while preserving
`<!-- locally-notarized-release -->`. Download the actually uploaded files,
compare checksums and repeat signature/Gatekeeper checks on downloaded apps;
record the asset digests, Apple submission IDs and completed status here and
in `docs/releases/v1.5.0.md`. Do not claim the reissue is complete before that.

### CI signing dependency

On October 2, `gh api repos/globa-me/Screendance-App/actions/secrets` returned
`total_count: 0`. The release workflow references
`APPLE_SIGNING_CERTIFICATE_P12_BASE64`, `APPLE_SIGNING_CERTIFICATE_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; it therefore
needs signing/notarization secrets configured before a CI release can work.
If CI is enabled, its P12 must contain the new G2 identity and private key,
not the old certificate with the same name. Secret values were not read,
exported or changed. A verified local upload does not require these CI secrets;
the existing local-release marker prevents release-event CI from rebuilding it.

Apple's issuer and renewal guidance:
https://developer.apple.com/help/account/certificates/replace-developer-id-certificates.

## Local artifact cleanup — 2026-09-25

The retained local release is `release/notarized-v1.5.0/`: both final DMGs,
ZIPs, blockmaps, update metadata, checksums and release notes. ZIPs are required
by the macOS auto-updater; keep them in the release set even when DMGs exist.
All retained files passed `shasum -a 256 -c SHA256SUMS.txt` during cleanup.

Removed intermediate artifacts directly under `release/`, `release/signed-v1.5.0/`,
and the unpacked `mac/` and `mac-arm64/` app bundles (including those in the final
release directory). Also removed regenerable `.tmp/ffmpeg-static/`,
`.tmp/ffprobe-packages/` and the hard-linked `.tmp/release-v1.5.0-upload/` staging
directory. Source files, native runtimes, dependencies and Git history remain.
Historical paths below describe the original validation runs, not current local
availability. For a new packaged smoke test, mount the retained DMG and point
`PACKAGED_SMOKE_ROOT` at its app, or rebuild the unpacked apps. Do not rerun the
release finalizer against this trimmed directory without restoring its app bundles.

## Setup and handoff — 2026-09-08

Target: macOS 14+ with separate Apple Silicon (`arm64`) and Intel (`x64`) builds.
Signing identity: `Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)`.
The certificate and private key are available in the local Keychain.
`electron-builder.json5` now requires signing and signs the DMG as well as the app.
Hardened runtime and the existing entitlements remain enabled.

## Release artifacts — 2026-09-16

Version 1.4.0 is signed, notarized and stapled for both architectures. The
release artifacts are built from commit `42a098b` and stored locally at:

- `release/notarized-v1.4.0/Screendance App-arm64.dmg` — Apple Silicon;
- `release/notarized-v1.4.0/Screendance App-x64.dmg` — Intel.

The ZIP files in that directory contain the corresponding stapled apps.
`SHA256SUMS.txt`, blockmaps and `latest-mac.yml` reflect the final bytes.
The 1.4.0 artifacts were later published at
https://github.com/globa-me/Screendance-App/releases/tag/v1.4.0.

Keychain profile: `Screendance-notary`. Both app and DMG have Apple status
`Accepted` and pass Gatekeeper with `source=Notarized Developer ID`.
Old files under the other `release/` directories are historical or intermediate
artifacts; use `release/notarized-v1.4.0/` for this release. GitHub assets use
hyphenated filenames matching `latest-mac.yml`.

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
Publishing remains a separate explicit release step.

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

## Version 1.4.0 validation — 2026-09-16

- Source commit: `42a098b` (`feat: persist complete editor templates`).
- TypeScript, Biome and the full Vitest suite passed: 75 files, 665 tests.
- Both packaged app bundles passed native-binary smoke checks for FFmpeg,
  FFprobe, ScreenCaptureKit/window/cursor helpers, Whisper and `uiohook-napi`.
- App notarization submissions: arm64
  `ebaea03c-015f-44cd-9f13-6a70e8dfcb24`; x64
  `68c53989-81cb-489f-ae3f-5b3c44a6f92c`.
- DMG notarization submissions: arm64
  `5ce3bb89-dac0-4c9d-b517-74feb264c5f6`; x64
  `3a6f9a1f-a7b8-419c-8033-3cfadad3205b`.
- All four Apple submissions were `Accepted`. Both apps and DMGs pass stapler
  validation and Gatekeeper with `source=Notarized Developer ID`.
- Finalizer and `hdiutil verify` passed for both architectures; blockmaps,
  `latest-mac.yml` and `SHA256SUMS.txt` were regenerated from the final bytes.

## Version 1.5.0 validation — 2026-09-23

- The `Screendance-notary` Keychain profile was confirmed active with
  `xcrun notarytool history`. An earlier exit 69 was transient.
- The dual build with `APPLE_KEYCHAIN_PROFILE=Screendance-notary` wrote
  notarized apps to `release/notarized-v1.5.0/`.
- App submissions: arm64 `561c0759-4b3e-4225-82e6-b428db05ea3e`, x64
  `4e3783ae-c39e-49ce-bf29-e13c81d813b5`; both `Accepted`.
- DMG submissions: arm64 `91e23c0f-97a1-48a0-aae7-3a71d6fe4293`, x64
  `31d8e335-534a-4562-a485-bb87aa94028a`; both `Accepted` and stapled.
- `node scripts/finalize-macos-release.mjs release/notarized-v1.5.0` passed
  signature, stapler and Gatekeeper checks, then refreshed release metadata.
- `hdiutil verify`, `shasum -a 256 -c SHA256SUMS.txt`, and per-architecture
  packaged-binary smoke passed. Mounted DMG apps passed deep/strict signature,
  stapler and Gatekeeper checks. For smoke, set `PACKAGED_SMOKE_ROOT` to
  `release/notarized-v1.5.0/mac-arm64` or `release/notarized-v1.5.0/mac`, not
  the common release directory; the two apps contain different `uiohook`
  architectures.
- Release details and remaining manual checks: `docs/releases/v1.5.0.md`.
- The quarantined arm64 app launched under App Translocation on macOS 26.5.
  Live source selection, an imported-video MP4 export, and a short native
  screen recording passed. The GitHub release is `v1.5.0`; its body includes
  `<!-- locally-notarized-release -->` so release CI does not rebuild the
  already notarized artifacts.

## Version 1.6.0 local automation build — 2026-10-25

Local artifacts are in `release/notarized-v1.6.0-automation/`. This task does
**not** authorize publishing them or replacing the user's installed app.
The complete automation/validation/artifact record is
[v1.6.0.md](../releases/v1.6.0.md).

Both arm64/x64 apps and DMGs were signed with the pinned G2 certificate
`6E99F92E9A1BA1273CD084FAFE940A7280DB0A30`, team `BN3D9H4C7J`, Hardened
Runtime, project entitlements and secure timestamp. `GZB-notary` submissions:

- arm64 app: `d855f44f-78a5-464e-8968-c7370c7a9221`, Accepted.
- x64 app: `e15932af-f03f-4236-9a57-2e0ef55ecc18`, Accepted.
- arm64 DMG: `8a015178-a605-44c3-b52c-047e579fb69c`, Accepted.
- x64 DMG: `bb403cb5-8a55-4d86-b49f-4e24ad224638`, Accepted.

All four artifacts are stapled and pass signature/stapler/Gatekeeper checks.
App submission SHA-256 values match Apple's logs. Final ZIPs were created from
the stapled apps; extracted copies were verified separately. Finalization and
checksum verification passed after DMG stapling:

```sh
APPLE_KEYCHAIN_PROFILE=GZB-notary npm run build:mac -- \
  --config.directories.output=release/notarized-v1.6.0-automation
# electron-builder notarizes/staples the apps before creating their ZIP/DMG.
# Explicitly notarize each resulting DMG, require Accepted, then staple it.
xcrun notarytool submit 'release/notarized-v1.6.0-automation/Screendance App-arm64.dmg' \
  --keychain-profile GZB-notary --wait --timeout 20m
xcrun notarytool submit 'release/notarized-v1.6.0-automation/Screendance App-x64.dmg' \
  --keychain-profile GZB-notary --wait --timeout 20m
xcrun stapler staple 'release/notarized-v1.6.0-automation/Screendance App-arm64.dmg'
xcrun stapler staple 'release/notarized-v1.6.0-automation/Screendance App-x64.dmg'
node scripts/finalize-macos-release.mjs release/notarized-v1.6.0-automation
```

The native universal CLI is an additional executable at
`Contents/MacOS/screendance`; `mac.binaries` paths are relative to the app root
and must include `Contents/`. The G2 signer explicitly signs and strictly verifies
this launcher **before** the main Electron executable. `osx-sign`'s depth-only
sort otherwise ties the two siblings and can sign the parent too early.
`macos-code-components.mjs` filters ordinary data from per-file signing; the
outer bundle still seals it. Eleven Node tests verify certificate selection,
code detection and signing order/options/failure behavior.

Both packaged binary smokes pass with their corresponding
`PACKAGED_SMOKE_ARCH_TAGS` and app root. FFmpeg is universal, FFprobe and native
helpers match each architecture, and both existing bundled Whisper runtimes are
present. Native Swift helpers were freshly rebuilt for both architectures;
Whisper reused matching existing artifacts because CMake was absent.

This Mac's shell Node is x64 while development Electron is arm64. Dual packaging
leaves the native npm module on the last target. Restore development explicitly:

```sh
node node_modules/@electron/rebuild/lib/cli.js --force --only uiohook-napi --arch arm64
file node_modules/uiohook-napi/build/Release/uiohook_napi.node
```

Do not modify/re-sign the notarized apps. Keep the final hashes in the version
record and `SHA256SUMS.txt`; further production changes require fresh signing and
notarization. Broader physical hardware/permission checks remain manual.
