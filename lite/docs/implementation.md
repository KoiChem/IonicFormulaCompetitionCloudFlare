# IonicFormulaCompetition Lite

Current scope update (2026-10-10): Google teacher authentication now protects class setup and new Room creation. The earlier no-Auth/disabled-roster constraints below record the original implementation scope.

Goal: 授業用クラスコンペを、1 Room = 1 SQLite-backed Durable Object、WebSocket中心で最大50人に提供する。
Spec: このチャットで承認されたLite仕様と3点の設計案。現行Worker・DB・実施データは変更・移行しない。

## Constraints
- Worker名 ionicformulacompetition-lite。現行の公開スクリプトは使わない。
- 正解数降順、所要時間昇順、両方同じなら同順位。既存の回答欄ごとの得点を継承。
- 即時採点、誤答ペナルティなし、再回答可、ヒントなし、パスあり。
- 生徒は本人の結果のみ。教員は管理tokenで全体結果・進行を扱う。
- 既存教材・出題・入力部品・CSSを参照。Auth、D1、outbox、polling、Mate本体を含めない。
- 通常操作はWebSocket 1往復。保存後に応答し、再接続時に本人向け状態を返す。

## Tasks
1. [x] Native Worker tests first: 50人・51人目拒否、二重送信、本人限定結果、再接続、締切、SQLite復帰。worker/index.ts・room.ts・protocol.tsを実装。
2. [x] Browser flow first: 教員作成→QR/コード参加→開始→回答/パス→終了→結果。既存入力・表示部品を使いApp・Player・Results・socketを実装。
3. [x] Lite全テスト・型検査・build・Worker dry-run。既存テストの回帰確認、Playwrightで狭幅・送信状態・再読み込み・通信エラーを確認。
4. [x] 対象ファイルのみcommit/push。専用設定から公開、build identity・公開画面・WSS・25/50人の参加/回答時間を確認。

## Review focus
- 同時参加と再接続を人数に二重計上しない。
- 応答喪失後の再送と複数タブで二重得点/次問誤操作が起きない。
- 再起動・切断中の終了、締切後の回答で得点が変わらない。
- 未認証/生徒に他人の結果・正解・管理tokenを返さない。
- IME確定中のEnter、タッチ入力、長い問題文、320px幅。

## Progress / decisions
- Current baseline: 571 tests passed, 3 load tests skipped (load flag not set).
- Reuse the existing 7-day class result retention and 2-hour waiting-room lifetime. Show the result deadline; no global history or settings DB.
- Use the existing 5-second synchronized countdown (excluded separately from latency reports). Prepare questions on Room creation to avoid preparation handshakes.
- Work in a dedicated branch in the existing checkout; all new files stay under lite/.

- Independent review found one recovery defect: credentials with a provisional waiting expiry were hidden after offline start. Browser identity now survives the maximum possible Room extension; the server remains authoritative for expiry. Regression covers local retention and browser restoration to results.
- Existing verification: 574 general tests, 28 native Cloudflare tests, 18 Worker WebSocket tests, typechecks/build passed. Lite verification: 20 tests, typechecks/build and dry-run.
- Local 50-client answer acknowledgment: median 34.0 ms, p95 47.5 ms, max 60.4 ms. See local-load.json. These are local-runtime measurements, not classroom/public latency.

- Published 2026-10-09: https://ionicformulacompetition-lite.koichem.workers.dev
- Source release: 584eaab68fa9a7d4527871a35c39c2b0276fc3d5; Worker version a73abe9a-1f91-40f5-88ab-0c86931517ef. HTML meta and /api/health agree. Existing Worker health stayed at 7b585fbb3994165cade617edc869f684c48c2f0f.
- Public browser flow passed: create/join/start/wrong/retry/pass/reload/offline-online/results, own-only student results, stale waiting expiry recovery, no page errors or failed requests. Home/settings/results widths 320–1280 and complex formula input at 320 px checked. Native camera/touch and school Wi-Fi remain unverified.
- Public simulated load (one development Mac): 25 students, answer median 52.8 ms / p95 64.1 ms; 50 students, median 91.1 ms / p95 97.8 ms / max 106.5 ms. All five answers per participant graded and saved; duplicates did not add points; 51st participant rejected in 50-person run. See public-load.json. Fixed 5-second countdown is separate.
- GitHub CI passed for source release: https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare/actions/runs/37944474909 . CI checks the existing app; Lite-specific 20 tests and build were run locally with the real Miniflare SQLite Durable Object runtime.

