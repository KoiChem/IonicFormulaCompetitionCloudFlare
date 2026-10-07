# Complex chemistry and teacher management port

Approved: user requested implementation, verification and publication after migration investigation.
Source: Sites version 33 / source commit 8e5378e; target existing codex/github-supabase checkout.

Preserve Google PKCE authentication, apiFetch transport, private Realtime, transaction pooling, serverTiming clock synchronization and existing rooms/results.

1. Port source chemistry, question profile policy/generator, settings and keyboards with source regression tests. Observe missing-feature failures first.
2. Merge profile persistence/API and add additive PostgreSQL migration, RLS/revoked direct grants. Room creation saves immutable profiles; existing rooms use legacy selection. Exercise actual PostgreSQL API, retry and snapshot behavior.
3. Port teacher workspace, management cards, dialog/toggles and CSS. Route all requests through apiFetch and preserve hash routes and Google login. Exercise desktop/iPad/mobile.
4. Export complete current source profile via authorized master UI/API; validate complete export and revision, preserve settings exactly in target. Do not copy source identities, receipts or room history.
5. Run full tests, typecheck, build, bundle exposure and focused review; deploy additive DB, backend, imported configuration and frontend in compatible order. Verify public master/class and anonymous mate flows through real Auth, Realtime updates and results.

Acceptance: complex OFF excludes complex chemistry; ON obeys saved ratios with ceil, no item duplicates; all 5/10/15 counts and both grading modes work. Master-only edit, CAS conflict and idempotent replay. Existing rooms/history remain valid. Class controls fit landscape PC/iPad viewport. Physical device and school-network checks remain distinct.
