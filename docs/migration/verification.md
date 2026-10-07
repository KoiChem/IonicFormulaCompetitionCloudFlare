# Phase 1 verification — 2026-10-08 JST

Source baseline b83f22f76bb8e868f3cf88f15a7094ad7b08e2cd; destination KoiChem/IonicFormulaCompetitionCloudFlare.

## Evidence by layer

- Source baseline: 543 passed / 3 skipped before changes; source checkout unchanged.
- Updated domain/API/PostgreSQL/UI suite, `RUN_LOAD=1 pnpm test`: 546/546 passed, including both 50-player × 15-question × two-field modes.
- Native workerd/D1: schema equivalence (tables, columns/defaults, explicit indexes), FK/UNIQUE, batch rollback and cascading deletion; isolated Worker health/API/static routing.
- Commands on local workerd/D1 and dedicated remote D1: 48 + three concurrent join → two accepted/one capacity error; 51 concurrent joins → 50; full-room replay and changed payload; 128 operations in bounded SQL; interrupt/removal/manifest races prevent stale child writes; removed/expired receipt rejected; duplicate operation IDs roll back ack/operations/receipt; 50 tied participants rank 1; both modes 50 × 15 × two fields produce 1500 correct fields; re-finalization is idempotent; 60-room cleanup uses constant SQL.
- Remote binding tests execute domain code locally and proxy D1 calls to Cloudflare, via official Wrangler `getPlatformProxy`. They prove remote D1 command/storage behavior, not a deployed competitive HTTP API or Worker CPU budget.
- Wrangler local migration applied 39 statements and second apply reported no migrations to apply. Remote dedicated test migration applied the same baseline.
- Worker dry-run: 2.01 KiB (gzip 1.02 KiB), DB/ASSETS/RELEASE_SHA bindings. No `nodejs_compat`, Node database driver, Deno entry, or test server in runtime graph.

## Browser boundaries

Playwright MCP uses the Cloudflare base `/` in a local browser against an isolated PostgreSQL fixture. Desktop teacher room setup and 390×844 student manual code/nickname, ready/countdown, answer/pass and submission flows are checked. Local test server does not implement Supabase Realtime: expected WebSocket handshake 404s are recorded separately from application failures. The HTTP recovery path is exercised. This is not evidence of Google OAuth, camera hardware, physical touch or live D1 API behavior.

## Official research / compatibility

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): Free 50 queries/invocation and 100 bound parameters/query. Operations and cleanup use parameterized JSON set operations rather than one statement per item. Batch does not turn many statements into one query.
- [Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/) and [remote bindings](https://developers.cloudflare.com/workers/local-development/): dedicated remote D1 validation without a public SQL/admin test endpoint.
- [Static Asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/): selective `/api` and `/api/*` run_worker_first.
- Cloudflare workers-sdk D1 examples and Vitest integration versions were checked. Latest pool requires Vitest 4; existing Vitest 3.2.4 is retained with Wrangler 4.148.0's matching Miniflare 5.20261006.0-alpha/workerd harness.

No throughput SLA, 50 physical student devices, multiple live classrooms, production D1 Auth/WS or full migration claim is made by Phase 1. Subsequent release evidence is appended after review/publication.

Expanded acceptance run: native D1 17/17 tests (11.06s); dedicated remote D1 commands12/12 (68.81s). Remote tests include both 50×15×2 field modes and 51 simultaneous joins. The total duration includes room setup/readiness and proxy latency; it is not per-submit latency or production throughput.

Independent review found a stale-ready generation race. The native D1 regression failed first; commit-time manifest/evaluator/generation/state/expiry guards now reject it without regressing new readiness. Final local verification: typechecks, 546/546 existing tests, 18/18 native D1 tests, and Cloudflare build passed. No critical/minor findings were reported.

QR/browser detail: actual jsQR decoded the teacher's generated SVG rendered into a synthetic canvas camera stream, reached nickname entry, and all stream tracks ended. Camera-denied UI recovered through Close. Deferred submission also reached final results and per-question review at 390px without horizontal overflow. Synthetic video proves browser scanner logic, not camera optics or physical-device permissions.

Final remote regression: 13/13 passed (78.26s), including stale ready→cancel→generation 2. Existing candidate D1 was rechecked empty before migration, then applied baseline39 statements (5.69ms SQL). Candidate database is schema-only; no production rooms were migrated.
