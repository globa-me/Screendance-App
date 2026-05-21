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

## Build

Prerequisites:

- macOS 14+
- Apple Silicon Mac
- Xcode Command Line Tools
- Node.js/npm

```bash
npm install
npm run dev
```

For a packaged unsigned macOS build:

```bash
npm run build:mac
```

If macOS quarantines a local unsigned build:

```bash
xattr -rd com.apple.quarantine "/Applications/Screendance App.app"
```

## Current Investigation Notes

The first bug being addressed is external microphone selection on macOS. The
original Recordly code passes Chromium's browser `deviceId` into the native
ScreenCaptureKit helper, but AVFoundation expects a different `uniqueID`. When
those identifiers do not match, ScreenCaptureKit silently falls back to the
default Mac microphone.

This fork starts by making the native helper resolve microphones more
defensively from the selected browser label, including labels that contain
extra parenthesized suffixes for duplicate devices.

## License

This fork inherits Recordly's license terms. See [LICENSE.md](LICENSE.md).
