# Automation validation

Date: October 25, 2026. Source scope: stages 1–6, Screendance App 1.6.0,
**84 commands**. **Both arm64 and x64 applications** passed full packaged CLI/MCP
and binary smoke; x64 ran via Rosetta. Both apps and DMGs are G2 Developer ID
signed, notarized/stapled and Gatekeeper-verified. Post-staple ZIP/mounted-DMG QA
and all nine final checksums passed. These local artifacts were not externally
published or installed over the user’s existing app. Exact hashes/Apple IDs and
reproduction are in the [1.6.0 release record](../releases/v1.6.0.md).

## Automated checks

- `npx tsc --noEmit`: passed.
- `npm test`: **1121 tests passed across 107 files** in the current full run.
  Coverage includes local socket authentication/ownership/lifecycle, strict
  contracts/CLI/SDK, path and atomic persistence safety, document/history/revision
  conflicts, recording/cancellation/resource ownership, frozen export/captions/
  jobs/restart/cancellation/publication, system preferences/extensions/updater
  guards and the mandatory native-export regression suites.
  Final full-suite log: `.tmp/automation-upgrade-final-tests.log`.
- Signing-specific Node regression tests: **11 passed**.
- CLI/MCP bundle plus renderer/Electron main/preload production builds: passed.
- Targeted Biome and script syntax checks passed for the new smoke.

These are the observed run counts; regenerate tests after further source edits.

## Real desktop and AI-client evidence

The following reports live under ignored `.tmp/` and are local evidence, not
tracked release assets. Never copy endpoint tokens into documentation or Git.

| Run | Observed result | Scope / limits |
| --- | --- | --- |
| `.tmp/automation-upgrade-Dqz6ts/report.json` | `success:true`, 16 checks, 84 commands | Real Electron/CLI/official SDK MCP stages 4–6 roundtrips, isolated generated media/profile |
| `.tmp/automation-smoke-T11iKd/report.json` | `success:true`, 24 listed checks, `recordingVerified:true`, `codexVerified:true` | Native synthetic-window recording, PNG/project/recorder/save pipeline and real authenticated Codex tool calls |
| `.tmp/claude-stage6-DEIWLv/validation.json` | Claude Code 2.1.308 MCP Connected, 84 tools, SDK call verified, disconnect survival | `modelCallsVerified:false`; user chose MCP-only verification without Claude login |
| `.tmp/automation-upgrade-eNtuOm/report.json` | `success:true`, 16 checks, arm64 packaged app | Native bundled CLI/MCP with `PATH=/usr/bin:/bin`, external Node not required |
| `.tmp/automation-upgrade-DuM5X3/report.json` | `success:true`, 16 checks, x64 packaged app via Rosetta | Native bundled CLI/MCP with restricted PATH; actual app arch x64; 14 dB audio regression |
| `.tmp/automation-packaged-x64-binaries.log` | Packaged binary smoke passed | `PACKAGED_SMOKE_ARCH_TAGS=darwin-x64`, architecture-matching native dependencies |
| `.tmp/automation-packaged-arm64-binaries.log` | Packaged binary smoke passed | `PACKAGED_SMOKE_ARCH_TAGS=darwin-arm64`, matching native/Whisper/uiohook/media binaries |
| `.tmp/automation-packaged-arm64-install-KsgZ6Q/report.json` | Install/setup/uninstall and collision checks passed | Native CLI, restricted PATH, temporary link directory, print-only Codex/Claude setup, unrelated file preserved |
| `.tmp/automation-export-formats.json` | `success:true`, four format checks | GIF, ProRes 4444 MOV alpha, VP9 WebM alpha and legacy MP4 via real export jobs |

Development Electron ran as **arm64**; orchestration/external development Node
ran as **x64 under Rosetta**. That demonstrates local interoperability, not a
physical Intel Mac result. The separately recorded packaged x64 run below
executed through Rosetta on this Apple Silicon machine.

The upgrade run completed at 2026-10-25 08:04:00 UTC and verified:

- Real editor open/readiness, MCP discovery and inspection.
- Atomic settings/clip speed/zoom/text/image/external-audio editing; local images
  embed correctly; stale revisions and an invalid batch leave state unchanged.
