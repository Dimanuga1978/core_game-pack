# Раздельная дистрибуция: движок и game pack

## Что изменилось

Раньше `games/*` подключались к `packages/*` через относительные пути в файловой системе (`../../../packages/core/src/rng/SeededRng.js`) — жёсткая привязка к конкретной структуре монорепозитория. Сегодня — через настоящие, независимо версионируемые npm-пакеты.

### 1. У каждого `packages/*` и `games/*` — свой `package.json`

Имя, версия, явно объявленные `dependencies`/`devDependencies`:
- Пакеты движка: `@tablecore/core`, `@tablecore/protocol`, `@tablecore/server`, `@tablecore/transport-ws`, `@tablecore/game-pack`, `@tablecore/game-api`, `@tablecore/pack-linter`, `@tablecore/content-sdk`, `@tablecore/authoring-sdk`, `@tablecore/presentation`, `@tablecore/client-runtime`, `@tablecore/reference-ui`, `@tablecore/authoring-studio`, `@tablecore/map-editor`, `@tablecore/rules-editor`, `@tablecore/worker-pool`, `@tablecore/observability`.
- Игры: `@tablecore/game-grid-duel`, `@tablecore/game-coin-race`, `@tablecore/game-phase-quest`, `@tablecore/game-sector-expedition`, `@tablecore/game-last-sector`.
- **Не тронуты**: `games/timebomb-test`, `games/memory-hog-test`, `games/infinite-loop-test` — это тестовые фикстуры для `packages/worker-pool`, загружаются динамически по `new URL(...)` (для `import()` внутри воркер-потока), не статическим импортом — концепция npm-пакета для них не применима.

### 1а. Требования к подключаемому игровому паку

Реальный, живой запрос на разбор всей архитектуры разделения движка и игр выявил два требования, которые стоило формализовать, а не оставлять неявными:

- **Собственные тесты игры автоматически подхватываются `npm test`.** Корневой `package.json`'s тестовый скрипт больше не перечисляет игры поимённо — вместо `games/last-sector/test/*.test.js`, `games/grid-duel/test/*.test.js` и т.д. используется единый glob `games/*/test/*.test.js` (плюс `.test.mjs`). Подтверждено вживую: добавил синтетическую игру с собственным `test/proof.test.js` — подхватилась `npm test` без единой правки `package.json`. Директории без `test/` (`infinite-loop-test` и подобные) корректно пропускаются, не вызывая ошибку. **Требование к паку**: если у игры есть собственные тесты, они должны лежать в `games/<id>/test/*.test.js` (или `.test.mjs`) — только это гарантирует автоматическое включение в тестовый прогон движка.

- **`internal: true` в `manifest.json` — явный, расширяемый флаг «не показывать в списке игр».** `grid-duel`/`coin-race`/`phase-quest`/`sector-expedition` — реальные, играбельные (в смысле правил) паки, но по факту чистые бэкенд-фикстуры для разработки движка, никогда не задумывавшиеся как то, во что предложат сыграть настоящему пользователю. `status: "preview"` для этого не подходил — то же значение стоит у `last-sector`, означает зрелость разработки, не аудиторию. Вместо списка запрещённых имён (что сломало бы саму идею plug-and-play архитектуры — любая будущая внутренняя фикстура, своя или стороннего пака, требовала бы правки лаунчера) — `packages/launcher/src/catalog.js`'s `discoverGameCatalog()` теперь пропускает любой манифест с `internal: true`. Область действия — **только видимость в каталоге лаунчера**; такая игра по-прежнему полноценно регистрируется напрямую через `games` конфиг `createTableCoreServer` и используется для реальных матчей (собственные тесты `packages/worker-pool` именно так и делают, намеренно) — флаг не отключает функциональность, только не предлагает её как «выбери игру» обычному игроку.

