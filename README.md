# Screendance App

Screendance App is a macOS Apple Silicon-focused fork of
[Recordly](https://github.com/webadderallorg/Recordly).

The fork keeps Recordly's screen recording and editor workflow, but narrows the
target to modern macOS on Apple Silicon. The current priority is better native
ScreenCaptureKit capture, reliable external microphone selection, lower system
load during recording, and higher quality portrait exports.

## Scope

- macOS only
- Apple Silicon only (`arm64`)
- local unsigned builds, because this fork does not currently use a paid Apple
  Developer ID certificate
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
- `electron-builder.json5` defines the packaged app. In this fork it is limited
  to unsigned macOS `arm64` DMG/ZIP builds.

## Current version and download status

**Status on August 10, 2026:** `package.json` identifies the development
version as **1.1.0**. No compiled build has been published in
[GitHub Releases](https://github.com/globa-me/Screendance-App/releases) yet.
Download an application only from that official page when a release is present;
do not use files distributed by third parties.

The project page is available at
[globa-me.github.io/Screendance-App](https://globa-me.github.io/Screendance-App/).

## Install a compiled macOS build

Published builds target Apple Silicon (M1/M2/M3/M4 and newer) and are not yet
signed with an Apple Developer ID. After a release is available:

1. Download the `arm64` `.dmg` from the official
   [Releases](https://github.com/globa-me/Screendance-App/releases) page.
2. Open it and drag **Screendance App** to `Applications`.
3. Open the app once. If Gatekeeper blocks it, confirm that the file came from
   the official release, then open **System Settings → Privacy & Security**.
4. Scroll to the Screendance App warning, choose **Open Anyway**, then confirm
   **Open**. macOS shows this button only after the first blocked launch.
5. In **Privacy & Security**, allow **Screen & System Audio Recording** and
   **Accessibility**. Allow **Microphone** and **Camera** when using those
   features. Quit and reopen the app after enabling Screen Recording or
   Accessibility.

Do not disable macOS security globally. An unsigned-app warning is expected for
this project; the safe response is to verify the source and allow this specific
app in Privacy & Security.

## Build on your own Mac

Building locally is the most reliable way for a newcomer to avoid Gatekeeper
issues with an unsigned downloaded app.

Prerequisites:

- macOS 14+ on Apple Silicon
- Xcode Command Line Tools: `xcode-select --install`
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

The app is written to `release/mac-arm64/Screendance App.app`; the installable
disk image is `release/Screendance App-arm64.dmg`. If a locally built app still
has a quarantine attribute, use this command only for that known local app:

```bash
xattr -dr com.apple.quarantine "/Applications/Screendance App.app"
```

## Latest development updates

The working tree currently contains development work that is not yet a GitHub
release. It includes transparent WebM and ProRes 4444 export, alpha-safe canvas
handling for portrait output, post-transcode alpha validation, resilient
external-microphone selection and audio-level indicators, diagnostic logs,
configurable zoom defaults and smoother editor previews. It also adds global
source-selection/recording shortcuts and reduces repeat macOS permission
prompts. See [CHANGELOG.md](CHANGELOG.md) for the release-ready history.

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
