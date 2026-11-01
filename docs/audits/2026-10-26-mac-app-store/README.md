# Готовность Screendance к Mac App Store

Дата проверки: 26 октября 2026 года. Версия в рабочем дереве и проверенных
локальных release-приложениях: **1.6.0**.

## Решение

**Текущий выпуск не готов к отправке. Технически отдельная версия для Mac App
Store возможна, но сначала нужно устранить подтвержденную проблему FFmpeg и
разрешить вопрос прав на распространение AGPL-форка через магазин.**

Основная запись через ScreenCaptureKit и использование Electron сами по себе
не исключают Mac App Store. Это будет отдельный канал сборки с адаптацией
системных функций, а не переподпись существующего DMG.

## Объем и границы проверки

- Изучены исходники, зависимости, конфигурация упаковки/подписи и официальная
  документация Apple, Electron и FFmpeg.
- Проверены entitlements готового arm64-приложения и фактические FFmpeg/FFprobe
  в локальных приложениях `release/notarized-v1.6.0-automation/mac-arm64/` и
  `release/notarized-v1.6.0-automation/mac/` (второе — x64).
- Read-only `security find-identity -v -p codesigning` подтвердил наличие
  действующей identity **Apple Distribution: Gennadiy Zakharov (BN3D9H4C7J)**.
  Developer ID G2 также присутствует, но относится к внешнему распространению.
- Существующее рабочее дерево содержит много изменений разработки 1.6.0;
  проверка не является аудитом только последнего коммита.
- App Store Connect, права аккаунта, договоры, доступность имени приложения,
  provisioning profiles и installer certificate не проверялись.
- Настоящая MAS/mas-dev-сборка, запись из sandbox, Transporter validation и
  App Review не выполнялись. Одобрение магазина не подтверждено.
- Код и подписанные приложения не изменялись. Добавлен только этот отчет.
  Тесты приложения не запускались: изменения кода в рамках проверки отсутствуют.

## 1. Подтвержденный блокер: распространяемый FFmpeg с nonfree

В **обоих** проверенных `.app` файл
`Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg` —
universal executable с двумя существенно разными частями:

| Архитектура FFmpeg | Результат проверки |
| --- | --- |
| arm64 | FFmpeg 6.0; `--enable-gpl --enable-version3 --enable-nonfree`; присутствуют libx264/libx265 |
| x86_64 | FFmpeg 6.1.1-tessus; GPLv3+; `--enable-gpl --enable-version3`, без nonfree |

Arm64 `ffmpeg -L` выводит:

> This version of ffmpeg has nonfree parts compiled in. Therefore it is not legally redistributable.

