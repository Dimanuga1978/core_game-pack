# PoC-скрипты к HARD_AUDIT_2_current_state.md

Запускать из корня распакованного tablecore-v2 (после `npm install`).

- `poc_seed_leak.mjs` — P0.1: seed виден в публичном снапшоте.
- `poc_timebomb_crash.mjs` — P0.2: отложенная мутация Immer-draft роняет процесс (запустить отдельно: `node poc_timebomb_crash.mjs`, посмотреть на код возврата и stderr).
- `poc_grid_duel_softlock.mjs` — P1.15: grid-duel неиграбелен для нестандартных player id.
- `poc_pack_linter_bypass.mjs` — P1.new-1: два обхода статической проверки на structuredClone-на-draft.
