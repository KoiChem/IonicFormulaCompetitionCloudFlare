# Implementation progress

Plan: docs/superpowers/plans/2026-10-01-github-supabase.md

- Baseline: remote main contains README only. New folder associated with target repository on codex/github-supabase. Original Sites source preserved.
- Ruling: use native execution with one fresh final review; implementation and publication already explicitly authorized.
- Ruling: use one Postgres transaction per request with deterministic room advisory lock instead of Edge-computed commit RPC. Existing persistence CAS/receipts remain; authorization, reads, scoring and writes share the same transaction. This reduces migration changes and requires real Postgres integration verification.
- Preflight: SPA API transport consumes existing route contracts; Postgres adapter consumes PersistenceDatabase; Realtime consumes committed room/progress state. No incompatible interface names found.
- External project confirmed in Safari: IonicFormulaCompetition, Free, ref slktkbpvvsfpflnmpuvr. User specified initial master email separately; do not publish email in source.

## 2026-10-01 implementation and verification

- Implemented static hash SPA, Google/anonymous Supabase Auth transport and teacher allowlist binding.
- Converted the mature v2 persistence to Postgres; transactional mutations retain immutable receipts and sequence/writer protection. PGlite tests cover flow, duplicate requests, 42-person capacity, table permission denial and private topic membership.
- Implemented private control/host events, epoch rotation, durable latest-event outbox, retry lease and weighted project budget. Review found duplicate-tab fanout undercount; fixed estimate to reserve two connections per person and adjusted send budget to 90/second. This is an estimate; arbitrary tabs/devices are not a hard connection ceiling.
- HTTP recovery now has exponential backoff, jitter and Retry-After. Teacher progress confirms every 2 seconds; connected participants 30 seconds; disconnected participants 5 seconds.
- Supabase CLI authenticated after user approval. Remote DB had zero public tables. Applied migrations 001-003 successfully with db push; enabled anonymous signup, 300/hour/IP and Pages callback URLs. Registered master email only as backend secret. Edge API deployed.
- Cloud anonymous Auth and public-config endpoint return 200. Found and fixed server-only window detection incompatible with Edge runtime; explicit regression test added. Built-in SUPABASE_DB_URL works, no DB password requested.
- Local Playwright: teacher create -> student join at 390px -> preparation/ready -> race -> interruption -> teacher/student results and individual review. No horizontal overflow. Auth simulated only in localhost fixture; user explicitly approved fixture after automatic review rejected re-seeding a session. Real Google login is not thereby verified.
- Local fixture has no Realtime socket server; its WebSocket errors are expected infrastructure limitations. Cloud Realtime and published page still require checks.
- Fresh read-only code reviewer found no critical authorization/RLS gap; duplicate-tab estimate fixed as above.
- Added regression test for results transport after browser found an old relative API endpoint.
- Google OAuth credentials/provider are still unconfigured. Classroom shared network, physical iPhone/iPad and five simultaneous classes are not verified.

- Actual private Realtime cloud smoke: authorized host/control SUBSCRIBED, outsider host CHANNEL_ERROR, committed room.changed and host.progress received; verification mate room cancelled afterward.
- Actual 42 simultaneous GETs revealed stale SERIALIZABLE snapshots (3 successes / 39 failures), then region-dependent room lock queuing (Tokyo Edge versus Seoul DB). Adopted READ COMMITTED for room/broadcast scopes only with advisory transaction locks and existing CAS/receipts; creation/config retain SERIALIZABLE plus bounded jittered retry. Fresh review confirmed this scoped approach and cautioned against relaxing credential-based creation invariants.
- Browser calls now target the database region with x-region. Region pinning avoids per-statement Tokyo/Seoul round trips; an outage requires changing the deployment region config rather than expecting automatic rerouting.

- Final cloud burst check after scoped isolation/region/lock-wait tuning: 42 simultaneous state requests all HTTP 200; elapsed 7.53 seconds, slowest 7.50 seconds. This is API burst evidence using a verification mate room; it does not prove 42 distinct student devices or full simultaneous classroom operations.
- Final local suite: 77 test files, 382 tests passed, RUN_LOAD=1 and REQUIRE_BUNDLE=1. Production TypeScript and Vite build passed. Static client has no server secrets or answer datasets. Client bundle ~565KB (~161KB gzip) remains a size warning.

## 2026-10-02 publication and remaining verification

- Published implementation commit df6ed702bbf88f8ce733979c41a04a182008e129 to KoiChem/IonicFormulaCompetition main. Enabled workflow-based Pages after initial configure-pages 404; rerun 36897040907 build and deploy succeeded. Public JS/CSS bytes match local dist.
- Public Playwright with real anonymous Auth: mate room creation, second browser join, ready and start succeeded at 390px/1024px without horizontal overflow. Room 83ab5dc3-3b03-41bf-9c05-77da7f23d157 then showed intermittent state 503 during running and persistent core-handler service_unavailable after timeout. Results verification is NOT complete and app is not yet classroom-ready.
- Added Postgres unanswered timeout regression: state FINISHED and results succeed in PGlite; tests/postgres/flow.test.ts 4/4 passed. Reviewer independently reproduced deadline collection/finalization successfully. Thus this does not reproduce actual Supavisor/postgres.js failure; no speculative fix applied.
- Cloud Edge log inspection is blocked because the Mac is locked. Requested manual unlock. Automatic approval review also rejected browser session-token metadata access; continued safely using a normal UI request's response body, without reading credentials.
- Google OAuth provider remains unconfigured; real teacher login/classroom flow remains pending user setup.

- Root cause of persistent finalization 503 confirmed in actual Edge logs: SQLSTATE 22023 at jsonb_array_elements($2::jsonb). postgres.js JSON serializer double-encoded pre-encoded JSON strings after server parameter inference. Cast through text before jsonb; regression verified red/green. Actual two-browser mate flow now produces correct1/5, two submissions, final rankings, own field results, reload and history.
- Root cause of intermittent gateway 503 confirmed: SQLSTATE 53300. Built-in Edge DB URL was direct db.<ref>.supabase.co:5432. Supabase Connect UI verified transaction pooler aws-0-ap-northeast-2.pooler.supabase.com:6543 / postgres.<ref>. Server reuses built-in encoded credentials on that verified pooler, preserves explicit override, max1/idle1/preparefalse. Reviewer found no blocker. Cloud42GETs all200, elapsed12.51s; queue latency remains a performance limit.
- Real deadline tests now reach results for both browsers, but finish notification400/finalSyncUnconfirmed persists. Diagnosing TypeError at applyV2Operations (future-time guard suspected); numeric-only clock rejection diagnostic added. Mac auto-locked again before numeric log could be read; manual unlock requested.
- Added processing-aware server/client midpoint timestamps (server receive/send measured outside transaction, client dispatch after Auth session lookup). Regression demonstrates 900ms legacy bias under uneven processing; actual cancelled-room samples had -15/-7.5/-4ms bias, which alone does not reproduce deadline issue. Live timeout verification of the new frontend remains required.
- Current verification: 78 files/387 tests passed with load and bundle flags; TypeScript and production build passed. Clock frontend is not yet live at this ledger entry.

- Clock/connection/JSON fixes published as 9c0fed886a2864338c3ae60d4a7d58eb28419fbf. GitHub MCP confirms run36929076190 build/deploy success. Served JS index-B-y77TtR.js matches local bytes (sha256 prefix d328faa29d0c304c); CSS also matches.
- Fresh real anonymous two-browser public 3-minute deadline competition (8237d3f6-abc7-4408-a367-619936d9f6ec) completed with both finish acknowledgements confirmed, no finalSyncUnconfirmed, complete own unanswered results, zero API failures during the whole round, and no overflow at390/1024px. This verifies the observed deadline notification failure is resolved with the new timing client/API.
- Google Auth public /auth/v1/settings still reports external.google=false; anonymous_users=true. Real Google teacher login and full live classroom flow remain blocked on OAuth setup. Mac re-unlock is no longer needed for the current fix verification; old numeric diagnostic logs were not read.
- Owned localhost mock API/Vite servers stopped. Actual physical devices,42 distinct student clients, five simultaneous classes and the school's shared network remain unverified.


## 2026-10-04: Home camera QR participation

