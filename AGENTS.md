# Agent Notes

## Intel (x64) support discontinued — 2026-11-03

The owner discontinued macOS Intel support. 1.7.1 is the last x64 release and
stays published as is. Build, test and release **arm64 only**; do not build,
smoke-test, notarize, fix or document x64 again, and do not suggest it. The
committed `electron/native/bin/darwin-x64/*` helpers are frozen at 1.7.1 and are
not rebuilt. Universal pieces that cost nothing (staged universal FFmpeg, the
universal `Contents/MacOS/screendance` launcher and its test) were left as is.
Windows/Linux x64 jobs in `.github/workflows` are upstream Recordly leftovers,
not Intel Mac support.

## 1.7.0 work in progress (branch `screendance/v1.7.0`)

Read `docs/releases/v1.7.0.md` first: source thumbnails, paused-only live
capture changes (`switch_source`/`set_microphone` helper commands, letterboxed
source + `cursorContentViewport`, canvas webcam compositor + `webcam.hiddenRanges`),
content-anchored `highlight` annotations (source-frame percentages, drawn in
the camera container), last-wallpaper reuse and the HUD hit-zone fix. CLI/MCP
now has 85 commands (`recording.adjust`). The dual-arch 1.7.0 release is built,
notarized, stapled and verified in `release/notarized-v1.7.0` and published as GitHub release v1.7.0;
the notarized arm64 app is installed in /Applications, 1.5.0 backup is in
`release/backup-installed-1.5.0`. Never modify/re-sign those bundles. Keep highlights out of screen-space
annotation paths and hidden ranges out of presets.

## 1.7.1 fixes after 1.7.0

Read `docs/releases/v1.7.1.md`: a closed recorded window now pauses the
take (helper `SOURCE_UNAVAILABLE_PAUSED`, resume refused until a new source),
recovery runs for every interruption, unsaved-changes prompt before opening,
one mic sidecar per role, and File → Open Video… / Projects "Open video…".
1.7.1 is built, notarized and verified in `release/notarized-v1.7.1`, published
as GitHub release v1.7.1 and installed (arm64) in /Applications. Never
modify/re-sign those bundles.

## CLI/MCP automation

Stages 1–6 are implemented in source for 1.6.0: 84 commands registered through
`shared/automation.ts` and the editor/job/system contracts. Read
`docs/automation/README.md`, `coverage.md` and `validation.md` before extending it.
Both arm64/x64 apps passed all 16 packaged scenarios with bundled CLI/MCP; x64
ran via Rosetta on this Apple Silicon Mac. Both apps/DMGs are G2 signed, notarized,
stapled and Gatekeeper-verified; post-staple ZIP/mounted-DMG QA and all nine final
checksums passed. The local 1.6.0 build is not published/installed over the user
app. Read `docs/releases/v1.6.0.md`, automation validation and release-signing
notes before changing artifacts. Never modify/re-sign a notarized bundle in place.

The live editor owns persisted state. Use `editor.get` snapshots, revision and
`documentId`; mutations share the UI document controller/full undo history and
require the expected revision. Pass expected document identity when available.
Validate/prepare the entire batch before committing once; source-media coordinates
and clip display spans differ with speed. Path-based saves use main-only prepared
targets and atomic writes. Only the captured persisted snapshot becomes the saved
baseline; later edits stay dirty. Preserve legacy project migration, session
cursor override, current webcam media/offset and preset semantics below.

Export/caption/model jobs are app-owned, durable and independent of MCP clients.
Freeze document/export/source-audio/media state before work; use the dedicated
frozen export renderer. Per-clip audio maps must not depend on current selection.
Caption application checks originating document ID/source/revision and enables
captions atomically. Restart marks unfinished jobs interrupted; retry is explicit.
Do not auto-retry ambiguous mutations or overwrite a competing output. Keep the
retained finished artifact available when publication fails, for `export.save`.

Recorder controls must reuse the complete `useScreenRecorder` pipeline, including
mic/webcam finalization/recovery, rather than native capture IPC alone. Keep the
HUD alive after editor handoff. Stop/recover reconcile an existing editor; inspect
`editor.opened` and warnings. Countdown cancellation settles start even while its
window loads. Native start returns its owned path; discard-stop preserves prior
project context and deletes only that take. Automation launches disable passive
mic/camera previews/prompts; explicit start/permission requests may acquire devices.

System commands reuse direct services/narrow renderer bridges, never arbitrary
IPC/JS evaluation. Preferences and declared extension settings synchronize live
windows. Preserve transactional extension install/rollback, trusted marketplace
archive checks and typed registered setting validation. Hidden marketplace admin
review endpoints are outside the app-user contract. Close/quit/update installation
must inspect live dirty/loading/saving/export/caption/recording/job state.

The host is opt-in (`--automation` or `SCREENDANCE_AUTOMATION=1`); development uses
`npm run dev:automation`. Build the Node22+ development bundle using
`npm run build:automation`. The packaged universal native launcher at
`Contents/MacOS/screendance` runs the bundled Electron runtime without external
Node; `install` creates only its own user symlink and `setup` prints client
registration commands without applying them. Only arm64 is maintained.

