# Host start timeout implementation plan

Spec: ../specs/2026-10-05-host-start-timeout-design.md
Execution: inline; implementation, verification, push and publication authorized by the user.

1. Add read-only start-status, quota isolation, runtime read pool and request diagnostics. Test missing/committed/cancelled receipts and owner authorization with PostgreSQL fixtures.
2. Add durable start draft/controller and integrate class/mate host UI. Test timeout recovery, uncertain results, stale revision, cancellation, storage failure and reload.
3. Share one room sync provider across parent/player components. Preserve trailing refresh, clock sampling, cleanup, and host notification throttling.
4. Split outbox claim/send/ack, sanitize legacy payloads, coalesce flushes. Test network wait outside transaction, revocation, failed send and replacement event races.
5. Bulk insert questions, replay start receipts before generation, sample preparation/countdown time late. Verify v1/v2 atomicity and deadline behavior.
6. Run full suite/build and real PostgreSQL concurrency/load checks. Verify 20/42 flows and delayed responses with Playwright; fix measured bottlenecks.
7. Independent review, commit/push, deploy backend then Pages, verify public assets and service flow. Record evidence and limits.

Global constraints: preserve prior uncommitted join fixes, chemistry/grading, limits, retention and shared teacher authority. No production load fixture without separate authorization. Use temporary validation DB. No waiting for additional approval already provided for this work.