- Full document undo/redo and preset save/list/get/apply/delete.
- Save/reopen preserves authored cursor/spring/zoom motion and caption font.
- Theme/locale/shortcuts/directories/HUD changes, passive catalogs/models/jobs,
  bounded diagnostics/log reads, wallpaper registration/removal.
- Synthetic local extension install/activation, a declared numeric setting,
  setting update and uninstall; safe rename and dirty-quit refusal.
- Real MP4 export surviving MCP disconnection, with FFprobe stream/duration checks
  and refusal to overwrite existing output.
- A two-clip export with selected second clip and gains 1.0/0.2: interior RMS
  levels **−21.1 / −35.1 dB**, difference **14.0 dB**, proving the frozen export
  applies each clip's gain independently of selection.
- Export cancellation and explicit retry; a deliberate competing writer produces
  `TARGET_CHANGED`, preserves the competing file, retains the completed export,
  and `export.save` publishes it elsewhere without rerendering.
- Caption job performs real audio extraction, launches an **explicitly fake local
  Whisper executable with a dummy model**, parses its synthetic cue and applies
  it to the editor. This verifies orchestration/parser/application, **not actual
  speech recognition or model accuracy**. No speech model was downloaded.
- Clean safe quit terminates only the isolated test application.

Its seven jobs were four successful real exports (initial/audio/retry/rescued),
one expected cancellation, one expected failed publication, and one successful
caption-generation/application job.

Additional format jobs produced FFprobe-valid GIF, MOV, WebM and legacy-pipeline
MP4 using the synthetic fixture. MOV reports `ap4h`, `yuva444p12le`, BT.709,
vendor `FFMP` and `Lavc62.28.101 prores_ks`; WebM reports VP9 and `alpha_mode:1`.
Alpha extraction/statistics are retained in `.tmp/automation-alpha-statistics*.txt`.
Finder Quick Look was opened for the generated MOV on this Mac: rounded edges
were visibly transparent without a black matte. The editor Jobs panel was also
visually checked to fit its window. Final Russian UX shows a rescued/consumed
publication failure as «Результат сохранён» with its path and without an attention
flag; cancellation uses neutral «Задача отменена». This evidence concerns this synthetic fixture
and current Mac; it does not replace other-device or final-packaged checks.

The original smoke additionally verified composed source-time PNGs, inline MCP
image return, exclusive paths, Cyrillic/spaced paths, same-source reopening,
clean/dirty guards, webcam-session restoration and fresh import behavior. Its
native ScreenCaptureKit test used a uniquely titled generated animated fixture
window and existing TCC grants; microphone, system audio and webcam were disabled.
It exercised countdown cancellation, start/pause/resume, MCP stop/finalization,
editor adoption, FFprobe, save-as/current-save/overwrite protection/library and
round-trip open, plus discarding a second take while keeping the previous project
saveable. It never selected a person's desktop/window as fallback.

Codex executed real read tools (`app_status`, `project_inspect`, `project_list`,
`recording_status`) using ephemeral test configuration and existing login.
Claude MCP connection/discovery and official SDK calls were tested separately.
The user explicitly selected **MCP only without login** for Claude; no credentials
or existing client configuration were changed, and Claude model-driven calls
were not attempted. A connected server does not establish model authentication.

## Important regression protection

- Source probing/legacy timeline preparation completes before the loaded dirty
  baseline is adopted. Minimal and fully trimmed projects keep their intended
  timeline; neutral source-audio discovery does not hide authored changes.
- Project opens have a pending-request/sender/path-scoped loader and pre-apply
  rollback for main context/media access; newer opens are not overwritten.
- Saves capture context before target preparation, reject partial/in-flight
  document loads and only baseline the exact persisted snapshot.
- Native countdown cancellation settles start; recording stop waits for sidecars;
  discard preserves prior context and deletes only its owned take.
- Document identity/revisions and full history protect concurrent UI and AI edits.
  Caption application additionally verifies originating source/document/revision.
- Dedicated export state freezes document/settings/media, including per-clip
  audio maps. Disk jobs survive adapter disconnect; unfinished restart becomes
  interrupted and requires explicit retry. Publication is guarded atomically.
