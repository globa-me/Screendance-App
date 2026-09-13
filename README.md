# Screendance App

Screendance App is a modern macOS fork of
[Recordly](https://github.com/webadderallorg/Recordly).

The fork keeps Recordly's screen recording and editor workflow, but narrows the
target to macOS 14 and newer on Apple Silicon and Intel. The current priority is better native
ScreenCaptureKit capture, reliable external microphone selection, lower system
load during recording, and higher quality portrait exports.

## Scope

- macOS only
- separate Apple Silicon (`arm64`) and Intel (`x64`) builds
- Developer ID signing and notarized distribution ready (see
  [macOS distribution](docs/releasing/macos-signing.md))
- upstream attribution remains with Recordly and its contributors

## What It Contains

Screendance App is an Electron desktop app:

- `electron/` contains the Electron main process, IPC handlers, local media
  server, native capture integration, export handlers, and bundled native helper
  paths.
- `electron/native/` contains Swift helpers for macOS ScreenCaptureKit capture,
  window listing, cursor assets, and native cursor monitoring.
- `src/` contains the React/Vite renderer UI, recording controls, launch HUD,
  editor, timeline, export settings, localization, and reusable UI components.
- `src/hooks/useScreenRecorder.ts` coordinates the renderer-side recording
  state, microphone/webcam/system-audio options, browser capture fallback, and
  native recording startup.
- `src/components/video-editor/` contains the editor, timeline, aspect-ratio
  controls, export settings, project persistence, webcam overlay controls,
  captions, annotations, and playback logic.
- `src/lib/exporter/` contains the modern renderer/export pipeline.
- `scripts/` contains build and smoke-test helpers for native tools, Electron
  packaging, FFmpeg, and release checks.
- `electron-builder.json5` defines separate macOS `arm64` and `x64` DMG/ZIP
  builds with required Developer ID signing and a macOS 14 minimum.

## Current version and download status

**Status on August 10, 2026:** `package.json` identifies the development
version as **1.1.0**. No compiled build has been published in
[GitHub Releases](https://github.com/globa-me/Screendance-App/releases) yet.
Download an application only from that official page when a release is present;
do not use files distributed by third parties.

The project page is available at
[globa-me.github.io/Screendance-App](https://globa-me.github.io/Screendance-App/).

## Install a compiled macOS build

Distribution targets Apple Silicon and Intel and requires Developer ID signing
and Apple notarization. The dual notarized local build (1.1.0) is ready in
`release/notarized-dual/` as of September 11, 2026.
Existing unsigned builds are not release candidates. See the current
[signing status and release checks](docs/releasing/macos-signing.md).

For a verified notarized release:

1. Download the `arm64` DMG for M-series Macs or the `x64` DMG for Intel Macs.
2. Open it and drag **Screendance App** to `Applications`.
3. Open the app and grant Screen & System Audio Recording and Accessibility
   permissions, plus Microphone and Camera when using those features.

## Build on your own Mac

Local development runs through `npm run dev`. Packaged builds require the
configured Developer ID certificate.

Prerequisites:

- macOS 14+ on Apple Silicon or Intel
- Xcode Command Line Tools: `xcode-select --install`
- CMake (required to stage both Whisper runtimes on a clean checkout)
- Node.js 22 LTS and npm (`node --version` should report v22)

```bash
git clone https://github.com/globa-me/Screendance-App.git
cd Screendance-App
git switch screendance/macos-apple-silicon
npm ci
npm run dev
```

For a packaged build, stop the development server and run:

```bash
npm run build:mac
```

The command produces separate `Screendance App-arm64.dmg` and
`Screendance App-x64.dmg` artifacts. Signing alone is insufficient for
distribution: follow the [notarization checklist](docs/releasing/macos-signing.md).

## Latest development updates

The working tree currently contains development work that is not yet a GitHub
release. It includes transparent WebM and ProRes 4444 export, alpha-safe canvas
handling for portrait output, post-transcode alpha validation, resilient
external-microphone selection and audio-level indicators, diagnostic logs,
configurable zoom defaults and smoother editor previews. It also adds global
source-selection/recording shortcuts and reduces repeat macOS permission
prompts. New projects use the `.scrdance` extension, while existing `.recordly`
projects remain fully supported. The Extensions section is intentionally hidden
until it is redesigned. See [CHANGELOG.md](CHANGELOG.md) for the release-ready
history.

## Current Investigation Notes

The first bug being addressed is external microphone selection on macOS. The
original Recordly code passes Chromium's browser `deviceId` into the native
ScreenCaptureKit helper, but AVFoundation expects a different `uniqueID`. When
those identifiers do not match, ScreenCaptureKit silently falls back to the
default Mac microphone.

This fork starts by making the native helper resolve microphones more
defensively from the selected browser label, including labels that contain
extra parenthesized suffixes for duplicate devices.

## ProRes Export with Alpha Channel

The ProRes alpha path is intentionally conservative because Apple preview apps
can show a black matte even when FFmpeg reports that a file has an alpha plane.
Future changes to export/transcoding must preserve these rules:

- ProRes alpha exports must be QuickTime `.mov`, not `.mp4`.
- Use `prores_ks` with ProRes 4444 (`ap4h`) and an alpha-capable pixel format
  such as `yuva444p10le`.
- Do not force `-vendor apl0`. A previous regression did this and Quick Look
  displayed a black background around the content. The known-good files use
  FFmpeg's default `FFMP` stream vendor and `Lavc` frame vendor.
- On macOS, prefer the system FFmpeg for ProRes alpha when available. The known
  good sample was produced by FFmpeg 8.x (`Lavf62`/`Lavc62`); the bundled
  FFmpeg 6.1.1 path produced files that looked valid to `ffprobe` but did not
  preview transparently in Apple UI.
- Preserve BT.709 color metadata for ProRes alpha output.

Known-good reference behavior from June 17, 2026:

- `/Users/gennadiyzakharov/Downloads/mf0test1.mov` previews correctly in macOS
  Quick Look.
- `ffprobe` reports `codec_name=prores`, `profile=4444`,
  `codec_tag_string=ap4h`, `pix_fmt=yuva444p12le`, `vendor_id=FFMP`, and
  encoder `Lavc62... prores_ks`.
- `alphaextract` shows transparent matte areas as `YMIN=0`, `YMAX=0`.

Regression signature to avoid:

- Files can still report `prores (4444)` and `yuva444p12le` while Quick Look
  shows a black background. In the June 2026 regression, strings inside frames
  showed `apl0` instead of `Lavc`.

Useful checks:

```bash
ffprobe -hide_banner -show_streams -show_format -of json output.mov
ffmpeg -hide_banner -v error -i output.mov \
  -vf "alphaextract,signalstats,metadata=print:file=-" \
  -frames:v 5 -f null -
strings -a output.mov | rg 'Lavc|apl0|ap4h|colr|nclc|nclx'
```

Relevant code:

- `electron/ipc/nativeVideoExport.ts`: `buildNativeProresAlphaExportArgs`
- `electron/ipc/register/export.ts`: ProRes alpha FFmpeg binary selection,
  temp-file finalization, and forced `.mov` output
- `src/lib/exporter/modernVideoExporter.ts`: direct alpha ProRes export path

## Screenshots

<p align="center">
  <img src="docs/media/editor-background.png" alt="Screendance App editor with background, frame, and timeline controls" width="900" />
</p>

<p align="center">
  <img src="docs/media/editor-captions.png" alt="Screendance App editor with caption controls and timeline" width="900" />
</p>

## Project history and original project

Screendance App was created from Recordly commit
[`67a83ca`](https://github.com/webadderallorg/Recordly/commit/67a83ca).
Recordly remains the original project; its complete pre-fork history is in the
[Recordly commit log](https://github.com/webadderallorg/Recordly/commits/main).

The Screendance history is documented in [CHANGELOG.md](CHANGELOG.md), with
links to every fork commit and an explicit **In development** section for work
not yet published as a release. The complete post-fork commit log is also
available on [GitHub](https://github.com/globa-me/Screendance-App/commits/screendance/macos-apple-silicon).

## License

This fork inherits Recordly's license terms. See [LICENSE.md](LICENSE.md).
