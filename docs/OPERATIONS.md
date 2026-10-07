# 運用と初期設定

## 配信先

- Pages: https://koichem.github.io/IonicFormulaCompetition/
- Supabase project: IonicFormulaCompetition / slktkbpvvsfpflnmpuvr
- 実際のリージョン: Seoul (ap-northeast-2)。既存プロジェクトを使用。

## Googleログインの初期設定

1. Google CloudでWebアプリ用OAuthクライアントを作成します。
2. 承認済みJavaScript生成元: `https://koichem.github.io`。
3. 承認済みリダイレクトURI: `https://slktkbpvvsfpflnmpuvr.supabase.co/auth/v1/callback`。
4. Supabase Authentication > Sign In / Providers > GoogleでClient IDとClient Secretを登録して有効化します。Secretはソースやチャットへ貼り付けません。
5. Google同意画面がTestingの場合、利用する教員のメールをテストユーザーに追加します。学校管理のGoogleアカウントは管理者ポリシーも確認します。
6. Pagesの「クラスコンペ」からGoogleログインし、マスター教員の管理画面を確認します。

Auth Site URLとRedirect URLはPagesの末尾 `/` 付きURLです。教員認証はブラウザーのGoogleログインだけでは完了せず、アプリでGoogle認証を行います。許可教員だけに教員権限を与えます。

## API更新

```sh
supabase login
supabase db push --linked --project-ref slktkbpvvsfpflnmpuvr
pnpm edge:bundle
supabase functions deploy competition --project-ref slktkbpvvsfpflnmpuvr --use-api
```

バックエンド秘密設定: `MASTER_TEACHER_EMAIL`, `ALLOWED_ORIGINS`。DB接続は既定の `SUPABASE_DB_URL` の資格情報をサーバー内で再利用し、このプロジェクトのTransaction pooler（`aws-0-ap-northeast-2.pooler.supabase.com:6543`）へ接続します。直接接続はEdgeの短命インスタンスごとに接続を占有して53300エラーになったため切り替えました。別プロジェクトへ移す場合は接続先を再確認してください。必要時のみ `COMPETITION_DATABASE_URL` で上書きします。公開設定には秘密キーを入れません。

`verify_jwt=false` はEdge入口の旧JWT検査を使わない設定です。APIはすべて、このプロジェクトのAuth `/user` でJWTを検証してから処理します。データ表はanon/authenticatedから直接読めず、Realtimeもprivate購読の権限をDBで判定します。

## 無料枠と共有回線

- 匿名サインアップは300回/時/IP。5クラス各42名の初回参加を想定した有限の制限です。学校回線での実機検証は別途必要です。
- CAPTCHAは未設定です。公開運用時はAuthの利用数を監視し、乱用が見られた場合はTurnstile等と学校端末での通過確認を行ってから継続します。新規セッションは再利用し、毎問作り直しません。
- Realtimeのプロジェクト予算は1秒90メッセージの見積もり、各人2接続分を予約。42名+教員の制御通知で87、ホスト通知で3を予約します。初期目安70では2タブを見積もった制御通知が送れないため調整しました。
- 接続数は人数と同一ではありません。3タブ以上や複数端末、他アプリの利用まで含む正確な上限保証はできません。Dashboardの実測を優先し、超過時は通知を集約・延期しHTTPで確認します。
- 同時5クラス42名ではFreeの200接続枠を超える可能性があります。教員5名が登録されていることと、5クラス同時利用は異なります。
- Free枠は同じ組織の他プロジェクトと共有する項目があります。TaskKanriの利用分も確認します。料金プランの変更はこの実装では行いません。

## 保持・保守

既存の保持期間を維持: クラス7日、メイト1日、待機2時間。期限後はアクセスを拒否し、通常リクエスト時に期限切れの競技データを少量ずつ削除します。補助レート表・監査・outboxは `app_prune_auxiliary()` で清掃します。

匿名Authユーザーは自動削除されません。`scripts/anonymous-maintenance.mjs` は候補の点検用です。教員identity・存続中の参加資格・最近の利用があるユーザーは削除候補にしません。削除する場合は対象と件数を確認し、管理者がSupabase Auth管理画面で実施してください。

ログにトークン、全解答、秘密キーを出しません。エラー調査にはrequest IDと操作種別を使います。バックアップやデータ移行は別作業です。

時刻同期にはAPIの受信・送信時刻を使い、Auth処理・DB待機などのサーバー処理時間を通信遅延から除きます。ブラウザー側はAuthセッション取得後の実際のfetch開始時刻を測ります。ネットワーク経路の非対称性まで補正するものではありません。

## 出題設定と錯イオン

管理者教員の「管理設定」→「難易度を調整」で割合・配分・各教材の対象難易度を保存します。Google認証済みマスターだけが操作できます。保存は新規ルームへ適用され、既存ルームの作成時設定は固定されます。旧ルームの設定・結果は保持します。元Sites版revision5の設定を初期移植し、その後は各版で独立管理します。

新しいPostgreSQLテーブルはRLS有効・ブラウザ直接権限なしです。設定を含むJSONは管理者APIから取得し、公開クライアントへ教材マスターを同梱しません。
