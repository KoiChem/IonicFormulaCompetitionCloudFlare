# Cloudflare独立版の運用

Cloudflare版は同一originのWorker API、D1、SQLite-backed RoomCoordinator DO/Hibernation WS、直接Google OIDCで動く。旧版のSupabase DB/Auth/Functions/Realtimeとは共有しない。旧版データを移送しない。旧版は https://koichem.github.io/IonicFormulaCompetition/ 。新版は https://ionicformulacompetition.koichem.workers.dev/ 。

## 認証と権限

`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`MASTER_TEACHER_EMAIL`はWrangler secret。ソース/VITE環境/チャット/ログへ出さない。`APP_ORIGIN`は本番または専用検証Workerの正確なHTTPS origin。Google clientには`APP_ORIGIN/api/auth/google/callback`を登録し、openid/emailのみ取得する。初期masterは既存と同じGoogleアカウント、新D1のallowlistは空からmasterが登録する。

8時間のHttpOnly/Secure/SameSite=Lax/__Host-cookie sessionを使う。session/token/state/nonceはD1にhashとして保存（PKCE verifierは一回限り10分transactionに短期保存）。メールとGoogle subを固定し、allowlist失効はHTTPと通知時のWS再認可へ反映する。master変更はcf_auth_configとの不一致で停止するため、設定を勝手に変えない。

## 配備と監視

`pnpm verify:cloudflare`がローカル必須検証。`pnpm deploy:cloudflare`はHEADのSHAをRELEASE_SHAに渡す。mainへのpush後Cloudflare BuildsとGitHub CIを個別確認し、healthのbuild/static assetsも公開URLで確認する。`/api/health`は必要9テーブル・認証設定・DO RPCが揃わないと503。健康状態に秘密値を含めない。

Class50、Mate4。D1が正、DOはroom commandを直列化。D1のCAS/receiptは残す。WSの生徒tokenは最初のmessageだけでURLへ入れない。host通知は2秒で集約、生徒はcontrol通知のみ。接続中は定期HTTPをせず、イベント・締切・復帰時に再取得。接続断ではbounded polling/reconnectへ戻る。未認証WSは5秒、message4KiB、roomあたり接続110上限。

alarmはcountdown/start/deadline/collection/未送信通知/認証・room期限を処理する。D1 command前に復旧alarmを保存し、commit後の停止でもD1 fingerprint/revisionから回復する。DO storageはpublicId/通知集約時刻等の運用metadataのみ。15分Cronはroom・receipt・session・OAuth期限を各100件のbounded batchで削除する。定期的にCloudflare UsageのD1 rows、CPU、DO request/WSとErrorsを確認する。

専用test Worker名`ionicformulacompetition-phase1-test`、D1 UUID`908e08e6-0b70-454b-a97d-0528fde1706e`。本番D1 UUID`a0475c35-c39b-4c73-b7e2-51e05a899483`。検証用のtest認証endpointはtest bundleのみで公開Workerには入れない。remote検証は自分で作ったnamed testroomのみを使用し、旧版や本番の別roomを削除しない。

## 戻す場合

直前の検証済みCloudflare deploymentへrollbackする。additive migrationは残す。旧Supabase版に戻る場合は旧URLを使う。新版room/session/結果は旧版で継続できないため、進行中roomを勝手に移送せず公開案内と区別する。旧サービスの停止や削除はこの作業に含まれない。

## 出先のブラウザでできるOAuth準備

Google Cloud Consoleのプロジェクト `IonicFormulaCompetition`（`ionicformulacompetition`）を開き、Google Auth Platform → クライアント → クライアントを作成。
既に `IonicFormulaCompetition Cloudflare Independent` があれば新規作成を重複せず、その設定を確認する。

- 種類: ウェブ アプリケーション
- 名前: `IonicFormulaCompetition Cloudflare Independent`
- 承認済みのJavaScript生成元（保存画面が入力を求める場合は以下の2件。パスなし）:
  - `https://ionicformulacompetition.koichem.workers.dev`
  - `https://ionicformulacompetition-phase1-test.koichem.workers.dev`
- 承認済みのリダイレクトURI（2件）:
  - `https://ionicformulacompetition.koichem.workers.dev/api/auth/google/callback`
  - `https://ionicformulacompetition-phase1-test.koichem.workers.dev/api/auth/google/callback`

作成時にクライアントIDとシークレットを保管する（チャットには貼らない）。既存の `IonicFormulaCompetition Web` は変更しない。
Cloudflare Dashboard → Workers & Pages → `ionicformulacompetition-phase1-test` → Settings → Variables and Secrets で、以下を Secret として設定・保存する。

| 名前 | 値 |
| --- | --- |
| GOOGLE_CLIENT_ID | 作成した専用クライアントのID |
| GOOGLE_CLIENT_SECRET | 作成した専用クライアントのシークレット |
| MASTER_TEACHER_EMAIL | 初期マスターとして合意したGoogleアカウントのメール |

今回は検証Workerのみ。`APP_ORIGIN` は既存設定を維持する。完了報告には「検証Workerの3項目を設定済み」とだけ書く。
本番への秘密設定・D1 migration・main統合・公開検証は、検証Workerで実Googleログインを確認してから実施する。

参考: https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred
