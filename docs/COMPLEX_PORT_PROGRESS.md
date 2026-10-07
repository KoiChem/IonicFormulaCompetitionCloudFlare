# Complex/admin migration progress

Plan: docs/superpowers/plans/2026-10-02-complex-admin-port.md
Source initial HEAD 8e5378e; target baseline 07b3637. Existing branch clean.

- Source saved profile revision 5; D1 connector truncates full JSON. Full export pending owner login in Safari. Confirmed ratios ion normal30/hard35, compound normal20/hard40; do not substitute defaults.
- GitHub MCP authenticated as KoiChem; Playwright connected. Source master API in MCP browser returns401; user requested to log in using Safari.
- Implementation/publication explicitly authorized; continue in existing dedicated branch/check-out.

- Ported source modules using three-way merge against e28a346. Resolved teacher UI transport/hash routes and HTTP server config imports; Realtime/clock modules retained.
- RED: complex API/keyboard tests failed for absent features. GREEN:45 tests passed. New PostgreSQL profile migration tested;8 PostgreSQL tests passed.
- Full source export via authenticated Safari normal GET + Save Page Source: revision5,22 ion overrides,80 compound overrides, SHA256 cde306a9ee5cd7627c4273e3ea145f479d18a2554151dabaa307086c4f0e6a89. File /private/tmp/ionic-source-profile-complete.json; credentials not exported.
- First full suite:446 passed,3 failures for expected old labels/charge options; updated those assertions for approved feature changes.
- Full suite including load and bundle check:452 passed. Added two further PG tests: actual room policy immutability and legacy JSON table-valued join. Legacy JOIN json_each originally failed PG syntax; RED adapter regression and CROSS JOIN LATERAL fix, GREEN10 PG tests.
- Independent reviewer found no actionable defects in migration; final lateral-join delta review pending.
- Source export validates across every supported profile setting;24 additional actual generated quota/unique-item combinations passed.
- Local Playwright using previously authorized localhost-only fixture: master admin save/reopen persists31, search+item toggles present, close restores focus. PC1366x768/iPad1180x820/1024x768 class controls bottom604px; no horizontal overflow.390x844 dialog fits viewport; smartphone class form scrolls normally. No console errors. This does not verify realGoogle.
- Final tests with RUN_LOAD=1 REQUIRE_BUNDLE=1:86 files/454 tests passed. Typecheck/build/bundle and diffcheck passed. Independent final review and lateral delta review clean.
- Additive production migration applied successfully; imported full source profile to target revision1,3091 characters. Import uses ON CONFLICT DO NOTHING to avoid overwriting a later edit. Existing rooms unchanged.

- Production profile MD5 8c5bb3939d18e0422a286065feed4092 matches full source; anonymous/authenticated direct table access denied. Updated competition Edge Function deployed successfully.
- First Pages CI:453 tests passed; the 40,000-set statistical test hit its30s timeout on the slower runner. Extended only that test timeout to90s; sample count/assertions unchanged.
- Pages Actions37016559850 build/test/deploy succeeded for17e25c1; served JS index-WSAl4GBG.js matches local build.
- Public Safari real Google master: new management cards and all source ratios/category weights displayed. Created complex-enabled class room230736d7-83e6-4937-add6-0144d9dda23e. Playwright student answered all5 correctly, including [Al(OH)4]- and [Zn(OH)4]2-. Teacher/student final score5/time01:47.85 agree; student reload preserves results. No console errors or failed API responses observed.
- Public two-context mate room01853ae7-a635-4d94-ac70-386aa00e76ef: compound/deferred/complexON5 questions contains exactly1 complex salt. Keyboard-entered Li2O and K3[Fe(CN)6] both correct; submitted score2 vspeer0, both browsers show matching ranks and times. Result reload works,390px peer has no horizontal overflow.
- No original Site changes or production data deletion. Physical iPad touch and actual classroom concurrency remain unverified.
