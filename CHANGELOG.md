# Screendance App changelog

This is the history of the Screendance fork. For the complete history before
the fork, see [Recordly](https://github.com/webadderallorg/Recordly/commits/main).
For the complete, browseable history after the fork, see the
[Screendance commit log](https://github.com/globa-me/Screendance-App/commits/screendance/macos-apple-silicon).

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