Официальная [лицензия FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md#incompatible-libraries)
объясняет результат `--enable-nonfree`. Это проблема **любого распространения**,
включая DMG/ZIP. Подпись и нотарификация ее не устраняют. Наличие universal
FFmpeg означает, что проблемная часть входит также в x64-приложение.

Источник в процессе сборки:
[scripts/stage-macos-ffmpeg.mjs:16](../../../scripts/stage-macos-ffmpeg.mjs)
скачивает две части и объединяет через `lipo`, не проверяя их лицензии/флаги.
Нельзя ориентироваться только на лицензию npm-обертки.

Для следующего выпуска нужен воспроизводимый, разрешенный к распространению
FFmpeg без nonfree. Для MAS стоит оценить LGPL-вариант без GPL-компонентов и
системные VideoToolbox-кодеки; пригодность всех нужных фильтров и кодеков еще
не проверена. [Разъяснение FFmpeg](https://ffmpeg.org/legal.html).

Нельзя исправлять существующие нотарифицированные `.app` на месте. Выпускать
новые сборки и заново проходить подпись/проверки. Любая замена FFmpeg должна
сохранить ProRes 4444 alpha и поведение Finder/Quick Look по guardrail в AGENTS.md.

Дополнительно: проверенный arm64 FFprobe — LGPLv2.1+, x64 FFprobe — GPLv3+.
MIT-лицензия npm `ffprobe-static` не заменяет лицензию вложенного executable.
`uiohook-napi` имеет MIT-обертку, но включает libuiohook под LGPLv3.

## 2. Нерешенный вопрос прав: AGPLv3 и условия магазина

[LICENSE.md:1](../../../LICENSE.md) и
[README.md:191](../../../README.md) описывают Screendance как AGPLv3-форк
Recordly от `67a83ca`, с наследием OpenScreen. В проекте не обнаружено
отдельного разрешения для MAS или альтернативной лицензии на изменения Recordly.
MIT-уведомление OpenScreen в конце LICENSE.md не переводит весь форк под MIT.

Сам AGPL допускает продажу копий. Существенны требования corresponding source
и отсутствие дополнительных ограничений прав получателя (разделы 6 и 10).
Публикация исходников сама по себе не закрывает вопрос условий магазина.

[FSF описывает конфликт GPL/AGPL и App Store](https://www.fsf.org/blogs/licensing/more-about-the-app-store-gpl-enforcement),
но это **историческая позиция 2010 года**, а не новая проверка условий MAS 2026.
Текущая [Apple Standard EULA](https://www.apple.com/legal/internet-services/itunes/dev/stdeula/)
содержит исключение для open-source компонентов, одновременно сохраняя ограничения
передачи приложения; применимы также
[Media Services Usage Rules](https://www.apple.com/legal/internet-services/itunes/us/terms.html).

Статус: **существенный нерешенный лицензионный вопрос**, а не утверждение, что
Apple запрещает любое open-source или любое AGPL-приложение. До серьезной
MAS-разработки нужна оценка применимых условий и необходимых прав; при
необходимости — разрешение/исключение от всех соответствующих правообладателей.
Нельзя самостоятельно заменить лицензию чужих изменений. Custom EULA тоже
нельзя считать автоматическим решением.

Отдельно не подтверждены права на все распространяемые изображения/обои и
другие медиаресурсы. Имена вроде Sonoma/Tahoe сами по себе не доказывают нарушение;
нужна инвентаризация происхождения и лицензий, прежде чем подавать приложение.

## 3. Подтверждено: текущая упаковка не MAS и не App Sandbox

[electron-builder.json5:46](../../../electron-builder.json5) настроен на
Developer ID G2, DMG и ZIP для arm64/x64. Целей `mas`/`mas-dev`, отдельных MAS
entitlements и provisioning configuration нет. Custom signing scripts
намеренно проверяют G2 identity.

В [build/entitlements.mac.plist](../../../build/entitlements.mac.plist) и
`entitlements.mac.inherit.plist` нет `com.apple.security.app-sandbox`.
Read-only `codesign` подтвердил отсутствие этого entitlement и у готового
arm64-приложения 1.6.0. Hardened Runtime не заменяет App Sandbox.

Для магазина нужен отдельный MAS Electron и отдельная конфигурация подписи.
Это соответствует [официальному руководству Electron](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
и [руководству electron-builder](https://www.electron.build/docs/mas/).
Нужно отдельно проверить entitlement inheritance у Swift helpers, FFmpeg,
FFprobe и Whisper. Встроенные helper executables допустимы при корректном
устройстве sandbox; они не являются самостоятельным запретом MAS.

Наличие Apple Distribution уменьшает работу по настройке аккаунта, но не
доказывает готовность provisioning profiles, `.pkg` и App Store Connect.
Существующий `GZB-notary` относится к внешнему каналу; он не отправляет сборку
на App Review.

## 4. Accessibility и управление чужими приложениями нужно адаптировать

[src/hooks/useScreenRecorder.ts:553](../../../src/hooks/useScreenRecorder.ts)
делает доверенный Accessibility обязательным условием начала записи.
[NativeCursorMonitor.swift:149](../../../electron/native/NativeCursorMonitor.swift)
использует `AXUIElement*` для анализа чужого UI.

Apple перечисляет assistive Accessibility и Apple Events к произвольным
приложениям среди несовместимых с sandbox функций:
[Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox).
Нужен путь записи без обязательного AX gate и соответствующего AX fallback.

[electron/ipc/register/sources.ts:44](../../../electron/ipc/register/sources.ts)
поднимает выбранное чужое приложение через `osascript` / `tell application`.
Этот сценарий также требует замены; кандидат — публичный
`NSRunningApplication.activate` через native bridge, с проверкой поведения.

В `electron/ipc/cursor/interaction.ts:175` загружается `uiohook-napi`.
Его `libuiohook/src/darwin/input_hook.c:1151` использует active event tap,
а `input_helper.c:43` — Accessibility-проверку. Совместимость такого пути с MAS
не подтверждена. Для нужных кликов/клавиш стоит проверить минимальный
`listenOnly` tap и Input Monitoring. [Apple DTS](https://developer.apple.com/forums/thread/724608)
показывает sandboxed-пример такого наблюдения; это не гарантия для нашего hook.

В собственных Swift helpers подтвержденных private APIs не найдено.
ScreenCaptureKit и `NSCursor.currentSystem` публичны. Production fallback на
runtime-компиляцию Swift уже запрещен проверкой `app.isPackaged` в
`electron/ipc/paths/binaries.ts:187`. `capturekit` установлен, но использования
в исходниках приложения не найдено; состав MAS-пакета стоит минимизировать.
Полного анализа символов всех сторонних бинарников этот аудит не заменяет.

## 5. Доступ к файлам сейчас сохраняет пути, а не sandbox-доступ

[electron/ipc/register/project.ts:279](../../../electron/ipc/register/project.ts)
показывает выбор папки, но
[electron/ipc/project/manager.ts:247](../../../electron/ipc/project/manager.ts)
сохраняет только `recordingsDir`. Recent projects также хранят пути;
проект ссылается на внешние video/webcam/audio-файлы.

В коде не обнаружены `securityScopedBookmarks` или
`startAccessingSecurityScopedResource`. Собственный `approvedLocalReadPaths` —
проверка доверия приложения, а не разрешение macOS.

Нужно сохранять и восстанавливать security-scoped bookmarks для внешних файлов
и папок, включая связанные media и повторное открытие после перезапуска.
Передачу доступа дочерним процессам проверить отдельно: см.
[Apple file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox?language=objc)
и [sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).
Старый профиль внешней версии требует отдельного сценария миграции в container.

`electron/mediaServer.ts:217` и `rendererServer.ts:119` слушают loopback TCP.
Для MAS необходимо проверить server/client network entitlements, включая
доступ renderer к локальному серверу. Это устранимая настройка, не запрет.

Системные FFmpeg/FFprobe fallback в `electron/ipc/ffmpeg/binary.ts:50` также
нельзя считать рабочими в sandbox. MAS должна проходить экспорт с собственными
проверенными бинарниками без Homebrew и других внешних установок.

## 6. Расширения и CLI/MCP требуют отдельного решения для MAS

[electron/extensions/extensionLoader.ts:351](../../../electron/extensions/extensionLoader.ts)
устанавливает расширения с диска;
`electron/extensions/extensionMarketplace.ts:183` скачивает и устанавливает
архивы; [src/lib/extensions/extensionHost.ts:213](../../../src/lib/extensions/extensionHost.ts)
исполняет их через dynamic `import()` и выдает API редактора.
Отсутствие настроенного marketplace URL не отключает локальную установку.

Текущий механизм добавляет исполняемую функциональность после выпуска.
Его совместимость с правилами 2.4.5/2.5.2 не подтверждена. В правилах 4.7 есть
отдельный путь для некоторых plug-ins с дополнительными условиями; его
применимость к текущему host не исследована и не должна подразумеваться.
Для первого MAS-выпуска практичнее включать нужные функции в bundle, исключив
установку внешних расширений из UI, IPC и automation capabilities.
[Правила Apple](https://developer.apple.com/app-store/review/guidelines/).

[cli/install.ts:10](../../../cli/install.ts) создает symlink в `~/.local/bin`.
`cli/client.ts:35` ожидает endpoint во внешнем Application Support, а
`electron/native/automation-launcher/main.swift:29` запускает Electron как Node.
Полный сценарий внешнего MCP-клиента в MAS не проверен. Встроенный CLI не
запрещен автоматически, но установка за пределами container и доступ внешнего
клиента требуют другого решения. Для начального MAS-выпуска разумно оставить
CLI/MCP в Developer ID-канале до отдельного sandbox-прототипа.

Обновления уже частично подготовлены: `electron/updater.ts:127` проверяет
`!process.mas`. При MAS-сборке следует также исключить недоступный updater из
интерфейса и проверить feature flags (`isAutoUpdateFeatureEnabled` сам не
проверяет `process.mas`). Правило Apple 2.4.5(vii) оставляет обновления магазину.

## 7. Privacy, лицензии в приложении и метаданные

В исходниках не найдены текст/ссылка Privacy Policy. Она потребуется в самом
приложении и в App Store Connect (5.1.1). Отдельно описать запись экрана,
микрофон/камеру, cursor/keystroke telemetry, локальную обработку и сетевые
запросы, включая загрузку модели Whisper. Проверить явное согласие и видимый
индикатор записи во всех режимах UI/automation по 2.5.14.

Не следует автоматически выбирать «Data Not Collected» без инвентаризации:
сам факт локальной обработки еще не описывает поведение всех сетевых сервисов.
Скачивание весов Whisper не приравнивалось в этом аудите к скачиванию executable;
нужно отдельно проверить пользовательский download flow, размер и работу offline.

В source/final bundles не обнаружен собственный `PrivacyInfo.xcprivacy`.
Это **не объявлено самостоятельным универсальным macOS-блокером**:
[Apple privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files?trk=public_post_comment-text)
различает данные на всех платформах и required-reason API для перечисленных
мобильных платформ. Обязанности конкретных SDK и валидность содержащихся
manifest-файлов проверяются по фактическому составу MAS-пакета.

`electron-builder.json5:30` исключает корневые Markdown notices; inventory
готового arm64 `app.asar` не обнаружил собственного LICENSE/AGPL/credits файла.
`electron/main.ts:932` показывает About с устаревшей версией `1.1` и только
Zakharov Asia. README credits не заменяют видимую UI-атрибуцию, которую явно
требует `LICENSE.md:12`. Требуются bundled notices, About/Credits и доступ к
исходникам, соответствующим распространяемому выпуску; совпадение публичных
исходников с артефактами 1.6.0 здесь не подтверждено.

Карточка, category, support/privacy URLs, скриншоты, age rating, export compliance
и сведения о цене/покупках остаются отдельной подготовкой App Store Connect.
Этот аудит не выбирает бизнес-модель и не подтверждает договоры аккаунта.

## Рекомендуемый порядок работ

1. Для будущих выпусков заменить nonfree FFmpeg и зафиксировать происхождение,
   configure flags, лицензии и corresponding source FFmpeg/FFprobe по обеим
   архитектурам. Провести экспортные регрессии из AGENTS.md, включая Quick Look.
2. Разрешить AGPL/MAS права и проверить bundled media. При отсутствии допустимой
   схемы распространения не вкладываться в полную MAS-адаптацию этого форка.
3. После решения прав сделать изолированный `mas-dev` прототип: MAS Electron,
   sandbox, ScreenCaptureKit helper, запись без обязательного Accessibility,
   микрофон/камера/system audio, clicks/Input Monitoring, импорт и экспорт.
4. Проверить главный пользовательский цикл: новая запись → монтаж → сохранение
   во внешнюю папку → выход → повторный запуск → открытие проекта с video/webcam/
   audio → MP4/GIF/ProRes alpha export. Повторить с отказом разрешений и на обеих
   архитектурах; Rosetta не считать физическим Intel-тестом.
5. Добавить persistent bookmarks/миграцию, привести helpers и loopback к sandbox,
   определить состав расширений и automation для MAS. Сохранить отдельный
   Developer ID-канал с исходными возможностями.
6. Подготовить privacy/notices/metadata, MAS profiles/installer signing, собрать
   новый submission package и пройти Transporter/TestFlight/App Review.

## Предварительная оценка трудоемкости и целесообразности

Дополнено 26 октября 2026 года по запросу оценки всего перехода. Это инженерная
оценка до настоящего `mas-dev` прототипа. Допущения: один опытный Electron/macOS
разработчик с AI, сохранение основного recording/editor/export сценария, отдельный
MAS-канал, без внешних исполняемых расширений и без обещания полного CLI/MCP
паритета. Время согласования прав и ожидания App Review сюда не включено.

| Работа | Рабочие дни | Основная неопределенность |
| --- | ---: | --- |
| Воспроизводимые FFmpeg/FFprobe, лицензии бинарников и адаптация кодеков | 2–5 | Отказ от GPL-компонентов затрагивает прямые вызовы libx264, не только software fallback |
| MAS Electron, отдельная подпись, helpers, ScreenCaptureKit/TCC | 3–7 | Экран, system audio, микрофон и webcam должны работать именно из sandbox |
| Удаление AX-зависимости, наблюдение кликов и курсор | 2–5 | Возможна потеря точности распознавания вида курсора; базовую запись нельзя блокировать отказом Input Monitoring |
| Bookmarks, связанные media, папки и повторное открытие проектов | 4–8 | Несколько внешних источников на проект, перезапуск и передача доступа helpers |
| Состав расширений/CLI/MCP, updater и разделение каналов | 1–3 | Оценка относится к исключению спорных функций из MAS, не к их полному переносу |
| Privacy, bundled notices/source instructions, About и карточка | 1–3 | Тексты и перечень ресурсов требуют фактической инвентаризации; получение прав отдельно |
| Регрессия двух архитектур, пакет и техническая подготовка подачи | 3–6 | ProRes alpha/Quick Look, отсутствие Homebrew, отказ разрешений, версия macOS |

Сумма строк: **16–37 рабочих дней**. Плановый ориентир с небольшим резервом:
**20–40 рабочих дней (примерно 4–8 недель, 160–320 часов)**. Это не измеренная
скорость выполнения и не фиксированная смета. Оценку пересчитать после прототипа;
доступность физического Intel Mac и профилей разработки влияет на календарь.
Полный паритет внешних расширений и CLI/MCP до отдельного исследования не оценен.

Дополнительная проверка исходников уточнила сложность замены FFmpeg:
`electron/ipc/nativeVideoExport.ts:121` уже предпочитает VideoToolbox на macOS,
но `electron/ipc/export/native-video.ts:1135` прямо использует libx264 для source
proxy. `electron/ipc/register/export.ts:370` предпочитает системный FFmpeg для
ProRes. Переход на LGPL bundle требует адаптировать эти пути и повторить
проверки экспорта, а не только заменить файл executable. Windows-only пути
нельзя случайно изменить при адаптации macOS.

Практический первый этап — **2–4 рабочих дня технического прототипа**, включенные
в общую оценку. Для решения о продолжении проверить:

1. Настоящий sandboxed MAS Electron с подписанными embedded helpers запускается.
2. Проходит короткая запись экрана и окна с system audio, микрофоном и webcam,
   остановкой и передачей результата в редактор.
3. Клики/координаты доступны без обязательного AX; отказ Input Monitoring
   сохраняет возможность обычной записи.
4. Внешнее видео импортируется, проект сохраняется, после выхода/перезапуска
   открывается со связанными media и экспортируется.

Если не работают только точное определение формы курсора или поднятие чужого
окна, можно рассматривать ограниченный MAS-вариант. Если базовая запись/звук
или восстановление media требуют unsandboxed helper либо обязательного AX,
первоначальную оценку нужно пересмотреть до дальнейшей разработки.

Рекомендация: сохранять Developer ID/DMG как основной полный канал. В 1.6.0
значительная часть ценности — 84 CLI/MCP команды и durable jobs; исключение
automation из MAS означает иной набор возможностей продукта. MAS имеет смысл
развивать как дополнительную версию после решения AGPL и успешного прототипа.
Переписывать весь редактор на Swift оснований пока нет. Замену nonfree FFmpeg
и корректные notices/source distribution готовить для следующего внешнего
выпуска независимо от решения о магазине.

Окупаемость не рассчитана: нет заданных цены, ставки разработки и ожидаемого
дополнительного спроса. Для денежной оценки можно использовать трудозатраты
160–320 часов × согласованную ставку, отдельно учитывая получение прав,
проверку лицензий и последующую поддержку двух каналов.

## Безопасное воспроизведение проверок

Из корня репозитория; команды только читают существующие артефакты:

```sh
codesign -d --entitlements - \
  "release/notarized-v1.6.0-automation/mac-arm64/Screendance App.app"

arch -arm64 \
  "release/notarized-v1.6.0-automation/mac-arm64/Screendance App.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" -L

arch -arm64 \
  "release/notarized-v1.6.0-automation/mac/Screendance App.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" -L

arch -x86_64 \
  "release/notarized-v1.6.0-automation/mac/Screendance App.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" -version
```

На следующих выпусках повторить проверку именно финальных packaged executables,
а не только `node_modules` в рабочем дереве. Результаты реальной MAS/mas-dev-проверки
следует дописать сюда после прототипа.