Real smoke uses generated media and isolated profiles: `npm run smoke:automation`
and `node scripts/smoke-automation-upgrade.mjs`. Packaged smoke uses
`SCREENDANCE_SMOKE_APP=/absolute/path/App.app` with restricted CLI/MCP PATH;
x64 on this Apple Silicon Mac is Rosetta evidence, not physical Intel coverage.
Never use a person's live profile/projects or log/commit endpoint tokens. Claude
MCP-only connection/discovery was verified at the user's choice without login;
model-driven Claude calls were not tested. Upgrade caption smoke uses an explicitly
fake speech runtime; physical mic/camera/recognition accuracy are separate tests.

When changing automation, run TypeScript and relevant contract/host/editor/jobs/
recorder/system tests; meaningful export changes require the regression suites
below. Full current check: `npm test` (1121 tests/107 files at documented run).
The static PNG uses FrameRenderer: retain source-time/compositor limitations;
do not claim sequential spring/motion-blur equivalence from a PNG.

## ProRes Alpha Export Guardrail

Do not change ProRes alpha export without re-checking macOS Quick Look/Finder
preview behavior. `ffprobe` can report a valid alpha plane while Apple UI still
shows a black matte.

Known-good behavior:

- Output extension is `.mov`.
- Codec is ProRes 4444 (`ap4h`) via `prores_ks`.
- Pixel format is alpha-capable (`yuva444p10le` during encode; `ffprobe` may
  report `yuva444p12le`).
- Stream vendor remains FFmpeg default `FFMP`.
- Encoded frame strings include `Lavc`, not `apl0`.
- BT.709 metadata is present.
- On macOS, prefer system FFmpeg for ProRes alpha if available.

Do not add `-vendor apl0` or `vendor_id=apl0` for this export path. That caused
the June 2026 regression where files contained an alpha plane but macOS Quick
Look showed a black background.

Before accepting export/transcoding changes, run:

```bash
npx tsc --noEmit
npm test -- electron/ipc/nativeVideoExport.test.ts electron/ipc/register/export.test.ts electron/ipc/export/native-video.test.ts
```

For manual verification:

```bash
ffprobe -hide_banner -show_streams -show_format -of json output.mov
ffmpeg -hide_banner -v error -i output.mov \
  -vf "alphaextract,signalstats,metadata=print:file=-" \
  -frames:v 5 -f null -
strings -a output.mov | rg 'Lavc|apl0|ap4h|colr|nclc|nclx'
```

Reference from the regression investigation:

- Good: `/Users/gennadiyzakharov/Downloads/mf0test1.mov`
- Bad: `/Users/gennadiyzakharov/Downloads/mf0test2-2.mov` before the fix

## macOS architecture release guardrail

The supported target is macOS 14+ on Apple Silicon (`arm64` artifacts only).
Intel (`x64`) was discontinued after 1.7.1 (see the top of this file); the
builder, Swift helper build and Whisper runtime build target arm64 only.

`ffmpeg-static` is staged as a universal macOS executable before packaging.
FFprobe must remain packaged for both Darwin architectures; excluding
`node_modules/ffprobe-static/bin/darwin/**` makes recording validation and native
export fail on a clean Mac.

For a local release, use `npm run build:mac`, then run packaged smoke on
`release/<dir>/mac-arm64` with `PACKAGED_SMOKE_ARCH_TAGS=darwin-arm64`. After
notarizing and stapling the DMG, run:

```bash
node scripts/finalize-macos-release.mjs release/<dir>
```

The September 11, 2026 validation record and Apple submission IDs are in
`docs/releasing/macos-signing.md`.

## Editor preset guardrail

Editor presets are persisted in `src/components/video-editor/editorPreferences.ts`.
They own reusable presentation and export settings, including cursor visibility,
padding, main-video crop, webcam layout, aspect ratio, output format, alpha/GIF
options, caption styling, and default zoom-creation behavior.

The ID of the last explicitly applied or newly saved preset is stored separately
under `recordly.editor.lastPresetId`. Apply that preset to fresh recordings and
newly imported videos only. Since 1.7.0 the background is the exception: the
wallpaper last chosen explicitly (panel or applied preset) is kept in
`preferences.wallpaper` and wins for fresh videos; the auto-save effect must not
write `wallpaper`, so loading a project never changes it. A saved `.scrdance`/`.recordly` project remains the
authoritative source of its editor state and must not be overwritten by the last
preset during load.

Webcam preset application must preserve the current video's `sourcePath` and
`timeOffsetMs`; never carry camera media from the video where the preset was
created. Session-level `hideOverlayCursorByDefault` also remains stronger than a
preset so native recordings do not display a duplicate cursor.


## Local artifact cleanup — 2026-10-27

Owner authorized removing old builds. Unpacked mac/mac-arm64 in notarized-v1.6.0-automation were byte-exact duplicates of retained final ZIPs and were removed; restore both from ZIP before rerunning release finalization. All final ZIP/DMG/blockmaps/update metadata/checksums, installed app and old 1.5 ZIP/DMG remain. Old unpacked1.5 G2 candidates were removed (arm64 was ad hoc packaging output). Removed only exact Chromium cache children under 20 synthetic QA profiles and .tmp FFmpeg/FFprobe staging; profile state, recordings/jobs/reports and canonical node_modules runtimes remain. Source/retained files SHA-verified, installed deep/strict signature passed. Private inventory/recovery: ~/Documents/Codex/maintenance/cleanup-20261027/README.md. Never replay historical cleanup scripts.
