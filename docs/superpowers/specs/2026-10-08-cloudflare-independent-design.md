# Cloudflare独立版 — Phase 2〜4設計

日付: 2026-10-08 JST。状態: 設計レビュー用。独立版の実装・公開はまだ完了していない。

## 依頼と完成の意味

ユーザーの「独立版を進めて」をPhase 2〜4への範囲拡張として扱う。元添付文書のPhase 1限定は今回の依頼を制限しない。実装先はKoiChem/IonicFormulaCompetitionCloudFlareのみ。

Cloudflare版の通常運用でSupabase DB、Auth、Functions、Realtimeへの通信をゼロにする。GitHubはコード管理・CI・自動公開に引き続き使う。Googleは教員ログインの本人確認に使う。競技データ・権限・セッションはCloudflareに置く。

既存GitHub Pages＋Supabase版は独立して維持する。既存サービスのCORS追加、停止、削除、実データ移送、他アプリの権限変更は行わない。旧版の参加資格・room・結果は新版に引き継がれない。新規競技と独立した教員許可で開始する。

ユーザー回答: 初期マスターは現在と同じGoogleアカウント。正確なメールとOAuth secretは公開ソースに書かず、クラウド設定時に確認する。その他教員は新版マスターが登録する。既存allowlistを勝手に複製しない。

## 現在地

- 公開コード18bdcd6110cd8cd12a85bb30c86e247d0c825890、記録main2f5c2c1。Workerはhealth/staticのみ、画面はSupabase版のtransportを使用。
- D1 baselineとcommand原子性はPhase 1で検証済み。ローカル546＋18、remote D1 13。これを独立APIやWSの完成証拠として流用しない。
- src/platform/http.tsのcreateApiHandlersは認証provider、database、serverConfigを注入できる。現行Supabase gatewayはPG transaction、匿名UID、membership、shared teacher、outboxに依存するためそのままWorkerへ載せない。
- src/web/api.ts、realtime.ts、supabase.ts、main.tsx、useStartRoom.tsx等にSupabase依存がある。認証・通信の境界を置換し、画面/化学/採点の全面rewriteは避ける。
- 現行schedulerはWS接続中も定期照会を続ける。独立版ではイベント・復帰・締切を中心にする。

## 選択肢と採用案

1. **Worker＋Google OIDC、D1を正、Room DO＋Hibernation WS（採用案）**。既存Googleログインを維持でき、独立権限と既存D1資産を再利用する。
2. Cloudflare Accessで教員認証。Access用設定・別のログイン境界が増え、生徒の公開参加経路を除外する管理も必要なため今回採用しない。
3. DO SQLiteを競技状態の正にしD1へ結果転送。転送復旧と保存先二重化が増えるため採用しない。

Cloudflare公式workers-oauth-providerはOAuth認可サーバー/API向け。Googleへのログインclientにその全体を導入する理由はない。署名検証はWorkers対応の標準JWTライブラリを選定・固定し、JWT暗号検証を独自実装しない。

## 構成と責務

