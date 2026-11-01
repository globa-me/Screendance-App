# Automation upgrade work log

## Approved scope — October 25, 2026

User authorized completing stages 4–6 of coverage.md, fixing related bugs and improving UX.
Stages 1–3 are complete; the October 24 baseline has 387 tests and live capture/CLI/MCP/Codex evidence in validation.md.
Do not claim later stages complete until their code and actual checks are finished.
Preserve the existing uncommitted release/signing work and test_transcode_ks.mov.

Implementation ownership (completed):
- automation_editor: stage 4 full document mutations/revisions/atomic batches/full undo/presets/preview; VideoEditor.tsx + renderer automation + shared/editorAutomation.ts.
- automation_cli: stage 5 durable jobs and job renderer/media helpers + shared/jobAutomation.ts; parent integrates actual export callbacks after stage 4 handoff.
- automation_review: stage 6 system command services + App-level renderer preferences adapter + shared/systemAutomation.ts.
- parent: registry/CLI/MCP/host/preload integration, explicit output safety, bundled runtime-independent CLI, packaging/signing/notarization and combined validation.

Implementation decisions:
- One registry, strict validated operations, no arbitrary renderer JS or generic external IPC endpoint.
- Editor mutations operate on the full persisted document, with optimistic revision checks and atomic batches; UI and automation share application/history behavior.
- System renderer commands have a distinct automation:system-request channel and readiness so HUD/editor adapters do not race to reply.
- Jobs persist independently of MCP connections and become interrupted after process restart. Snapshot capture happens at enqueue time. Export runs through the existing compositor/export pipeline, with the editor locked against document/source changes during its frozen job.
- Path-based outputs must not overwrite by accident or follow a replaced symlink. Explicit output paths avoid dialogs. Keep recoverable finished temporary exports for retry-save.
- Native CLI launcher uses the app's bundled Electron runtime; separate Node installation is not required in packaged builds. Development CLI still supports Node22+.
- Public packaging retains macOS 14+ arm64/x64, matching native/Whisper helpers, FFmpeg/FFprobe and G2 signing settings from AGENTS.md.

Validation checkpoint:
- TypeScript, the final full Vitest suite (1121 tests / 107 files), and 11 Node signing tests pass.
- Live isolated-profile CLI/MCP upgrade smoke passes all 16 scenarios; previous recorder/Codex smoke also passes.
- Real MP4/GIF/alpha MOV/WebM and legacy exports, 14 dB per-clip audio regression, cancellation/retry/disconnect and retained-save are verified. Current-Mac Quick Look displays MOV without black matte.
- Claude Code MCP connects without login as explicitly selected by the user; no model-driven Claude calls.
- Packaged arm64 and x64/Rosetta smokes each pass all 16 scenarios with native bundled CLI and PATH=/usr/bin:/bin. Both architecture binary checks, G2 signatures, stapler, Gatekeeper, final ZIP extraction, mounted DMG inspection and final checksum verification pass. No external publishing is authorized.

Update this log and coverage/validation documents with actual results and any unfinished items before handing off.

## Implementation checkpoint

- Stage 4 commands/controller/full history/presets/media preparation integrated. Saved custom motion and caption font no longer reset on load. Embedded annotation images are bounded at 8 MiB; wire input limit 16 MiB with linear chunk buffering.
- Stage 5 durable jobs, trusted renderer bridge, immutable export config, atomic explicit output publication, retained retry-save, model/caption workers integrated. Freeze media fingerprints and caption audio candidates; stale source changes refuse publication. Renderer instance documentId supplements revision guards for caption apply/reload conflicts.
- Stage 6 system commands/providers/broadcasts, safe lifecycle/update actions, fonts/wallpapers/HUD/logs/clipboard/Finder, local+catalog extension installation integrated. Extension replacement is transactional; archive origin/ID/size/traversal checks added.
- Audio engine bug fix validated with unit and actual export/RMS checks: per-clip gain/mute/normalization maps through source→output trims/speeds/chunks, instead of depending on selected clip. Root normal+frozen configs pass full default/by-clip settings.
- Native universal CLI launcher compiled (macOS 14 arm64/x64). `_NSGetExecutablePath` supports PATH/symlinks. User installation refuses unrelated links/files; bundled Electron RunAsNode uses no separate Node. GUI auto-launch strips RunAsNode from child environment.
- Package version is 1.6.0; builder bundles launcher and CLI resource and explicitly signs launcher. G2 fingerprint and GZB-notary profile verified October 25; no private credentials accessed. Native helpers rebuilt for both architectures; matching Whisper runtimes staged using existing bundled artifacts (CMake absent).
- JobsPanel mounted as an editor footer with proper flex sizing; cancel routes to actual job, retained export save honors consumed artifact state. Captions enable their display in the same atomic cue-application batch.

Finalization: native CLI must be signed before the main Electron executable (osx-sign sorts equal-depth siblings in the wrong order). scripts/sign-macos-g2.mjs pre-signs and strictly verifies explicit binaries, then seals the bundle with the same G2 identity/runtime/timestamp/entitlements. Non-code binary resources are sealed by the parent instead of individually signed. Regression tests cover both rules. The native CLI architecture metadata test uses bounded 15s tool / 35s test timeouts so parallel builds do not exceed its former 5s default.

Distribution checkpoint: both G2 apps and DMGs are accepted/stapled; exact signatures, Gatekeeper, final ZIP extraction and mounted read-only DMG app checks pass. Finalization refreshed all metadata/checksums after stapling, and all nine SHA256SUMS entries verify. App submission SHA values match Apple logs. Native uiohook was restored to arm64 for the development Electron (shell Node is x64). Details/IDs/hashes are in docs/releases/v1.6.0.md.

Completed October 25: full x64/Rosetta upgrade smoke passed 16/16 at .tmp/automation-upgrade-DuM5X3/report.json, actual app architecture x64, RMS difference 14 dB. The first run hit the explicit BUSY save guard during automatic saving; the smoke now waits for idle and permits bounded retries only for a definite pre-mutation BUSY rejection with unchanged revision/document/content. It never retries ambiguous IPC errors or weakens app guards; the successful fresh run needed no retry. All six stages and local distribution are complete.

Handoff: start from docs/automation/README.md, coverage.md and validation.md; local build IDs, hashes, commands and manual limits are in docs/releases/v1.6.0.md. Do not change/re-sign the notarized apps. Future production changes require a new build/sign/notarization. Claude was verified only for MCP connection by explicit user choice. Physical microphone/webcam/TCC matrices and real speech-recognition accuracy remain manual validation, not unfinished implementation. No application/client global configuration or installed app was replaced, and no release was published.
