# Cloudflare Phase 1 Implementation Plan

> Execute inline using superpowers:executing-plans and test-driven-development.

**Goal:** Publish the isolated Cloudflare Phase 1 candidate with D1 migrations and verified 50-person persistence.
**Architecture:** Keep existing domain/UI. Native D1 batches, CAS and receipts protect persistence; the public Worker exposes only health/capability and static assets in Phase 1. Existing Supabase transport remains at 42 until Phase 2.
**Tech Stack:** TypeScript, React/Vite, pnpm, Wrangler 4.148.0, matching Miniflare/workerd, existing Vitest 3.2.4.
**Spec:** ../../../IonicFormulaCompetition_Cloudflare_Sol_Spec.md

## Global Constraints
- Only KoiChem/IonicFormulaCompetitionCloudFlare changes; preserve existing production.
- D1 class capacity 50, mate 4; Supabase-facing candidate UI stays 42.
- No API/auth/realtime migration or production data transfer.
- Request-level transaction is not promised by D1 batch.
- Publication authorized by user; do not destroy old services.

## Review Focus
- CAS fails after interruption/removal; no stale operations, score or receipt committed.
- Maximum 128 operations remain within 50-query invocation budget.
- Expired or removed actor cannot replay a receipt for access.
- Remote environment binding cannot fall back to production accidentally.
- Public API paths return JSON errors, not SPA success.

### Task 1: Isolated repository and D1 schema
**Files:** migrations/d1/0001_baseline.sql, scripts/generate-d1-baseline.mjs, tests/d1/schema.test.ts, docs/migration/source-baseline.md, persistence-map.md.
**Interfaces:** consumes existing drizzle history; produces one reproducible final D1 schema and real workerd test helper.
- [ ] Record baseline unit tests and source SHA.
- [ ] Add schema equivalence/FK/unique tests against real D1; run failing before baseline exists.
- [ ] Generate final empty-database schema, use a single migration directory, verify indexes/cascade and no double application.
- [ ] Run existing suite and D1 schema tests, commit.

### Task 2: D1 commands and 50-person correctness
**Files:** src/platform/d1-database.ts, src/config/public.ts, src/persistence/v2-operations.ts, v2-manifest.ts, cleanup.ts, tests/d1/commands.test.ts, tests/persistence/room-races.test.ts, tests/load/.
**Interfaces:** consumes D1 schema; produces PersistenceDatabase adapter without request transaction and D1 capacity 50.
- [ ] Add failing 49/50/51 capacity, 128-operation bounded-query and stale-state race tests.
- [ ] Reuse native D1 SQL; fold operations into JSON INSERT SELECT; strengthen mutation guards and receipt access checks.
- [ ] Keep hosted Supabase UI capability 42; update D1 load fixtures to 50 and preserve mate4.
- [ ] Verify rollback, retry, ranking/ties, expiry and multiple-room concurrent flows; commit.

### Task 3: Worker candidate and local browser
**Files:** worker/index.ts, wrangler.jsonc, tsconfig.worker.json, tests/d1/worker.test.ts, package.json, .github/workflows/verify.yml, README.md.
**Interfaces:** consumes migrated schema; produces /api/health phase1 capability and static UI, no competitive D1 HTTP API.
- [ ] Add failing JSON API routing/health and schema-ready tests.
- [ ] Implement native Worker, selective asset routing and DB binding. Pin tool versions and CI scripts.
- [ ] Run typecheck, full tests including load, real D1 tests, build and Wrangler dry-run.
- [ ] Verify local desktop/mobile, manual/QR flows and console/network via Playwright; commit.

### Task 4: Remote verification and publication
**Files:** docs/migration/verification.md, operations.md; explicit environment configs.
**Interfaces:** consumes candidate and verified migrations; produces GitHub main commit and deployed Cloudflare version.
- [ ] Confirm Cloudflare identity/account, existing Worker/D1/build integration and target schema.
- [ ] Apply migrations to isolated remote test D1 and run bounded remote persistence smoke; use existing candidate D1 only after confirming intended empty database.
- [ ] Perform one independent whole-branch code review, fix significant findings with regression tests.
- [ ] Commit/push target main without force; publish candidate and verify live page, JSON API and version.
- [ ] Record exact evidence and any external/device limits.