## 2026-10-10 通常版UI移植
- Home uses normal app home-card/header/join/navigation structure. Existing credentials are reachable through 過去の結果. At 390 px, normal public home and Lite have identical measured card/title/join dimensions, fonts, colors, and border radii.
- Setup uses the normal teacher-workspace and CompetitionSettingsForm markup (Lite immediate grading only). Added direct 難易度調整 entry. Copied normal dialog rendering and actual production configuration revision 3 via read-only SELECT; no competition or participant data copied and no production D1 writes.
- Profile edits live in this browser's localStorage; creation validates the submitted profile and generates the Room's fixed question set. No extra database or global teacher auth.
- Answer surface uses normal play-active/play-answering, scorebar, QuestionView, answer-area, FormulaKeyboard/NameKeyboard without-submit, ImmediateVerdict and the 2:3:2 action row. Shared original CSS remains unchanged. Review reuses ImmediateReviewList; passed questions can be retried before submission.
- Added minimal review/submit WebSocket commands and passed-field retry support; preserved seq-based duplicate protection, grading rules, max 50, and own-only results. No Room schema or binding changes.
- Review findings fixed: repeated final review requests, inaccessible wrong retry, inaccurate other-field state, lost submit after reload, and premature review navigation while retrying after the final question. Regression tests/browser repros added.
- Local validation: 24 tests, UI/Worker typecheck, production build, Worker dry-run. Browser tests cover 320–1280 layouts, actual keyboard input, profile save/reload, passed/wrong/retry, draft restore, final review after reload, stable single review request, submit/results, offline recovery. Local simulated 50-person answer p95 48.7 ms; no physical-device claim.
- Published UI release: e962554949800af683d7353b87cb67b1b76e5dd0, Worker version 21563d4e-81a9-4bac-88f7-42ecc5bf6e9a. Public HTML and health match. Existing normal Worker health remains 7b585fbb3994165cade617edc869f684c48c2f0f.
- Both public Playwright flows passed: browser-flow (ion name, full final review/retry/submit/reload) and ui-parity (profile persistence, compound formula/name keyboard, wrong retry and other-field state, draft restore, 320–1280 px). No browser errors; browser-flow reported no failed requests.
- Public 25/50 simulated participants passed after UI update. 50 answers: median 93.4 ms, p95 132.4 ms, max 139.9 ms from one development Mac. See public-load-ui.json; not a school-device benchmark or same-condition before/after comparison.
- Source release CI passed: https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare/actions/runs/37950216692 . Lite's 24 specific tests/build were verified locally separately.

## 2026-10-10 教員Google認証
- ユーザーの依頼により、クラスコンペ設定入口と新規Room作成をGoogle認証で保護。マスターは指定された taiyaki.taiyaki.taiyaki@gmail.com。マスターによる許可教員登録・解除、8時間session、logoutを追加。生徒と既存Roomの管理token経路は維持。
- 専用LiteTeachers SQLite DOに、教員一覧・session hash・10分OAuth transactionを保存。scopeはopenid email、JWT署名/claims、browser-bound one-time state、nonce、S256 PKCE、CSRFを検証。D1/Supabase/通常版のデータを使わない。
- 新規認証テスト10件を含むLite 41件、UI/Worker型検査、build、Worker dry-run成功。署名付きID tokenを使ったcallbackから実session、Room作成まで検証。外部Google endpointsのみlocal fixtureで代替。既存アプリの回帰テスト571件も通過（負荷flag未指定の3件はskip）。
- Playwright MCPで匿名設定画面/作成APIの拒否、許可教員画面、マスターのみ一覧操作、登録・解除・検索保持・再読込・logout、管理画面320/390/768/1280px、既存の教員作成→生徒参加→誤答→パス→提出→結果→offline再接続を検証。page errorsなし、競技flowのrequest failuresなし。
- 独立レビューで重要な認証不具合なし。指摘されたlocal APP_ORIGINと負荷測定時のteacher session/CSRF導線を修正。
- 認証済み許可教員のcookieからsession/CSRFを取得する負荷検証導線で、local 25/50人の参加・全5問の採点/保存・重複得点防止・51人目拒否を再確認。結果は `/private/tmp/lite-auth-load.json`。これは開発Macのローカルfixtureであり実Googleログインや本番速度の証拠ではない。
- Code commits: 814db1f, e1ba43d。Lite branchへpush済み。Google redirect保存とGoogle client secretのLite Workerへの保存はユーザー確認待ち。secret転送はauto-reviewで明示許可不足として拒否されたため、公開はまだ実行していない。現在の公開Liteはfd91d503、通常版は7b585fbbのまま。
