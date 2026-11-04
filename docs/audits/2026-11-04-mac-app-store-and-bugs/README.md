# Аудит 1.7.1: баги и препятствия для Mac App Store

Дата: 4 ноября 2026. Ветка `screendance/window-close-pause`, версия 1.7.1.
Продолжение аудита [2026-10-26-mac-app-store](../2026-10-26-mac-app-store/README.md)
(версия 1.6.0) — здесь перепроверено, что из него ещё актуально, и добавлены
новые находки. Код не изменялся. `npx tsc --noEmit` — без ошибок;
`npm run lint` — 324 ошибки / 27 предупреждений (в основном форматирование и
порядок импортов, плюс 27 `useExhaustiveDependencies` в `VideoPlayback.tsx` /
`VideoEditor.tsx`). Полный `npm test` не запускался.

## Часть A. Mac App Store

### Жёсткие блокеры (без них подача бессмысленна)

| # | Проблема | Где | Статус vs 26.10 |
|---|---|---|---|
| A1 | **FFmpeg собран с `--enable-nonfree`** («not legally redistributable»). Касается не только MAS, но и уже опубликованных DMG/ZIP 1.7.0/1.7.1. | `node_modules/ffmpeg-static/ffmpeg` (arm64 6.0), `scripts/stage-macos-ffmpeg.mjs`; подтверждено в `release/notarized-v1.7.1/mac-arm64` | **Не исправлено** |
| A2 | **AGPLv3-форк Recordly** — условия App Store конфликтуют с AGPL; нужно разрешение правообладателей Recordly (webadderall) на распространение через MAS. Сам владелец форка этого решить не может. | `LICENSE.md` | Не решено |
| A3 | **Обои — по виду копии фирменных обоев Apple** (`sonoma-*`, `sequoia-*`, `ventura*`, `tahoe-*`, `ipad-17-*`; визуально проверены `sonoma-horizon`, `tahoe-light`). Использование изображений Apple — частая причина отказа (5.2.x) и риск само по себе. Происхождение `wallpaper*.jpg`, `luisdelrio.jpg` и др. тоже не задокументировано. | `public/wallpapers/` | Новое (в 26.10 — только «нужна инвентаризация») |
| A4 | **Нет App Sandbox и MAS-таргета**: только Developer ID, DMG/ZIP; в entitlements нет `com.apple.security.app-sandbox`, `cs.disable-library-validation`, `allow-unsigned-executable-memory` и т. п. рассчитаны на внешнее распространение. | `electron-builder.json5`, `build/entitlements.mac*.plist` | Не начато |
| A5 | **Запись требует Accessibility** — в sandbox недоступно. | `src/hooks/useScreenRecorder.ts:591-607`; `AXUIElement*` в `recordly-native-cursor-monitor` | Не исправлено |
| A6 | **`uiohook-napi` использует активный `CGEventTap` (`kCGEventTapOptionDefault`) + `AXIsProcessTrustedWithOptions`** — в sandbox не работает; нужен свой listen-only tap + Input Monitoring, запись не должна зависеть от отказа. | `node_modules/uiohook-napi/libuiohook/src/darwin/input_hook.c:1179`, `electron/ipc/cursor/interaction.ts` | Не исправлено |
| A7 | **Загружаемые расширения исполняют JS** (`import()` в renderer) — правило 2.5.2. Для MAS — выключить установку расширений полностью (UI, IPC, automation). | `electron/extensions/*`, `src/lib/extensions/extensionHost.ts` | Не исправлено |

### Нужно адаптировать (устранимо)

- **`osascript … tell application … to activate`** — Apple Events к чужим
  приложениям в MAS недопустимы → `NSRunningApplication.activate` через helper.
  `electron/ipc/register/sources.ts:149`.
- **Системные FFmpeg/FFprobe/whisper из Homebrew** (`/opt/homebrew/bin`, `which`)
  в sandbox недоступны; для ProRes alpha сейчас предпочитается системный FFmpeg —
  в MAS-сборке нужен свой проверенный бинарник с сохранением guardrail Quick Look.
  `electron/ipc/ffmpeg/binary.ts:50-110`, `electron/ipc/captions/generate.ts:40-43`.
- **Нет security-scoped bookmarks**: `recordingsDir`, recent projects, связанные
  video/webcam/audio хранятся как пути — после перезапуска в sandbox доступа не будет.
  `electron/ipc/utils.ts:91-110`, `electron/ipc/constants.ts:11`.
- **CLI/MCP**: symlink в `~/.local/bin` (`cli/install.ts`), сокет в `os.tmpdir()`/`/tmp`
  (`electron/automation/socketServer.ts:161-164`) — внешний клиент не достучится
  до контейнера. Для первой MAS-версии разумно исключить automation.
- **electron-updater** должен быть исключён из MAS-сборки целиком, включая UI;
  `isAutoUpdateFeatureEnabled()` уже проверяет `process.mas` (`electron/updater.ts:129`).
- **Loopback-серверы** (`mediaServer.ts`, `rendererServer.ts`) потребуют
  `network.server`/`network.client` entitlements.
