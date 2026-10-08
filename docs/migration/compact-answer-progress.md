# Compact answer surface and host race progress (2026-10-08)

Target: independent Cloudflare deployment at https://ionicformulacompetition.koichem.workers.dev/.

- Immediate actions: パス / チェック / 全解答確認, width ratio 2:3:2. Side actions are white; Check retains #eaf7f2. Passed-field review uses a compact 戻る action with the existing accessible label. Enter submission, Japanese IME composition guards, and retries remain available.
- Normal question minimum height: 134 → 108 px; answer composer: 57 → 50 px. Short portrait question minimum: 98 → 88 px. Answer action and keyboard buttons retain at least 44 px height. Input font stays at least 16 px.
- Immediate host progress uses accepted correct fields. Deferred progress uses distinct nonempty questions followed by Next (or final-question full review). Draft autosave, blank moves, and erasure do not advance the runner; revisits do not double count. Both-field mode counts a question once when either field has input.
- Deferred `advance` operations are persisted and replayed in the existing v2 log. `participants.resolved_question_count` stores distinct transitions; `advancedQuestionCount` exposes that counter separately from `answeredCount`. Deferred `current_ordinal` stays zero. No database migration or grading change is required.
- Ordinary runners stand idle and dash only on progress increments. Existing immediate goals, deferred submission rest, and light mode are retained.

## Verification before publication

`pnpm verify:cloudflare` passed: 558 general/load tests, 28 Cloudflare tests, 18 D1 tests, client/Worker typechecks, and Cloudflare production build. Focused replay/API/race tests were independently reviewed; no actionable findings.

Playwright MCP against the real local Worker/D1/RoomCoordinator fixture confirmed:
- At widths 320/390/428/768, immediate action order, 2:3:2 measured ratio, specified colors, 44 px heights, 50 px input, 108 px question, and no horizontal overflow.
- Name composition blocks Check; incorrect answers and passes leave host progress unchanged; Enter correct answers and passed-question retries advance host progress.
- Deferred compound both-field mode: one filled name autosaved without movement; Next advances once; clearing/revisiting and blank moves leave the count unchanged; last question full review advances once. Host denominator is five questions rather than ten answer fields. Idle runners stop. No console/page/request errors occurred in this deferred flow.

The local browser fixture substitutes Google identity and loopback transport only; it does not demonstrate production OAuth or physical iPhone keyboard/touch behavior. Native Safari accessory controls cannot be reliably hidden by page CSS; this release instead reduces page content height as requested.

## Production verification

Main implementation commit: `b268740e3f004066fc3f975d0a1fba1b83ad767d`. GitHub Actions [37778047603](https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare/actions/runs/37778047603) passed every verification step, including Worker dry-run. Cloudflare automatic Build `691d2bd6-ebf4-467b-90eb-bf0a274382f1` succeeded. Production `/api/health` returned that exact implementation SHA with D1/Auth/RoomCoordinator readiness true.

Playwright MCP on production HTTPS confirmed the new immediate button order, ratio, colors and heights at 390 px, without overflow. Served `index-rE23aMYf.js` and `index-BQMkS08e.css` SHA-256 hashes match the verified local build. A named synthetic two-participant immediate Mate match completed with one accepted correct name, four passes, explicit submission, and the expected final ranking. A separate deferred Mate match accepted draft saves with progress zero, then `advance` with progress one; host state exposed `advancedQuestionCount: 1` separately from `answeredCount: 1`. No page, console, or request errors occurred in the observed host browser flows.

Only these named synthetic rooms were used; existing competition data and the legacy GitHub/Supabase repository remain unchanged. Production Google login and physical iPhone keyboard/touch were not revalidated in this release; local Class host race verification and real production anonymous Mate verification are separate evidence.
