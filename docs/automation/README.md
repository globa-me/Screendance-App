# CLI and MCP automation

## Current scope

Screendance App 1.6.0 implements stages 1–6 of the automation plan: **84 commands**
for recording, project/library operations, editor documents, preview, export,
captions/models, durable jobs, preferences, extensions, windows and diagnostics.
The authoritative command list and input schemas are `app.capabilities` (MCP
`app_capabilities`). [coverage.md](coverage.md) maps the application features;
[validation.md](validation.md) separates verified behavior from remaining tests.

The source implementation includes a native macOS CLI launcher and app-bundled
runtime. Development execution requires Node.js 22+; the packaged launcher uses
the app's Electron runtime and requires no separately installed Node. The current
1.6.0 arm64 and x64 apps passed full packaged smoke; both apps and DMGs are G2
signed, notarized/stapled and Gatekeeper-verified. Post-staple ZIP/mounted-DMG
checks and all nine final checksums passed. The x64 app ran via Rosetta on this
Apple Silicon Mac. These are local artifacts, not an externally published release
or an installation over the user’s app; see [validation.md](validation.md) and
the [1.6.0 release record](../releases/v1.6.0.md).

## Run locally

```sh
npm run build:automation
npm run dev:automation
# In another terminal:
node dist-automation/screendance.mjs --dev app capabilities --json
node dist-automation/screendance.mjs --dev project open '/absolute/path/demo.scrdance'
node dist-automation/screendance.mjs --dev call editor.get
node dist-automation/screendance.mjs --dev preview render --time-ms 1000 --output '/absolute/path/new.png'
```

Enable the host explicitly with `--automation` or `SCREENDANCE_AUTOMATION=1`.
Normal launches expose no host. `--launch '/Applications/Screendance App.app'`
allows the CLI to launch that application with automation enabled, or signal its
existing instance. The app must contain this implementation.

All 84 commands support `call METHOD --params JSON` and `call METHOD
--params-file PATH`; parameter files are bounded at 16 MiB. For example:

```sh
node dist-automation/screendance.mjs --dev call settings.set --params '{"theme":"dark","locale":"ru"}'
node dist-automation/screendance.mjs --dev call jobs.list
```

Convenience commands include `project open PATH`, `video open PATH`, `project save
[--output PATH] [--overwrite]`, source/permission selection, recorder controls and
`preview render`. CLI convenience paths resolve relative to the caller's working
directory. Use absolute local paths inside JSON parameters.

## Packaged launcher and AI client setup

The packaging configuration places a universal native launcher at
`Screendance App.app/Contents/MacOS/screendance` and the bundled CLI/MCP program at
`Contents/Resources/automation/screendance.mjs`. The launcher resolves its own app
bundle, reads `CFBundleExecutable` and starts that Electron executable in Node mode.
Keep the launcher inside its app; copy/move the complete `.app` when relocating it.

Using the validated packaged application:

```sh
'/Applications/Screendance App.app/Contents/MacOS/screendance' install
# Adds only ~/.local/bin/screendance; add ~/.local/bin to PATH if necessary.
screendance --launch '/Applications/Screendance App.app' app status
screendance setup codex
screendance setup claude
```

`install --directory PATH` chooses a different link directory. `uninstall` removes
only a link pointing at this launcher; unrelated files/links are refused.
`setup codex|claude` **prints** a registration command with `applied:false`.
Neither setup nor installation edits client configuration. Execute the printed
registration command yourself when connecting the chosen client.

For development, registration commands use absolute paths to Node and the bundle:

```sh
codex mcp add screendance -- /absolute/path/to/node /absolute/path/to/repository/dist-automation/screendance.mjs --dev mcp serve
claude mcp add --transport stdio screendance -- /absolute/path/to/node /absolute/path/to/repository/dist-automation/screendance.mjs --dev mcp serve
```

For a particular instance, use `--endpoint /absolute/path/endpoint.json` instead
of `--dev`. MCP tool names replace dots with underscores (`editor.apply` becomes
`editor_apply`). Discovery works without a running app; calls then return
`APP_NOT_RUNNING`. The server needs no model/API key. Claude's MCP connection can
be verified without model login; model-driven calls require the client's own
working authentication. Existing client configuration is never edited by tests.

