# Unreleased fixes after 1.7.0

Source changes on `screendance/macos-apple-silicon`, not yet versioned, built,
signed or released. The installed `/Applications/Screendance App.app` is still
the notarized 1.7.0 build.

Found on November 2, 2026: closing the window being recorded ended a ~10 minute
take without opening the editor. The files were on disk but unlinked (no
session manifest, mic left as `.mic.m4a`, screen cursor JSON missing), so the
take looked lost and would eventually be pruned. It was recovered by hand.

| Fix | Where | Behaviour |
| --- | --- | --- |
| Closed window pauses the take | `ScreenCaptureKitRecorder.swift` (window validation loop, `sourceUnavailable`, `streamStoppedBySystem`, `addStreamOutputs`), `register/recording.ts` (`SOURCE_UNAVAILABLE_PAUSED` line, resume refusal, switch clears the flag), `state.ts` (`nativeCaptureSourceUnavailable`, cleared by `setNativeCapturePaused(false)`), `recording/events.ts` (`emitRecordingSourceUnavailable` restores/shows the HUD), `useScreenRecorder` (`onRecordingSourceUnavailable` → normal `pauseRecording`, `liveCapture.sourceUnavailable`), `LaunchWindow.tsx` (opens the paused source picker) | The helper no longer prints `WINDOW_UNAVAILABLE` and exits. It pauses itself, prints `SOURCE_UNAVAILABLE_PAUSED` and stays alive. Resume is refused (helper prints `RESUME_REFUSED_SOURCE_UNAVAILABLE`; main returns `sourceUnavailable: true`) until `switch_source` succeeds. If ScreenCaptureKit stopped the stream with its window, `switch_source` builds a new `SCStream` with the same configuration and outputs; the writers continue. Stop works as usual. |
| Recovery after any helper exit | `useScreenRecorder` `onRecordingInterrupted` | `recoverNativeRecordingSession()` now also runs for `window-unavailable` (it used to be skipped), so a crashed or old helper still yields an opened editor with webcam, mic and cursor. The reselect prompt only appears when recovery finds nothing. |
| Unsaved changes before opening | `main.ts` (`confirm-replace-unsaved-document`), `VideoEditor.confirmReplaceCurrentDocument` | Opening a project from the Projects popover, or a video, asks Save & Open / Discard & Open / Cancel when the current document is dirty. Previously it was replaced silently. |
| One microphone sidecar | `recording/diagnostics.ts` `getUsableCompanionAudioCandidates` | When a role exists under several layouts, only the preferred file is used (`.wav` > `.m4a` > `.webm`), so `.mic.m4a` next to `.mic.wav` no longer plays twice. |
| Open video from the editor | `main.ts` File → "Open Video…" (⌘⇧O, `menu-open-video`), Projects popover "Open video…", `VideoEditor.openFreshVideo` | `openFreshVideo` is the former automation `video.open` body, shared by automation, the menu and the popover: fresh preferences, session webcam/hidden ranges, last preset, auto zooms. |

Both `electron/native/bin/darwin-*/recordly-screencapturekit-helper` binaries
were rebuilt from the new Swift source by `npm ci` (postinstall); both contain
`SOURCE_UNAVAILABLE_PAUSED`.

## Checks on November 3, 2026

- `npx tsc --noEmit` clean; `npm test` 113 files / 1154 tests passed (new
  `diagnostics.test.ts` case for `.mic.m4a` + `.mic.wav`).
- Helper alone (TextEdit window, arm64): close → `SOURCE_UNAVAILABLE_PAUSED`,
  helper alive, resume refused, `switch_source` to display 1 → resume → stop.
  Output contains window frames, then display frames; the pause is excluded.
  Same with a 25 s pause. Up to ~0.5 s of black can precede the pause because
  the window is polled every 500 ms.
- Dev Electron via CLI with an isolated profile (`.tmp`, deleted afterwards):
  start on a TextEdit window → close it → status `paused` → `recording resume`
  fails → `recording adjust --source screen:…` → resume → stop → editor opened
  with the video and cursor JSON. Repeated with a 2.5 min pause and with
  `sources list` while paused.
- In the first dev run the take was discarded about 100 s into the pause (stop
  plus deletion of the file, then `NOT_RECORDING`), which matches the HUD
  cancel action; it could not be reproduced. Not verified: the HUD toast and
  auto-opened source picker were not seen on screen (access to the dev window
  was declined), webcam/mic during the pause, x64 runtime, packaged app.

Still open (deferred by the owner): letterbox bars when switching to a window
of another aspect ratio, and black areas when a window resizes during capture.
MP4/AVAssetWriter cannot change frame size mid-file. Proposed fix: have the
helper report the content viewport on every switch and window resize, store a
`{timeMs, viewport}` timeline in the session manifest and project, and make the
crop time-dependent in preview, the three exporters and cursor/webcam/highlight
projection (about 16 files use `cropRegion`). Optionally start window captures
at full display resolution so letterboxed windows are not downscaled.