- Встроенные helper-бинарники (`electron/native/bin/darwin-arm64/*`, whisper,
  ffmpeg/ffprobe, `Contents/MacOS/screendance`) нужно подписать с
  `app-sandbox` + `inherit`. `whisper-bench`/`whisper-quantize` в продукте, судя по
  всему, не нужны — убрать из пакета. Пакет `capturekit` в зависимостях не используется.

### Метаданные и Info.plist

- **`NSBluetoothAlwaysUsageDescription` / `NSBluetoothPeripheralUsageDescription`
  = «This app needs access to Bluetooth»** (дефолт Electron) — Apple отклоняет
  расплывчатые purpose strings (5.1.1). Убрать или написать конкретную причину.
- `LSApplicationCategoryType = public.app-category.developer-tools` — для
  скринрекордера логичнее `public.app-category.video` или `productivity`.
- `com.apple.security.device.audio-input` лежит в `extendInfo` (Info.plist) —
  это entitlement, в Info.plist он бесполезен.
- **About показывает версию «1.1»** вместо 1.7.1 (`electron/main.ts:957-958`) и не
  содержит атрибуции Recordly/OpenScreen, которой требует `LICENSE.md:12`.
- Нет Privacy Policy (в приложении и для App Store Connect), нет bundled
  license notices (`*.md` исключены из пакета в `electron-builder.json5:30`).

## Часть B. Баги

Найдены код-ревью агентом, ключевые (B1–B4, B6, B16) перепроверены вручную.

### Высокая важность (безопасность)

- **B1. Песочница расширений не работает.** `src/lib/extensions/extensionHost.ts:52-78`:
  свойство `window.electronAPI` от `contextBridge` неконфигурируемое, поэтому
  proxy никогда не устанавливается; к тому же блокировка действует только во
  время `import()`/`activate()`, а не в колбэках. Любое расширение получает
  полный `electronAPI`. Исправление: изолировать расширения (worker/iframe + bridge).
- **B2. Запуск произвольного бинарника из renderer.** `generate-auto-captions`
  принимает `whisperExecutablePath` и передаёт в `execFile` после проверки «файл
  исполняемый» (`electron/ipc/captions/generate.ts`, `register/captions.ts:182`).
  В main разрешать только встроенный runtime или путь, выбранный через диалог.
- **B3. Запись файлов в любое место.** `write-exported-video-to-path`
  (`register/export.ts:1241-1256`) пишет в любой `path.resolve(outputPath)`;
  `save-exported-video` с `outputPath` обходит диалог (`:1190`);
  `store-recorded-video` делает `path.join(recordingsDir, fileName)` без
  `basename` → `../` выходит из папки (`register/recording.ts:1967-1970`);
  `store-microphone-sidecar` пишет рядом с любым путём (`:1834`).
- **B4. Чтение любого файла.** `read-local-file` (`register/assets.ts:110-125`)
  читает любой файл; `set-current-video-path` (`register/project.ts:600-608`)
  одобряет произвольный путь, после чего его раздаёт media server.

### Средняя

- **B5. Media server отдаёт файлы любому сайту**: `Access-Control-Allow-Origin: *`,
  без токена, любой HTTP-метод (`electron/mediaServer.ts:104-108`). Убрать CORS,
  добавить токен на запуск, только GET/HEAD.
- **B6. Очистка в `before-quit` выполняется, даже если выход отменён** диалогом
  несохранённых изменений (`electron/main.ts:988-994`): глобальные шорткаты
  снимаются, идущий нативный экспорт убивается, `ownedExportPaths` очищаются.
  Перенести в `will-quit` или выполнять после подтверждения выхода.
- **B7. Выход/обновление во время записи на macOS оставляет ScreenCaptureKit
  helper работать**: `before-quit` его не останавливает, а цикл в
  `ScreenCaptureKitRecorder.swift:1140-1165` при закрытии stdin не вызывает
  `service.stop()`. MP4 не финализируется, захват продолжается.
- **B8. Гонка двух быстрых `start recording`** (`register/recording.ts:734-746`,
  `976-985`): второй вызов считает первый «зависшим» и убивает его helper, а
  обработчик ошибки первого обнуляет состояние второго. Нужен лок «starting» и
  сброс состояния только для своего процесса.
- **B9. Сессии нативного экспорта переживают окно редактора**
  (`register/export.ts:559-700, 741`): при reload/падении renderer FFmpeg и temp-файлы
  висят до выхода. Чистить по `destroyed` / `render-process-gone`.
- **B10. Нет защиты навигации**: `webSecurity:false` без `will-navigate` /
  `setWindowOpenHandler`; обработчики разрешений выдают камеру/микрофон любому
  origin, `setDevicePermissionHandler` всегда `true` (`windows.ts:392, 777`;
  `main.ts:1028-1037`).

### Низкая

- **B11.** Пропавшее окно-источник молча превращается в запись всего экрана:
  fallback на `sources[0]` (`main.ts:1180`).
- **B12.** Вывод helper копится всю запись (`AUDIO_LEVEL` ~12/с), а stdout/stderr
  делят один буфер строк — токен `SOURCE_UNAVAILABLE_PAUSED` может склеиться и
  потеряться (`register/recording.ts:838-850`).
