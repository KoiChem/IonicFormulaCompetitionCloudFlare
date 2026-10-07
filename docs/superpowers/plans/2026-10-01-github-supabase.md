# GitHub Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task.

**Goal:** 既存の競技を独立したPagesアプリとしてSupabaseへ移植し、検証・公開する。
**Architecture:** React SPAの認証/通信/ルーティングを交換し、現行のv2採点・競技UIを再利用する。Edge APIでPostgresトランザクション内の既存競技ロジックを実行し、private Broadcastを配信する。
**Tech Stack:** React, Vite, Supabase Auth/Realtime/Edge, Postgres, Vitest, Playwright。
**Spec:** ../specs/2026-10-01-github-supabase-google-realtime-sol.md

## Global Constraints

- Pages base `/IonicFormulaCompetition/`、Hash routing、Google PKCE。
- 教員許可リストとUID binding、生徒匿名Auth、参加トークン復帰。
- 42名/クラス、v2両方式、idempotency、収集10秒、保持期限を維持。
- 私的Broadcast、参加者全員へ生解答を送らない、権限失効時topic更新。
- 秘密情報はビルド・Git・ログに含めない。既存版と親Gitへ変更を加えない。

## Review Focus

- PostgresのSQL方言変換が数値/JSON/nullと原子的更新を維持する。
- 同一IPの初回匿名認証、認証喪失、Google callbackとHashの競合。
- 権限を持たない端末のteacher/host topicとトークン所持者の復帰。
- 収集/確定の競合と通知断時の復帰、前面復帰時の時計。
- Pages直リンク・資産参照・全既存UI操作のルート。

### Task 1: Static SPA and transport

Files: `src/web/*`, `app/teacher/page.tsx`, `src/features/play/useRoomSync.ts`, app/client links, `package.json`, `vite.config.ts`, `tests/web/*`.
Interfaces: `appPath(path)`, `apiFetch(path, init)`, `getSupabaseClient()`, `ensureSession()`。
- [ ] Hash URLと参加Bearerを維持しAuth JWTを別ヘッダーへ渡すテストを先に実行し失敗確認。
- [ ] SPA routes、Googleログイン、設定未完了表示、既存リンクを実装。
- [ ] `npm test -- tests/web`、typecheck/build、ブラウザー画面確認。

### Task 2: Postgres backend and authorization

Files: `src/platform/postgres-*`, `src/platform/supabase-*`, `supabase/*`, `tests/postgres/*`。
Interfaces: PersistenceDatabaseをPostgres transactionへ適合、APIは既存JSON契約。
- [ ] PGlite実Postgres engineでroom作成/参加/準備/両方式/確定とrollback/receiptを失敗確認。
- [ ] schemaを移植、JSON/時刻/placeholder方言を変換し、request全体のtransactionとroom lockを実装。
- [ ] Google検証・UID binding・匿名membership・復帰・topic認可を実装し許可/拒否を検証。
- [ ] 関連テスト、既存競技回帰、Edge bundle/typecheck。

### Task 3: Realtime and recovery

Files: `src/web/realtime-*`, `src/platform/realtime-*`, `supabase/migrations/*`, `useRoomSync.ts`, `tests/web/*`, `tests/postgres/*`。
- [ ] 重複revision/切断復帰/host分離/outbox集約/権限失効を失敗確認。
- [ ] 一つのsocket、private topics、outbox、配信予算、定期確認とboundary確認を実装。
- [ ] 通知を落とした競技の確定と復帰、接続/配信数の見積もりを検証。

### Task 4: Verify and publish

Files: `.github/workflows/pages.yml`, `scripts/*`, `README.md`, `docs/IMPLEMENTATION_PROGRESS.md`, `docs/RELEASE_VERIFICATION.md`。
- [ ] 全suite/typecheck/build/diff check、Playwright local flows/layout/console/network。
- [ ] fresh reviewerで全変更をレビューし重大指摘を修正・検証。
- [ ] 指定プロジェクトへmigration/Edge/Auth設定を適用し実サービス検証。
- [ ] 対象remoteへcommit/push、Pages成功、配信assetと公開flowを確認。

外部設定不足は具体的に記録し、設定不要な実装・検証を継続する。利用者が公開まで明示承認済みのため再承認は求めない。
