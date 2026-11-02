# Screendance App changelog

This is the history of the Screendance fork. For the complete history before
the fork, see [Recordly](https://github.com/webadderallorg/Recordly/commits/main).
For the complete, browseable history after the fork, see the
[Screendance commit log](https://github.com/globa-me/Screendance-App/commits/screendance/macos-apple-silicon).

## November 2, 2026 — 1.7.0 (local build, notarized, not published)

- The source picker shows live thumbnails of every window and screen (native
  ScreenCaptureKit previews on macOS) in a grid with app icons. Windows with
  the same title are no longer selected together.
- While a recording is paused on macOS you can switch to another window or
  screen and turn the microphone or webcam on, off or to another device, then
  resume the same take. A source with another shape is letterboxed into the
  original frame; the cursor follows it. Also available as `recording.adjust`
  in the CLI/MCP (85 commands).
- New highlight annotations — rectangle, ellipse and marker — are anchored to
  the recorded content and stay on it through zooms, camera motion and crops,
  in the preview and in every export path.
- New recordings and imports reuse the background you chose last instead of
  the last preset's background. Opening an old project no longer changes it.
- Fixed an invisible HUD area that kept swallowing clicks where the recording
  bar used to be after it was dragged, and after hiding the HUD.

Details and verification: [`docs/releases/v1.7.0.md`](docs/releases/v1.7.0.md).

## October 25, 2026 — 1.6.0 (local build)

- Added an opt-in CLI and MCP server with 84 typed commands for recording,
  project saving, full editor changes, presets, playback, export, captions,
  speech models, settings, extensions and diagnostics.
- Bundled a universal native CLI launcher that uses the app's runtime, with
  user-local installation and Codex/Claude Code setup commands.
- Added atomic editor batches with revision and document checks, and shared
  complete undo/redo behavior between UI controls and automation.
- Added durable background jobs with progress, cancellation, explicit retry
  and recovery of a completed export when its destination changes. Jobs remain
  independent of CLI/MCP connections and are visible in the editor footer.
- Fixed per-clip source audio gain, mute and normalization across trims, speed
  changes and output chunks. Export no longer depends on the selected clip.
- Preserved custom motion settings and caption fonts when reopening projects.
  Caption generation now enables captions when applying its result and refuses
  to overwrite a changed document.
- Made extension replacement transactional and guarded marketplace archives,
  output publication and log reads against path and replacement races.
- Fixed recording countdown cancellation, finalization/recovery and project
  handoff behavior while adding automation coverage.

This build has not been published. Build artifacts, validation results and
remaining manual checks are recorded in [`docs/releases/v1.6.0.md`](docs/releases/v1.6.0.md).

## September 23, 2026 — 1.5.0

This release is available from the
[Screendance App 1.5.0 release](https://github.com/globa-me/Screendance-App/releases/tag/v1.5.0).

- Fixed the blank standalone source-selection window and added a fallback for
  unavailable source thumbnails. Animated names are now announced once by
  screen readers.
- Enabled the existing Russian translation in language settings and added a
  registration check for locale files, runtime bundles and the language menu.
- Improved keyboard access and visible focus for wallpaper choices, editor
  sections and the timeline playhead. Added keyboard seeking with arrow keys,
  Shift, Home and End.
- Added Undo for deleted editor presets and custom wallpapers.
- Simplified default export settings, increased label and control sizes, and
  clarified transparent MOV/WebM output.
- Export now asks for a destination and checks write access and free space
  before rendering. Progress remains visible in the toolbar; cancellation waits
  for the exporter to stop. Direct writes use temporary files before replacing
  an existing result.
- WebM-to-ProRes conversion now explicitly marks BT.709 color space; a small
  alpha sample retained transparency in macOS Quick Look verification.
- Replaced blocking recording alerts with localized notifications.

The 1.5.0 arm64 and x64 apps and DMGs are signed, notarized, stapled and
verified locally. Validation details are in
[`docs/releases/v1.5.0.md`](docs/releases/v1.5.0.md).

## September 16, 2026 — 1.4.0

This release is available from the
[Screendance App 1.4.0 release](https://github.com/globa-me/Screendance-App/releases/tag/v1.4.0).

- Transparent video export: WebM and ProRes 4444 QuickTime `.mov`, streamed
  temporary files, alpha-safe canvases and alpha-channel validation.
- A macOS Quick Look-safe ProRes path: `prores_ks`, `ap4h`, BT.709 metadata and
  no forced `apl0` vendor.
- More reliable recording audio: external-microphone resolution, a microphone
  sidecar fallback and live system/microphone level indicators.
- Session logs and diagnostic UI, with safer temporary-export cleanup.
- Configurable zoom mode, duration and smoothness; improved manual zoom focus
  and preview scaling.
- Improved portrait, transparent and webcam rendering paths; CSS gradients now
  render consistently in exports.
- Global source-selection and recording shortcuts; fewer duplicate macOS
  permission requests; refreshed UI translations and help.
- New projects are saved as `.scrdance`; `.recordly` projects continue to open,
  save, appear in the project library and protect their recordings from cleanup.
- The Extensions manager and extension-contributed sidebar pages are hidden
  pending a redesigned experience; extension implementation code is retained.
- Editor templates now preserve the complete reusable presentation and export
  setup, including cursor visibility, padding, crop, output format, webcam
  position, aspect ratio, alpha/GIF settings, caption styling and default zoom
  creation behavior.
- The last explicitly applied or newly saved template becomes the default for
  every fresh recording and imported video, while saved projects retain their
  own editor state and camera media bindings.

## May 22, 2026 — Screendance macOS fork

- [`93ea190`](https://github.com/globa-me/Screendance-App/commit/93ea190) Fix
  portrait caption export scaling.
- [`afebe22`](https://github.com/globa-me/Screendance-App/commit/afebe22)
  Reduce duplicate macOS screen permission prompts.
- [`9985629`](https://github.com/globa-me/Screendance-App/commit/9985629)
  Replace remaining Recordly UI branding.

## May 21, 2026 — initial fork work

- [`ff686fb`](https://github.com/globa-me/Screendance-App/commit/ff686fb)
  Initialize the Apple Silicon-oriented Screendance fork.
- [`fd09b59`](https://github.com/globa-me/Screendance-App/commit/fd09b59)
  Improve portrait fast-export quality.
- [`9db8bc4`](https://github.com/globa-me/Screendance-App/commit/9db8bc4)
  Disable upstream automatic updates.

## Before May 21, 2026 — Recordly

The fork starts from
[`67a83ca`](https://github.com/webadderallorg/Recordly/commit/67a83ca) of the
original [Recordly project](https://github.com/webadderallorg/Recordly). Its
authors, releases and full earlier history remain available upstream.

## Maintaining this file

Before releasing a version, move completed items from **In development** into a
dated version heading and link that heading to its tag or release. This keeps
the project page accurate and makes the handoff state clear to future
maintainers.