Setup references: [Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Command families

| Family | Commands / behavior |
| --- | --- |
| Application | `app.status`, `app.capabilities`, `app.windows`, `app.window`, `app.open`, `app.quit` |
| Projects | `project.list`, `project.open`, `project.inspect`, `project.save`, `project.rename`, `video.open` |
| Capture | `sources.list/select/highlight`, `devices.list`, `permissions.status/request`, `recording.status/configure/start/pause/resume/stop/cancel/recover` |
| Editor | `editor.get/apply/undo/redo/catalogs/presets/autoZoom` |
| Preview | `preview.control`, `preview.render` |
| Background work | `export.start/save`, `captions.generate`, `models.list/download/delete`, `jobs.list/get/wait/cancel/retry` |
| Preferences | `settings.get/set`, `settings.hud.get/set`, `settings.directories.get/set`, `shortcuts.get/set`, `fonts.list/add/remove`, `wallpapers.list/add/remove` |
| Extensions | `extensions.list/discover/install/uninstall/setEnabled`, `extensions.settings.get/set`, `extensions.marketplace.search/get/install` |
| Maintenance | `updates.status/check/download/install/defer/dismiss/skip/preview`, `diagnostics.get`, `logs.read/clear`, `clipboard.write`, `files.reveal`, `folders.open` |

Read capability schemas for action-specific arguments, bounds and defaults.
Mutation commands use explicit values; start/pause/resume and enable/disable do
not infer toggle intent.

## Document editing and history

`editor.get` returns the live persisted-document projection, current project and
source paths, dirty/readiness/history state, `revision` and `documentId`. The
snapshot contains `editor`, `exportPreferences` and `creationPreferences`.
Optional bounded cursor telemetry and `editor.catalogs` expose the available
assets, cursors and extension contributions.

Read the document immediately before a mutation. `editor.apply`, undo/redo,
auto-zoom and preset save/apply require `expectedRevision`; pass
`expectedDocumentId` too to detect a different loaded document. Revisions include
manual UI edits; document identity changes with document adoption. A stale
revision returns `REVISION_CONFLICT`; a changed document is refused rather than
applying edits to a different project. Refetch and reconsider the edit before
retrying. Revisions are local to the live editor, not durable project-file versions.

An apply batch contains up to 500 typed operations. Validation and media
preparation finish before one document/history commit. A failed operation leaves
the whole batch unapplied. Supported operations are `settings.patch`,
`export.patch`, `creation.patch`, `clips.split`, `clips.speed`, region
create/update/delete, and collection replace/reorder. Collections include clips,
trims, speed/zoom/annotation/audio regions and caption cues. Full document undo
and redo include scene, webcam, audio, caption styling and relevant preferences.
UI and automation share the document controller; transient selection/playback
controls do not create persisted history entries.

Time fields are integer milliseconds in the existing editor coordinates.
`clip.endMs` is a display-span endpoint; its source end is
`startMs + (endMs - startMs) * speed`. Focus/crop coordinates are 0–1;
annotation geometry and padding are percentages. Trims derive clips, so in a
batch clearing trims must precede supplying replacement clips. Local image and
external-audio inputs are prepared through main-process path approval; image
annotations are embedded as data URLs. Read the schemas and current snapshot
rather than inventing fields or coordinate conversions.

For example, substituting the fresh values from `editor.get`:

```sh
screendance call editor.apply --params '{"expectedRevision":12,"expectedDocumentId":"CURRENT_DOCUMENT_ID","operations":[{"op":"settings.patch","values":{"borderRadius":24,"cursorSize":2}}]}'
```

Presets expose list/get/save/apply/delete. Fresh recordings and `video.open` use
the last explicitly selected preset. Saved projects remain authoritative.
Webcam preset application preserves the incoming source/offset; session-level
cursor hiding remains stronger than preset visibility.

## Recording and project persistence

Recorder commands use the complete `useScreenRecorder` pipeline, including
countdown, native/browser capture, mic/webcam/cursor finalization and recovery.
Use exact source/device IDs from their lists. Configure while idle, then start;
stop waits for finalization and editor handoff. Inspect session `assetStatus`,
warnings and `editor.opened`. If an existing editor cannot adopt the new take,
the recording stays saved and the result describes the refused handoff.
Countdown cancellation settles the original start request. Discard-stop preserves
the previous editor context and only removes output owned by that recording.

Automation launches disable passive microphone/camera previews and permission
prompts. Explicit start/permission commands may acquire devices or open system
settings; macOS TCC still decides access. Device listing does not acquire devices.
A lost CLI/MCP connection does not stop a recording or its finalization.

Project/video open waits for source/composition readiness and refuses dirty work
or conflicting operations. Fresh imports are unsaved and must be saved before
another open/start. Supported project extensions are `.scrdance`/`.recordly`
version 1; video extensions are MP4/MOV/WebM/MKV/AVI, subject to existing decoders.

A first save needs an explicit absolute project path. Without a path, save writes
the trusted current project; replacing another existing file needs
`overwrite:true`. Existing parent directories, regular targets, canonical path
identity and no symlinks are enforced. Synced sibling-temp writes publish
atomically; new targets use exclusive creation. Only the captured snapshot becomes
the baseline, so later UI edits stay dirty. Rename uses this live save pipeline,
refuses a conflicting target and only removes the previous owned project after
successful persistence/context adoption. Inspect any error describing an already
written copy before retrying.

## Export, captions and durable jobs

`export.start` freezes the document, export preferences, source-audio settings and
media fingerprints, then returns a job ID promptly. Output requires an explicit
absolute path with matching `.mp4`, `.gif`, `.mov` or `.webm` extension. MOV/WebM
select transparent video settings; output encoding still follows the existing
export pipeline and platform capability checks. Export uses a dedicated frozen
renderer, so UI selection does not choose which clip's audio settings are used.
Changed/missing frozen media is refused. Existing outputs need `overwrite:true`;
publication checks target identity and refuses a competing writer.

```sh
screendance call export.start --params '{"outputPath":"/absolute/path/output.mp4","expectedRevision":12,"settings":{"quality":"good","mp4FrameRate":24}}'
screendance call jobs.wait --params '{"jobId":"RETURNED_JOB_ID","timeoutMs":10000}'
screendance call jobs.get --params '{"jobId":"RETURNED_JOB_ID"}'
```

Jobs persist private records/snapshots under the profile's `automation/jobs`.
States are queued/running/cancelling/succeeded/failed/cancelled/interrupted.
`jobs.wait` can wait for a revision change or terminal result for up to 60 seconds;
a wait/client timeout does not cancel work. A returned failed/cancelled job's
`error` is job metadata, not a protocol-call failure. Disconnects leave jobs
running. App restart marks unfinished jobs `interrupted`; it does not silently
restart output writes. `jobs.retry` explicitly creates a new job from the frozen
snapshot for failed/cancelled/interrupted work. Inspect existing outputs first.
Publication already committing cannot be cancelled.

If rendering finished but publication failed, `export.save` can publish the
retained finished artifact to a new explicit path without rerendering. Successfully
published artifacts are consumed; private job records remain available for inspection.

`captions.generate` freezes its source and uses the installed Whisper runtime and
selected model (or explicit local executable/model paths). With `apply:true`,
application checks the originating document ID, source and revision before
atomically applying cues and enabling captions. Conflicting edits preserve the
job's generated result without replacing newer document work. `models.list` is
passive; download/delete act only on the managed supported `small` model.
A job and a client command have separate lifetimes and deadlines.

## Preferences, extensions and maintenance

Provider-backed theme/locale/shortcuts and declared extension settings synchronize
across live app windows. Custom wallpaper removal unregisters its entry without
deleting source media. Custom font registration uses an HTTPS Google Fonts
stylesheet. Recording-directory changes affect future takes and do not move files.

Extension installation is explicit executable-code installation. Local folders and
catalog-selected marketplace IDs reuse the app's installer; replacement requires
`overwrite:true`, built-ins cannot be uninstalled, and marketplace enablement
defaults to true. Installation is transactional, validates matched manifests,
bounds archive size/file count, and rejects traversal/symlinks/special files.
Only declared settings fields/types/ranges are writable. There is no generic
JavaScript, shell, arbitrary IPC or undeclared extension-action endpoint.
Hidden marketplace administration/review endpoints are outside the app-user contract.

Window close, quit and update installation refuse unsaved work or active jobs,
recording, loading, saving, caption generation or export. Updater commands use
the configured application feed; download and install remain distinct actions.
Logs expose bounded fixed-catalog tails (at most 64 KiB) with credential redaction;
log clear targets only the application log. Finder/clipboard commands use their
explicit path/text or managed-folder arguments.

## Local transport, errors and ownership

Default endpoints are `~/Library/Application Support/Screendance App/automation/endpoint.json`
and the Vite profile `Screendance App-dev/automation/endpoint.json`. Select another
with `--endpoint` or `SCREENDANCE_AUTOMATION_ENDPOINT`. For isolated tests,
`SCREENDANCE_USER_DATA_DIR` redirects application and Chromium storage.

The host uses a private authenticated Unix socket, no network listener.
Descriptor/socket/lock modes are 0600; containing directories are 0700 and must
belong to the current user without symlinks. Exclusive lifetime locking prevents
duplicate owners and recovers dead-owner locks. Tokens must never enter logs/Git.
Requests are newline-delimited JSON `{id,method,params,protocolVersion,token}`,
bounded at 16 MiB; responses at 24 MiB. This is same-user local access, not a
sandbox against code already running as that account.

Editor/recorder/system mutations serialize and reject conflicting work with
`BUSY`; queries and job observation remain available. Request IDs are correlation
IDs, not a generic idempotency guarantee. After an ambiguous timeout/lost reply,
inspect state/jobs before retrying a mutation; adapters do not silently replay it.

CLI `--json` emits compact JSON; protocol failures use
`{"error":{"code":"...","message":"..."}}`. Exit codes: 0 success, 1 operation
failure, 2 invalid arguments, 3 unavailable endpoint/app, 4 denied access, 5 timeout.
Default client timeout is 120 seconds; `--timeout-ms` accepts 1–600000 and changes
the client wait, not desktop job deadlines. MCP stdout contains protocol only.

## Code ownership and verification

- `shared/automation.ts` registers contracts from `editorAutomation.ts`,
  `jobAutomation.ts`, `systemAutomation.ts`; errors live in `automationErrors.ts`.
- `electron/automation/` owns transport/host, canonical files/atomic project saves,
  output publication, durable jobs/media workers, renderer job bridge and system services.
- `src/components/video-editor/automation/` owns persisted document/history,
  validation, project preparation and preview; `automationJobs/` runs frozen work.
- `src/components/launch/automation/` shares the complete recorder controller;
  `src/automation/useSystemAutomation.ts` connects live preferences/extensions.
- `electron/preload.ts` provides narrow trusted pending-request bridges.
- `cli/` owns the client/CLI/official SDK MCP adapter/install/setup;
  `scripts/build-automation-launcher.mjs` builds the universal native launcher.

```sh
npx tsc --noEmit
npm test
npm test -- electron/ipc/nativeVideoExport.test.ts electron/ipc/register/export.test.ts electron/ipc/export/native-video.test.ts
npm run build:automation
npx vite build --config vite.config.ts
npm run smoke:automation
node scripts/smoke-automation-upgrade.mjs
# Optional existing-grant synthetic native capture and actual authenticated Codex:
node scripts/smoke-automation.mjs --record --codex
# Packaged full upgrade smoke, after each architecture is built:
SCREENDANCE_SMOKE_APP='/absolute/path/Screendance App.app' node scripts/smoke-automation-upgrade.mjs
```

Smoke requires macOS desktop execution, FFmpeg/FFprobe on the orchestration PATH
(or `FFMPEG_PATH`/`FFPROBE_PATH`), and matching built app/CLI assets. Development
also needs installed Electron. Fixtures/profile/reports use ignored
`.tmp/automation-*`; never use a person's live profile/media. The upgrade smoke's
caption executable/model are explicitly fake test fixtures; actual speech
recognition quality and physical camera/mic capture are separate validation.
Packaged smoke invokes the bundled CLI/MCP directly with `PATH=/usr/bin:/bin`.
An x64 app run on Apple Silicon is Rosetta coverage, not physical Intel coverage.
See [validation.md](validation.md) for actual runs and remaining manual hardware checks.
