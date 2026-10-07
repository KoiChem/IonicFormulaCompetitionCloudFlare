# Phase 2 execution ledger

Baseline: edd1473. Approved spec: docs/superpowers/specs/2026-10-05-classroom-performance-phase2-design.md.

Ruling: 既存checkoutで作業する — 既存の仕様ファイルを保持し、今回の作業以外の変更がないことを確認済み。新worktreeは作らない — 並行編集が入れば差分を再確認する。
Ruling: JWKSは今回導入しない — 認証失効/Google本人確認契約を維持する仕様の初回リリース方針 — Auth通信往復は残る。
Task 1: Auth503/429/incomplete responseを401と分離 RED→GREEN (identity3 tests)。同時401 refresh共有1 test成功。gatewayのquota時間/成功サンプリングを追加。
Task 2: snapshot state/manifest write&flushゼロ RED→GREEN、uid回復・claimed participant mismatch・期限finalize回帰成功。v2-readyの再取得はcountdown確定時だけ。短い負荷2回/人数でstart20 max851ms、start42 max1147ms、ready20 max3696ms、ready42 max7338ms。
Task 3: outbox予算skipの次回時刻 RED→GREEN、retryRoomDrainの追加APIなし再実行/上限を確認。
Task 4: scheduler poll/通知統合、dirty後続、停止、Retry-After 3 tests成功。参加者WAITING4.5秒/PREPARING2.5秒（jitter込みで概ね5/3秒）。
Task 3: protected maintenance lease/healthと期限切れ清掃、最終回収試行の古い順のfair rotationを追加。maintenance2 tests成功。pg_cron/pg_net/Vaultの毎分回収setupを準備。
Task 4: in-flight中hostイベントを落とさない回帰 RED→GREEN、scheduler4 tests成功。
Verification: RUN_LOAD=1 whole suite 524/524成功（maintenance fairness追加前）。typecheck成功。
Ruling: idle_timeoutは1秒を維持して比較する — 接続寿命延長だけでpooler占有を増やさない — 再接続の改善余地は計測後に判断する。
Final review: independent reviewer found two Important issues, no Critical/minor.
Final: fixed status admission behind quota burst — critical-queue helper + gateway42-burst RED(index44)→GREEN(index<=3).
Final: fixed phase change rejecting queued refresh — Playwright PREPARING poll hold→cancel→WAITING reproduced alert 'Room synchronization stopped' RED; scheduler now survives phase changes, fresh requests remain owned by room identity.
Final: Ruling: production pool/latency, installed cron/Vault, worker recovery, device lifecycle, full concurrency and 30-run metrics require runtime evidence — perform these validations separately, no review claim substitutes for them — public large-class evidence remains limited by available test environment.
Final verification: 529/529 tests, typecheck/build/bundle/diff check pass. 30 trials per size: start p95 842/1149ms, ready p95 3718/7377ms, command/read/critical each1. Two-pool control 2 trials per size improves start but ready42 max9743ms exceeds production goal; select tested 3-pool topology.
Final verification: 2 runtimes, concurrent20/42 rooms, all8 settings, flush enabled30ms, 96 deliveries, injected failure and worker recovery verified. PG lock snapshot20ms; external HTTP transaction0; rollback verified.
Final: Ruling: retain idle_timeout1 — localhost warm gain only several milliseconds; production TLS/pooler and maximum isolate count remain unmeasured — no connection lifetime increase.
Final publication: additive migrations applied (including prior missing shared-teacher tables), Edge21 ACTIVE, private secret/Vault + every-minute cron with3 HTTP200 and pending0. Old/new Pages both completed actual-service2-player mate. New asset hash matches local; CI build/deploy success at Actions37307524370. Public UI no page/console/network errors; class20/42 physical-school trial remains a separate limitation. Full evidence: CLASSROOM_PERFORMANCE_PHASE2_VERIFICATION.md.
