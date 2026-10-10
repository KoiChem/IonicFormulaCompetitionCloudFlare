# IonicFormulaCompetition Lite

授業用、最大50人のクラスコンペ。現行アプリの教材・出題・採点・入力・QR・走者表示を使い、保存と競技操作を1 Room = 1 SQLite-backed Durable Objectにまとめています。

## 使い方
- 教員：「クラスコンペ」→Googleでログイン→設定→作成→QR/参加コードを共有→「問題を準備して開始」。マスター教員または登録済みの許可教員が利用できます。生徒にGoogle認証は不要です。
- 生徒：QRまたはコードからnicknameで参加。正解数優先、同点は所要時間順。同条件は同順位。
- 設定画面の「管理設定」→「難易度を調整」から、通常版と同じ割合・イオン・化合物の設定を変更できます。初期値は通常版の保存済み設定（revision 3、2026-10-10再照合済み）です。変更はこのブラウザに保存し、新しく作成するRoomの出題に反映します。
- 問題毎判定とまとめて判定を選択できます。問題毎判定は誤答ペナルティなし、再回答可、ヒントなし、パスあり。「全解答確認」からパスした問題を再解答し、「このまま提出」で確定できます。全問正解なら自動で提出します。組成式と名称の両方を答える設定は各欄1点。
- 生徒は上位3位と自分の結果・復習、教員は全体結果を閲覧。管理tokenはQRに含めません。
- 同じブラウザから再読み込み・ホームの「過去の結果」で復帰。管理/参加情報はブラウザに保存するので、作成したブラウザを使ってください。
- 待機Roomは2時間、開始したRoomと結果は7日間保存し、期限後はRoomのデータを削除します。期限は過去の結果画面に表示。
- メイトマッチとメイト作成カードはdisabled表示です。マスター教員は「管理設定」から許可教員を最大100人まで登録・解除できます。マスターは taiyaki.taiyaki.taiyaki@gmail.com で固定し、一覧から解除できません。
- まとめて判定は入力を端末とRoomに保存し、提出時に採点します。時間切れ・教員中断では締切以前に入力した記録を最長3秒回収し、確定します。回収できない場合は結果に「最終同期未確認」を表示します。
- 待機中は競技設定・ニックネームの変更、参加者の除外、ルーム終了ができます。

## 開発・検証・公開
既存リポジトリのNode/pnpmとインストール済み依存を利用します。リポジトリルートで `pnpm install --frozen-lockfile` の後：

```sh
pnpm --dir lite test
pnpm --dir lite build
pnpm --dir lite dev:fixture
# 別terminal。以下のcookieはローカルfixture専用のダミー値です。
LITE_TEACHER_COOKIE="__Host-ionic-lite-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" pnpm --dir lite load http://localhost:8791
LITE_TEACHER_COOKIE="__Host-ionic-lite-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" pnpm --dir lite load http://localhost:8791 /private/tmp/lite-deferred.json --deferred
pnpm --dir lite deploy
```

公開は `lite/deploy.mjs` だけを使います。Worker名・LiteRoom・D1なしを検査してから、専用設定 `lite/wrangler.jsonc` に対してdeployします。現行版用のルートのdeployコマンドは使いません。公開成果物のcommitは `/api/health` とHTMLの `lite-release` metaで確認できます。

Playwright MCPで `tests/browser-flow.js` の関数を実行すると、教員作成・参加・誤答・パス・再読み込み・offline/online復帰・上位3位と本人の復習・320/390/768/1280pxを検証できます。`tests/ui-parity.js` は通常版の独立fixtureとホーム・設定の座標・寸法・フォント・余白を比較し、難易度保存も確認します。`tests/keyboard-flow.js` は式入力、両欄パス・再解答・入力復元を、`tests/deferred-flow.js` はまとめて判定・参加応答の欠落・除外後の再参加・別タブ切替・締切直前の入力・保存応答待ちの提出を検証します。`load.mjs` は25/50人の接続・正答・重複送信を検証し、1往復の時間を出力します。計測対象はLiteのURLに限定しています。

## 構成
WorkerはRoom作成、静的配信、WebSocketの転送のみ。LiteRoom内の `room`、`participants`、`answers` の3テーブルで進行を管理し、同期SQLiteトランザクションで登録上限・採点・操作番号を更新します。回答は本人に判定と次問を返し、教員には進捗だけをpushします。全員への通知は参加・開始・終了に限定。切断後は同じtokenで本人向け状態を復元します。

Google OAuthは通常版のJWT検証・cookie/token helperを再利用します。認証と許可教員はLite専用の `LiteTeachers` SQLite Durable Objectに保存します。通常版の教員一覧・セッションとは共有しません。D1、Supabase、既存実施データの移行、polling、複雑なoutbox、汎用バックエンド互換、Mate本体はありません。生徒の解答経路は認証用Objectを呼びません。

## Google認証
- Googleの既存クライアント（Cloudflare Independent）に `https://ionicformulacompetition-lite.koichem.workers.dev/api/auth/google/callback` を承認済みリダイレクトURIとして追加します。scopeは `openid email` だけです。
- `GOOGLE_CLIENT_SECRET` はLite WorkerのSecretとして設定し、repoには保存しません。`APP_ORIGIN`、client ID、masterはLite専用wrangler設定で管理します。
- OAuth stateはブラウザcookieに結び付けて一度だけ消費し、有効期限10分。PKCEとnonce、Google署名・issuer・audience・email_verifiedを検証します。ログインcookieはSecure/HttpOnly/SameSite=Lax、8時間で失効。Room作成と教員一覧変更には同一originとCSRF tokenを要求します。
- 教員登録を解除すると、その教員のログインsessionを削除し、新規Room作成を停止します。既存Roomの管理は従来の管理tokenで継続し、進行中の授業を切断しません。管理tokenは引き続きブラウザにのみ保存し、参加QRには含めません。
- 認証情報は期限切れalarmで削除し、許可教員の一覧は保持します。

実Google認証をローカルで使う場合は `pnpm --dir lite dev`（localhost origin override済み）を使用し、`lite/.dev.vars` のSecretとGoogle側localhost callback登録が別途必要です。通常のUI検証は `dev:fixture` を使い、Playwright contextにlocal-onlyのdummy session cookieを注入します。`tests/auth-flow.js` は未認証拒否、マスター/許可教員の区別、登録・解除・ログアウト、320〜1280pxを検証します。fixtureは公開Workerのentryではありません。

負荷検証は `LITE_TEACHER_COOKIE` にログイン済みLite教員cookieを渡し、session APIからCSRFを取得して作成します。cookieはログや計測JSONに出力しません。本番の教員cookieをコミットしないでください。

参照：[Cloudflare SQLite Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)（2026-10-09確認）。
