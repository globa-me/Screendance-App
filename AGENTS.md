# Agent Notes

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

The supported target is macOS 14+ with separate `arm64` and `x64` artifacts.
Do not return the builder, Swift helper build, or Whisper runtime build to an
arm64-only default. Intel requires freshly built `darwin-x64` helpers and a
matching Whisper runtime.

`ffmpeg-static` is staged as a universal macOS executable before packaging.
FFprobe must remain packaged for both Darwin architectures; excluding
`node_modules/ffprobe-static/bin/darwin/**` makes recording validation and native
export fail on a clean Mac.

For a dual local release, use `npm run build:mac`, then run packaged smoke once
per app root with `PACKAGED_SMOKE_ARCH_TAGS=darwin-arm64` and `darwin-x64`.
After notarizing and stapling both DMGs, run:

```bash
node scripts/finalize-macos-release.mjs release/notarized-dual
```

The September 11, 2026 validation record and Apple submission IDs are in
`docs/releasing/macos-signing.md`.