- **B13.** Ключ кэша миниатюр — base64 полного пути → `ENAMETOOLONG` при путях
  длиннее ~180 символов (`register/assets.ts:34`). Использовать SHA-256.
- **B14.** Папки `mkdtemp` экспорта не удаляются после finalize/discard
  (`export/exportStream.ts:63`).
- **B15.** `ipcMain.once("save-before-close-done")` принимает ответ от любого окна;
  повторные закрытия копят слушатели (`main.ts:898`).
- **B16.** About: жёстко «1.1» (`main.ts:957`) → `app.getVersion()`.
- Мусор в корне: `test_transcode_ks.mov` (310 МБ, не в git).

## Статус исправлений B1–B5 (4 ноября 2026)

Изменения в рабочем дереве, не закоммичены. Проверка: `npx tsc --noEmit` —
чисто; `npm test` — 1164 теста / 114 файлов, всё зелёное (+1 тест экспорта позже —
1165); новые тесты в `electron/securityBoundaries.test.ts` и
`electron/ipc/register/export.test.ts`. `npm run smoke:automation` (реальный
Electron, изолированный профиль) — пройден, заблокированных запросов нет;
сохранение экспорта через UI-диалог вручную не проверялось.

Важная находка при исправлении: окна HUD и редактора работают с
`webSecurity:false`, а значит любой код страницы (и расширения) мог читать
**любой** файл напрямую через `fetch("file://…")`, минуя IPC (проверено
экспериментом в Electron 39). Поэтому B4 закрыт на двух уровнях.

| # | Что сделано | Где |
|---|---|---|
| B2 | Свой путь к Whisper выполняется, только если пользователь выбрал его в диалоге main-процесса (список хранится в `userData/trusted-whisper-executables.json`) или он совпадает с автопоиском (встроенный, `WHISPER_CPP_PATH`, Homebrew). Явный `executablePath` из CLI/MCP по-прежнему доверенный; путь из снимка редактора — нет. Ранее выбранный вручную путь нужно выбрать заново. | `electron/ipc/captions/generate.ts`, `register/captions.ts`, `automation/jobMedia.ts` |
| B3 | Экспорт пишет только туда, что выбрано в `select-export-destination`/диалоге (или smoke-путь из env); допускается только исправление расширения на `.mov`/`.webm`. `store-recorded-video` берёт `basename`; mic-sidecar — только в папке записей; cursor telemetry — только рядом с открытым/записанным видео. | `electron/ipc/utils.ts` (`approveWriteDestination`, `isApprovedWriteDestination`, `isInsideRecordingsDir`), `register/export.ts`, `register/recording.ts` |
| B4 | Общее правило чтения `isRendererReadablePath`: папки приложения/одобренные пути, либо медиа/изображения/шрифты (оба пути — заявленный и реальный, против symlink). Применяется к `read-local-file` и ко **всем** `file://`-запросам окон через `webRequest`. Пути от renderer и из файлов проектов одобряются только если это медиафайлы. | `electron/fileAccessGuard.ts`, `mediaTypes.ts` (`isRendererMediaFile`), `register/assets.ts`, `register/project.ts`, `project/manager.ts`, `main.ts` |
| B5 | Медиасервер требует токен запуска (`&token=` в `buildMediaUrl`), отвечает только на GET/HEAD/OPTIONS, CORS — только для своего renderer-origin (packaged server или `VITE_DEV_SERVER_URL`), не `*`. | `electron/mediaServer.ts` |
| B1 | **Частично.** Полная изоляция (отдельный realm: worker/iframe + bridge) не сделана — это переделка API расширений (render hooks рисуют синхронно в canvas). Сделано: опасные возможности (B2–B4) закрыты в main; установка расширения из папки и из marketplace требует подтверждения в диалоге main-процесса; комментарий к нерабочему proxy-guard в `extensionHost.ts` исправлен (он не является границей безопасности). | `electron/extensions/extensionIpc.ts`, `src/lib/extensions/extensionHost.ts` |

Остаточные риски: расширение по-прежнему может читать медиафайлы пользователя
и вызывать функции редактора (сохранить проект, начать запись и т. д.).
Включить `webSecurity:true` и вынести расширения в изолированный realm —
отдельная задача с ручной проверкой превью, обоев и экспорта.

## Рекомендуемый порядок

1. **Сразу, независимо от App Store:** заменить nonfree FFmpeg (A1) — это
   юридическая проблема уже опубликованных релизов; исправить B1–B5 (B1 закрывает
   главный путь атаки); B6–B7 (потеря данных при выходе); B16 и Bluetooth-строки.
2. **Решить права:** письменное разрешение Recordly на MAS (A2) и замена/лицензии
   обоев (A3). Без A2 дальнейшая MAS-работа рискует быть напрасной.
3. **MAS-прототип** (`mas-dev`): sandbox, запись без Accessibility, listen-only tap,
   bookmarks, без расширений/CLI/updater. Оценка из аудита 26.10 (20–40 рабочих
   дней) остаётся в силе.