Static Assets → React SPA → 同一originの /api/* → Worker/Room DO → D1。

- Worker: route判定、認証、origin/CSRF/入力検証、公共設定、教員管理、Google callback、静的配信。
- Room DO: public room IDから1つを決定。room APIの更新と状態遷移を直列化し、既存handlers＋D1 commandを実行。WebSocket/alarms/通知を調整。
- D1: room、参加者credential hash、操作、結果、設定、receipt、教員identity、session、OAuth transaction、通知revisionの永続的な正。
- DO SQLite: alarm予定、通知再試行等の運用metadataのみ。D1競技状態を別の正として二重保存しない。Free対応のnew_sqlite_classesを使用。

DOのfetchがasyncであるだけでは直列化にならない。明示的command queueでawait間の競合を防ぎ、既存D1 CAS・UNIQUE・receiptも残す。長い全処理をblockConcurrencyWhileに入れない。外部Google通信はroom queueに入れない。

## 認証・認可

### 教員

- /api/auth/google/start → Google → /api/auth/google/callback。Google Cloudには新版callbackを追加し、既存Supabase callbackを残す。
- Google OIDC authorization code、state、nonce、PKCEを使用。transactionは短寿命・一回限り・ブラウザcookieとの一致必須。固定callback/same-origin戻り先のみ許可。
- ID tokenの署名、issuer、audience、expiry、nonce、email_verifiedを検証。永続identityはGoogle sub。メールでallowlist確認するが、同じメールの別subへの乗っ取りを許さない。
- D1 sessionは乱数tokenのhashを保存。__Host- cookie、Secure、HttpOnly、SameSite=Lax、Path=/。有効期間8時間。ログアウトはsession失効。
- masterEmailはWorker secret。初回設定時に正規化した設定をD1へ固定し、誤ったsecret切替はfail closed。master以外はteacher_allowlist必須。
- 各教員APIとWS handshakeで有効session/allowlist/ownershipを確認。allowlist失効後に既存WSのhost通知を送り続けない。現行他アプリ共有権限には問い合わせない。
- cookie認証の変更操作は同一origin＋CSRF tokenを要求。CORSを全originに開かない。

### 生徒・Mate host

- 恒久アカウントとSupabase匿名認証は不要。既存room-scoped 32byte乱数token＋SHA256 hashを再利用し、Authorization headerで送る。tokenをURL/query/logへ入れない。
- browser creation keyは同一request再送とMate作成制限用であり、本人認証や教員権限として信用しない。適切なrate limitをWorker/DO側で実施。
- WSはupgrade後、最初の認証messageでroom tokenを送る。認証前にデータ配信せず、短い認証期限を設ける。roleをクライアント申告から決めない。
- 別room/別参加者のtoken、REMOVED、期限切れは拒否。Mate hostと教員ownerの区別を維持。

## HTTP契約と保存

createApiHandlersのpublic-config/join-info、class-rooms/mate-rooms、teacher session/allowlist/question-profile/site-settingsを維持。room state/join/nickname/settings/start-status/start/manifest/ready/cancel-preparation/operations/writer/cancel/interrupt/remove/actions/results/result-summaryを維持。未知path404、method405、JSON error契約、requestIdの照合を維持する。

route registryはSupabase gatewayから純粋moduleへ分離。Supabase gateway/PG runtimeをWorker実行bundleへ入れない。D1のtransactional=falseを維持し、handlersの複数batch・post-read更新・lazy cleanupを監査する。room更新を全て同じDOへ通し、同時設定/開始/割込みの競合を追加検証。

追加migrationは適用済み0001を改変せず、OAuth/session/Google subject bindingとroom通知revisionを追加する。D1 auth情報とroom tokenはhashのみ。cleanup対象とindexを明示し、期限切れ認可拒否はcleanup成功に依存させない。

## 通知・再接続・期限

- acceptWebSocket/serializeAttachmentによるHibernation WSを利用。復帰時にD1からroom状態を確認し、attachmentのroleを無条件に信用しない。
- control通知はphase/settings/start/cutoff/expiry等の全員向け変更。host通知は名簿/ready/進捗。joinごとに全生徒がstate fetchする構造を避ける。
- eventはroomId/epoch/revision/eventId/kind等に限定し、private解答・token・他生徒reviewを含めない。host進捗は集約して現行UIの頻度を維持。
- 成功ACKはD1 commit後。DO停止がcommit直後に起きても、永続revision＋alarmによる再通知、再接続時のHTTP snapshotで回復する。WSのexactly-once配信は保証しない。
- 通常接続時は短周期pollingしない。接続/復帰時snapshot、イベント時coalesced fetch、締切タイマーを利用。切断時のみ指数backoff・jitter・Retry-Afterに沿って復旧。非表示時の頻繁照会を停止する。
- DO alarmでdeadline/collection終了の遷移と確定を進める。sleep/restartからD1に基づいて再構成する。alarmは遅延し得るためHTTP側もserver期限を確認し、締切後の得点保存を拒否する。
- Cronで期限切れD1/session/OAuth transactionをbounded cleanup。結果保持Class7日、Mate24時間等は現行を維持。

## 競技契約

Class50、51人目拒否、Mate4。教材、難易度、錯イオン、同問題同順序、日本語、QR、キーボード、即時/一括採点、pass、割込み、レビュー、同順位を維持。

v2のelapsedMs＋server単調性/未来時刻/締切検証契約を維持。端末wall clockだけをauthorityにしない。悪意ある過去elapsedの完全防止を今回完成条件として新たに約束しない。

即時採点の出題分answer snapshot契約は維持し、教材全体は配布しない。出題分自体を秘匿する変更は通信/採点モデルの別変更であり今回は追加しない。

## 実装単位と公開順序

1. route/auth/frontend transport境界、D1 auth migration、native Worker API。未完了コードはfeature branchで扱う。
2. Room DO、authenticated WS、通知/alarms、frontendイベント同期。D1のみのAPIを一般向け完成版として先に公開しない。
3. 独立教員/生徒/Mate UI・Supabase実行依存除去・全contract/認可/load/browser検証。
4. Google secret/callback・master設定、test環境でremote/API/WSを検証、候補への自動公開、公開URLの独立性確認。

必要なGoogle Cloud設定は具体的callbackとscopeを用意してから実施。secret/認証入力が必要な場合はユーザー操作へ渡す。旧サービスへの設定変更はしない。

## 受入証拠

- 現行546＋D1 tests維持。Google署名/claim/state/nonce/CSRF/session失効、許可失効、master/teacher/host/participant認可、他生徒結果拒否を追加。
- 実workerd/D1/DOでcreate/join/ready/start/submit/pass/interrupt/deadline/results/review、両採点mode、receipt再送、generation/writer競合、alarm復旧を検証。
- 50clientsと複数roomでHTTP＋実WS完走。51人目拒否、host通知隔離、切断/再接続/非表示復帰、room期限、教員失効を確認。テスト用authはtest設定限定で、本番bundleに入れない。
- Playwright MCPでdesktop/390px teacher/student/Mate/QR/結果/レビュー、console/network/layoutを確認。ネットワーク記録とruntime bundleからSupabase通信・SDK依存ゼロを確認。
- remote D1だけでなく、公開Worker APIと実WSで検証。Google本番loginと物理iPhone/iPadの証拠をローカルfixtureと区別する。
- D1 rows/DO requests/CPU/WS使用量を測定し、Free枠内SLAを測定せず断言しない。未知の利用数を前提に無制限無料とはしない。
- healthはcompetitionBackend=cloudflare、activeClass50、D1/DO/auth準備状態を明示。公開SHA、CI/Build、静的hashを個別に確認。
- 秘密を含まない運用・障害復旧・新旧データ分離・rollback文書を残す。旧版URLは利用可能でも新版競技の継続先にはならない。

## 参照

- [Cloudflare Hibernation WS](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare WS server example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [DO pricing / Free SQLite](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google OIDC reference](https://developers.google.com/identity/openid-connect/reference)
- [Cloudflare workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)

設計自己確認: Phase 1限定の旧文書と今回の範囲拡張を分離。D1/DOの二重正・Supabase権限依存・全生徒短周期poll・未検証公開完了表現を避ける。実機/本番Google/Free実測は別証拠。初期masterの正確なメールとOAuth secret以外に仕様上の未決定項目はない。