- Added a 48px camera button left of the home participation-code input at desktop and mobile widths. A modal camera preview uses video only, prefers the rear camera, and loads jsQR on demand. Frames are decoded locally; no images are uploaded.
- Teacher QR invitations keep the existing direct nickname route and now carry a code query. The home scanner fills the code and waits for the student to press Join. Existing code-free QR invitations continue directly to nickname entry. Unrelated origins/application paths and malformed/duplicate codes are rejected.
- Camera streams stop on successful decoding, close/Escape, backgrounding, and late permission resolution after close. Denied/missing/unavailable camera errors offer manual entry; input values are preserved.
- Validation: new parser tests verified failing then passing; 88 files / 475 tests pass with RUN_LOAD=1. TypeScript and production build pass (existing large bundle warning remains). Read-only reviewer found no actionable bugs.
- Local Playwright: actual generated QR pixels decoded through a canvas MediaStream; current code reflection then Join reaches nickname entry, legacy QR reaches nickname entry, unrelated QR rejected. Join-info responses for these synthetic room IDs were stubbed. Verified denial, close, Escape, late camera permission, focus return, no overflow and left placement at 320/390/768/1280px, and zero console errors/API network failures.
- Physical iPhone/iPad camera access, optical QR recognition, and Safari behavior have not been tested. Browser camera inputs above are controlled MediaStreams, not physical-camera evidence.


## 2026-10-04: Immediate review continuation and direct QR joining

- Immediate-mode review now offers a continuation button on the current frontier question and a matching footer. Both resume the first normally answerable question and unresolved field, preserving drafts. Later questions remain concealed and unselectable. Passed-field retries return to the list; normal progress no longer depends on the past question temporarily opened for retry.
- Restoring an immediate session normalizes stale display ordinals to its derived frontier while retaining active unfinished passed-field review, operations, and drafts. A correct review target is cleared. No server, scoring, deadline, or deferred-mode rules were changed.
- Pending/unanswered/passed/retrying fields use orange backgrounds, borders, and text, independently for formula/name fields. Correct fields remain green; unreached future cards remain grey.
- QR scans now follow the same code-resolution route as manual Join and continue to nickname entry without another Join click. Existing code-free invitations still use the direct room route. Replaced the camera glyph with an inline QR glyph and corner brackets.
- Validation: six new regression cases verified failing then passing; all 88 files / 481 tests pass with RUN_LOAD=1. TypeScript/build and git diff checks pass. Read-only reviewer found no actionable issues.
- Local Playwright with synthetic room state/manifest/ack responses verified the exact pass → early review → retry → correct → resume scenario, card/footer resumption, draft retention, stale-ordinal restoration, and the no-continuation state after every question is visited. Computed colors distinguish correct and unanswered fields. Controlled QR camera frames verify automatic nickname routing and stream shutdown. QR button stays left of input without overflow at 320/390/768/1280px. Console errors: zero.
- Physical-device camera/Safari checks and a live classroom competition are not claimed by these synthetic browser tests.

## 2026-10-04: Answer control touch scrolling

- Scoped `touch-action: pan-x pinch-zoom` to buttons, formula keyboard, name shortcuts, and formula/name composers inside `.play-active`. Keyboard gaps are covered by their containers. Removed narrower redundant key rules and the conflicting `manipulation` rule.
- Page scrolling from question text/blank areas remains available. Existing pointer/touch input handlers are unchanged; horizontal caret gestures, vertical case/bracket flicks, and pinch zoom remain permitted by the gesture policy.
- Production build and TypeScript pass. Local suite: 86 files / 478 tests pass, 2 load files / 3 tests skipped; the Pages workflow runs its existing full RUN_LOAD=1 suite.
- Playwright/Chromium with actual FormulaKeyboard and NameKeyboard components: 22 checks across 11 control/key-gap locations in both vertical directions showed zero page scroll. Verified case flick, horizontal caret swipe, name input/shortcut, and touch button activation; blank area scrolled 121px. No page errors. Fixture setup React-module mismatch was corrected without product changes.
- Physical iPhone/iPad Safari, native text-selection handles, and OS keyboard behavior remain unverified.

## 2026-10-04: Restore review-list scrolling

- Limited the answer-control gesture policy to `.play-answering`, present only on normal/retry answer surfaces in both player implementations. Immediate/deferred review screens retain `.play-active` styling but do not receive the suppression policy.
- Verified the original failure before editing: vertical touch drag from an immediate-review retry button moved the page 0px.
- Production-build Playwright tests with synthetic room APIs verify both review modes: all 10 review buttons scroll in both directions (about 100px), selecting a question suppresses scrolling from the answer input/action buttons (0px), and returning to review restores scrolling. Formula controls/key gaps also stay at 0px; case/bracket flicks and horizontal caret gestures pass. No page errors in production-build checks. Development HMR produced duplicate-root errors, so release validation used the production preview.
- TypeScript/build and RUN_LOAD=1 suite pass: 88 files, 481 tests. Physical iPhone/iPad Safari and native text-selection behavior remain unverified.
