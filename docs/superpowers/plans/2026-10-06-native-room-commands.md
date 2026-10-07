# Supabase native room commands implementation plan

Goal: Reduce QR join and preparation latency while preserving API and authorization behavior.
Architecture: Cached trusted CORS preflights, prioritized start quota, and private PostgreSQL v2 command functions called inside the existing transaction. Independent join/ready flags allow rollback.
Tech Stack: TypeScript, PostgreSQL 17, postgres.js, Supabase Edge, Vitest/PGlite, Playwright.
Spec: docs/superpowers/specs/2026-10-06-supabase-native-performance-sol.md

Global Constraints: Preserve existing work, Auth verification, shared quota, transaction locks, public API, v1 fallback, outbox lease CAS and pools. Publish is explicitly authorized. Never replay a failed native POST through legacy.
Review Focus: Replay with changed UID, removed participants, concurrent cancel/ready, clock after locks, nickname normalization, rollback on errors, mixed workers, private function privileges and outbox acknowledgement races.

### Task 1: CORS and quota admission
Interfaces: Gateway response headers and quota scope consumed by priorityTransactions.
Write failing tests for trusted OPTIONS max-age and start POST quota priority/shared bucket. Expected: missing max-age and normal start scope fail. Implement 600-second preflight and merged Vary; prioritize start/start-status admission. Run targeted gateway/queue tests and complete suite. Expected: all pass. Commit.

### Task 2: Native join
Interfaces: Shared HTTP validation -> private join_room_v1; gateway flags -> native dispatch -> legacy unsupported fallback before writes.
Write failing integration tests for v2 join, one command query, receipts/capacity/normalization/rebind/outbox/security/rollback and v1 fallback. Expected: native contract absent. Implement additive migration and validated dispatcher; retain Google provider side effects. Run tests and typecheck. Expected: pass. Commit.

### Task 3: Native ready
Interfaces: Shared validation -> mark_ready_v1; joins and legacy start produce progress/manifest; native notifications consumed by existing flush.
Write failing ready tests for simultaneous last ready, replay, generation/cancel, timeout and fresh countdown decision clock. Expected: native ready absent. Implement ready function and flag. Run integration/full tests, typecheck/build/edge bundle. Expected: pass. Commit.

### Task 4: Performance and browser verification
Interfaces: Existing load runner -> baseline/stage1/native configurations and measured app query counts. Public API unchanged.
Run real PG17 20/42 x30 per phase with artificial Auth 200ms and DB-call 10ms; report joins, start, ready and abort outcomes. Run no-delay mixed-worker/flush matrix, fault/security tests and browser QR-to-results/cancel flows at mobile dimensions, trusted preflight reuse. Expected: spec gates, no regression. Fix actual failures with reproducing tests. Commit evidence.

### Task 5: Review and staged publication
Interfaces: Additive migration, Edge flags and GitHub revision; current production clients use unchanged APIs.
Fresh whole-branch review; fix material findings with regression tests. Deploy stage1, apply migration, deploy flags-off Edge, enable join then ready with public verification. Run actual Auth/TLS/Supavisor/Realtime 20/42 checks where authenticated access exists. Verify GitHub CI/deployment and record versions, flags and rollback. Expected: verified release; disclose any unperformed real-device check. Commit/push final evidence.