`dependencies` — что нужно для реальной работы (рантайм). `devDependencies` — что нужно только тестам (например, `@tablecore/core`'s тесты используют реальные игры как фикстуры вместо моков — легитимный, но test-only граф зависимостей, отделённый от продового).

### 2. `npm workspaces` в корневом `package.json`

```json
"workspaces": ["packages/*", "games/*"]
```
`npm install` создаёт настоящие символлинки в `node_modules/@tablecore/*` — реальное разрешение зависимостей, не заглушка.

### 3. Все внутренние импорты переписаны

37 файлов (src + test), с `../../../packages/X/src/...` на `@tablecore/X`. Deep-path импорты (например, `packages/core/src/rng/SeededRng.js` напрямую) свёрнуты до импорта из корня пакета — всё нужное уже реэкспортировано из `src/index.js` каждого пакета. Единственное исключение — authoring-бандл `sector-expedition` (архитектурно отдельная, опциональная часть пака, не нужная для рантайма): у него настоящий subpath export, `@tablecore/game-sector-expedition/authoring`.

### 4. `engineCompatibility` в манифестах — было чистой декорацией, теперь реально проверяется

Поле `engineCompatibility: ">=2.0.0-alpha.1 <3.0.0"` существовало в манифестах и нигде не читалось. Вернул semver-range компаратор (логика, которая была в первой версии этого движка и потерялась при переписывании на v2), подключил к `GAME_API_VERSION` — реальному семверному "контракту" правил игры (`createInitialState`/`getLegalActions`/`applyAction`/`getGameStatus`), под который написан пак. Проверка срабатывает при `createGamePack()` — пак с несовместимым диапазоном не загрузится вообще, с явной ошибкой.

По пути нашлась и починена **отдельная, самостоятельная находка**: у Last Sector `engineCompatibility` был в статическом `manifest.json`, но отсутствовал в реальном рантайм-объекте манифеста в `src/index.js` — два источника правды разошлись, и новая проверка тихо ничего бы не проверяла для единственного пака, который явно объявил это ограничение. Синхронизировал.

---

## Доказательство: не «выглядит разделённым», а реально работает раздельно

Утверждать разделение — не то же самое, что его показать. Сделал оба раза по-настоящему:

### Проверка 1 — минимальный движок + `grid-duel`
```
npm pack  # для core, game-api, game-pack, grid-duel
mkdir /отдельная/директория  # никакой связи с монорепозиторием
npm install <4 .tgz файла>
node play.mjs  # createMatch → startMatch → dispatchMatchAction
```
Результат: полноценная партия Grid Duel только из установленных артефактов.

### Проверка 2 — полный движок + настоящая игра (`last-sector`)
```
npm pack  # для core, game-api, game-pack, protocol, observability, server, transport-ws, content-sdk, last-sector (9 пакетов)
mkdir /отдельная/директория
npm install <9 .tgz файлов>
node play.mjs
```
Результат:
```
Loaded pack: last-sector 1.0.0
Declared engineCompatibility: >=2.0.0-alpha.1 <3.0.0 (уже проверено при импорте — иначе строчка выше бы упала)
Real WebSocket server listening on port 44563
Player A unit spawned at: 0,0
Real MOVE action result: ACCEPTED -> new position: 1,0

=== Настоящая партия Last Sector, сыгранная через настоящий WebSocket, только из npm-тарболов, в директории без единого пути обратно в монорепозиторий. ===
```

Ни прямых вызовов функций для простоты, ни моков — реальный `ServerHost` + `createProtocolServer` + `createWsServer`/`createWsClient`, реальный MOVE-экшен, реальная валидация совместимости при загрузке пака.

---

## Что дальше, если нужна публикация в реальный registry

Сегодня `file:../tarballs/*.tgz`-зависимости в примерах — это симуляция того, что даёт `npm publish` + `npm install @tablecore/core@^1.0.0`. Технически ничего не мешает опубликовать пакеты в реальный npm registry (публичный или приватный) прямо сейчас — `package.json` уже в правильной форме. Что стоит сделать перед этим:

1. Решить, публичный это будет scope (`@tablecore`) или приватный registry.
2. Настроить CI, который при релизе движка публикует все `packages/*` разом (единая версия для согласованности, или независимое версионирование по пакетам — на ваш выбор).
3. `games/*` можно публиковать отдельным циклом, независимо от движка — именно этого разделения вы и просили; версии игр теперь не привязаны к версии движка иначе, чем через `engineCompatibility`.

## Итог

**277/277 тестов**, дважды проверено с нуля (сам монорепозиторий после `rm -rf node_modules && npm install`, и полностью независимая копия репозитория без `node_modules`/`package-lock.json`). Плюс два независимых, реальных (не смоделированных) доказательства раздельной установки — игрушечная игра и настоящая.
