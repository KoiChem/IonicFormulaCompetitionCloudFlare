# Classroom performance phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 一斉参加時の状態取得を開始処理から分離し、通知保留と認証障害から回復できるようにして公開する。
**Architecture:** readonly snapshotとcommandを分け、境界遷移・資格再関連付けだけcommandへ戻す。既存Auth検証、room lock、receipt、outbox leaseを維持する。
**Tech Stack:** TypeScript/React/Vite、Supabase Edge/Postgres.js、Vitest/PostgreSQL/Playwright。
**Spec:** ../specs/2026-10-05-classroom-performance-phase2-design.md

## Global Constraints
- 既存QR回復、start requestId/revision、v1/v2、class/mate、採点、保存期間、人数上限を維持。
- 未検証JWTを認可に利用しない。JWKSは条件付きで今回remote Auth維持。
- 本番の大量負荷は行わず、使い捨てDBで測定。

## Review Focus
- readonly snapshotが期限/全員提出のfinalizeを止めない。
- REMOVED、uid再関連付け、Google教員binding/allowlistを誤認しない。
- 予算skip後に追加APIがなくても再送し、worker終了後のoutboxを回復。
- scheduler停止/room変更で古いタイマーや取得が残らない。
- pool総数とquota待ちがstart-statusを圧迫しない。

### Task 1: Auth errors and request metrics
Files: supabase-identity.ts、supabase-gateway.ts、web/api.ts、identity/API tests。
- [x] Auth5xx/429/不正JSONの回帰をRED→GREEN。401時refreshはsingle-flight、503で資格維持、POST再送なし。
- [x] 成功ログの標本抽出とquota/retry計測を追加し、秘密値を含めないテスト。

### Task 2: Snapshot routes and compact readiness
Files: http.ts、supabase-gateway.ts、postgres-runtime.ts、v2-manifest.ts、gateway tests。
- [x] WAITING/PREPARING state、manifest/realtimeはreadonlyでwrite/flushゼロの回帰をRED→GREEN。
- [x] 境界/全員提出/正当なrebindはcommand fallback、取消/削除/期限切れ回帰。
- [x] preloaded room/identityとtopicsでSQL再取得削減、readyの不要名簿比較削減。
- [x] command1/read1/critical1の分離、flag rollback。総接続枠比較試験を用意。

### Task 3: Durable outbox recovery and maintenance
Files: realtime-outbox.ts、edge-entry.ts、maintenance migration、outbox tests。
- [x] skip/送信失敗のnextEligibleAtを返し、bounded retryをRED→GREEN。外部待ちにtransactionなし。
- [x] worker終了後の定期回復経路と期限切れ清掃を追加。既存データ/保持期間を維持。

### Task 4: Unified sync scheduling
Files: useRoomSync.ts、sync scheduler、realtime-policy.ts、UI tests。
- [x] notification/poll/visibilityを統合しhost取得間隔、後続dirty、Retry-After、停止回帰をRED→GREEN。
- [x] WAITING/PREPARING参加者の通知欠落fallbackを短縮、clock境界維持。

### Task 5: Verification and release
- [x] 全テスト、typecheck/build/bundle、diff check、実PG30回/人数、matrix/競合。
- [x] idle timeout A/B、flush有効/複数runtime/同時2室を測定し報告。
- [x] fresh reviewerによる全差分レビューと必要修正。
- [x] Edge先行→旧Pages互換→push/Pages deploy→公開Playwright/asset確認。

本番大人数・物理端末・最大isolate数の未測定範囲はCLASSROOM_PERFORMANCE_PHASE2_VERIFICATION.mdに記録。公開少人数確認と使い捨てDB試験を区別する。