- System mutations serialize with editing/recording/job creation. Unsafe
  close/quit/update install inspect live dirty/busy state, not only stale main flags.
- Transactional extension replacement rolls back files/metadata on failure;
  archive tests cover size/traversal/symlink/special-file/manifest/redirect safety
  without a live remote install. Narrow preference synchronization updates windows.
- Local socket ownership, private directories, stale lock recovery and renderer
  reload/crash/close cleanup have focused tests.

## Packaged applications and final artifacts

The app at `release/notarized-v1.6.0-automation/mac-arm64/Screendance App.app`
passed read-only `codesign --verify --strict --verbose=2` and `xcrun stapler validate`
before launch. Signature metadata confirms Developer ID, team `BN3D9H4C7J`,
Hardened Runtime and secure timestamp. Apple's Accepted submissions are recorded
in the linked release record with their exact IDs.
The full packaged run completed at 2026-10-25 08:28:12 UTC: all 16 upgrade checks
passed, actual app architecture arm64, native CLI/MCP runtime bundled with
`PATH=/usr/bin:/bin`, and the per-clip RMS difference again exactly 14 dB.
The external Node executable only orchestrated the smoke/fake-caption fixture;
it was not used to execute CLI or MCP. The application bundle was not modified
by these tests. The x64 app at
`release/notarized-v1.6.0-automation/mac/Screendance App.app`
also passed read-only strict signature/stapler checks before
launch, then all 16 scenarios as actual architecture **x64 via Rosetta**. It ran
2026-10-25 08:35:09–08:43:12 UTC, with bundled CLI/MCP, restricted PATH and the
same exact 14 dB audio regression. Its `retryObservations` array is empty.

An earlier x64 run (`.tmp/automation-upgrade-W0CP3Q/report.json`) safely refused
a preset save with `BUSY` while normal autosave was active. The smoke now binds
document identity and permits at most five retries/90 seconds only after an
explicit BUSY refusal and fresh idle/readiness inspection; identity, revision,
content and project path must stay unchanged. Expected failures, ambiguous
timeouts and lost replies are never retried. The fresh successful run needed
no retries. Application guards and notarized application bundles were unchanged.

An additional native-launcher check installed a link only into a generated test
directory, executed its help command, printed both client setup commands with
`applied:false`, removed the owned link and refused an unrelated existing target.
All CLI executions used restricted PATH and no external Node; no client settings
or user installation directories were changed.

Both per-architecture binary smokes passed, including native capture/cursor/
window helpers, matching Whisper runtimes, FFmpeg/FFprobe and uiohook. Both app
and DMG notarizations returned Accepted; final stapler/Gatekeeper checks passed.
Extracted post-staple ZIP QA reports:
`.tmp/automation-archive-arm64-x8gVW1/report.json` and
`.tmp/automation-archive-x64-3QbCfV/report.json`. Both verified exact G2 certificate,
deep/strict signatures, tickets, Gatekeeper, expected main architecture and native
CLI help/setup with restricted PATH. Read-only mounted-DMG inspection passed for
both artifacts in `.tmp/automation-dmg-qa-ZrWs99/report.json`; volumes detached.
After finalization, `SHA256SUMS.txt` verified all nine files. Final artifact hashes
and all four Apple submission IDs are recorded once in the release record.

## Remaining manual validation

- Physical microphone/camera/system-audio capture, denied/revoked TCC dialogs,
  long sessions/crashes and broader hardware matrix were not covered by these
  desktop smokes. Recorder orchestration has focused regression tests.
- Actual speech recognition/model quality, large model download, live remote
  marketplace installation, and real updater download/install were not exercised.
  Their services have offline/unit coverage; the live smoke makes no such claim.
- Physical Intel/macOS14-minimum execution remains separate from Rosetta smoke.
- Static FrameRenderer PNGs do not promise sequential spring/motion-blur
  equivalence to export. Alpha container/codec validity does not replace macOS
  Quick Look/Finder visual validation; retain the documented ProRes guardrail.

Reproduction commands and isolation requirements are in [README.md](README.md).
Release signing/notarization results belong in `docs/releasing/macos-signing.md`.
