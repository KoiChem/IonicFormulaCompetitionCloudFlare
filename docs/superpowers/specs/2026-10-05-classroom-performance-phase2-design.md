# クラスマッチ性能改善 第2段階 — Sol実装仕様

作成日: 2026-10-05。対象: KoiChem/IonicFormulaCompetition / IonicFormulaCompetitionGitHub。
調査基準: main `edd1473`、直前の公開実装 `15dd01b`。本書は調査・実装仕様であり、以下の追加改修は未実装。

## 1. 評価と測定の意味

前回の修正は「処理済みなのにタイムアウトと表示する」「開始を再送して重複実行する」という問題への対策として有効。一方、授業で一斉操作する体感速度としてはまだ改善が必要。20〜42人を扱う構成としてGitHub Pages/Supabase自体の限界だと判断する根拠はない。Pagesは静的ファイル配信であり、開始APIはSupabase Edge/DB/Auth側を通る。

[前回検証記録](../../HOST_START_TIMEOUT_VERIFICATION.md)の再評価:

| 人数 | 開始POST p95 / 最大 | manifest取得開始→全員ready p95 / 最大 |
| --- | --- | --- |
| 20 | 4.161秒 / 4.188秒 | 7.308秒 / 7.341秒 |
| 42 | 7.824秒 / 7.832秒 | 15.240秒 / 15.243秒 |

これはlocalhost PostgreSQL17、command pool max1、別inspect pool max1、Auth fixtureに200ms、アプリケーションSQLごとに10msを加えた試験。全員のstate要求の後ろにstartを投入。各人数30回、15問/immediate。通知flush、実Auth、Edge/Supavisor、実機のIndexedDB・学校回線は含まない。BEGIN/COMMIT/SET/ロック取得そのものには10msを加えていない。厳しい同時投入だが、本番の全要素を再現した上限値でも平均的ベンチマークでもない。

開始/lock時間切れは60回中0。ただし大人数の本番安定性を証明するものではない。readyは別区間で、start待ちを含まない。両p95を足して「開始から全員表示までのp95」としない。従来記録の約12.3/23.8秒はreceipt確認・再送確認も含む保守的合算であり、通常UXの実測値ではない。

保存ログ `/private/tmp/ionic-timeout-load.log` の代表例:

| 試行例 | total | poolWait | roomLockWait | dbWork | auth | queryCount |
| --- | --- | --- | --- | --- | --- | --- |
| 20人の開始 | 4188ms | 3617ms | 1ms | 366ms | 203ms | 28 |
| 42人の開始 | 7831ms | 7265ms | 0ms | 362ms | 203ms | 28 |

poolWaitは接続取得/BEGIN等の時間を含み、純粋なキュー時間のみではない。それでも、この試験の86〜93%がpoolWaitにあり、開始処理自体より先行state要求の直列処理が支配的と判断する。割合は上記例であって全試行の平均ではない。

## 2. 現状の根拠と採用方針

- `src/platform/postgres-runtime.ts`: max1、idle_timeout1秒。通常roomスコープはGETでもadvisory lockを取る。
- `src/platform/supabase-gateway.ts`: start-status以外のstate/manifest/realtime等もcommand poolへ進み、fingerprint・membership・event確認を行う。quotaとstart-statusは別inspect poolを共有。
- `src/platform/http.ts`: stateは全体の期限切れ清掃とtryFinalizeを行うため、そのままREAD ONLY化できない。
- `src/platform/supabase-identity.ts`: 毎要求Auth `/user`へ通信。HTTP非成功を一律nullにするため、Authの5xxもgatewayで401になる。fetch timeoutは既に503であり、そこまで401だと誤認しない。
- `src/web/api.ts`: 401でrefreshSessionする。上記誤分類が障害時の不要な更新要求につながり得る。
- `src/platform/realtime-outbox.ts`: project全体の重み付き90/秒予算、1秒間隔、event/lease条件付きackは既存。予算/間隔でskipした行の将来の再実行予約はなく、次のflush呼出に依存する。送信失敗も次の呼出が必要。
- `src/features/play/useRoomSync.ts`、`src/web/realtime-policy.ts`: hostの2秒ポーリングと通知由来の2秒取得が別系統。参加者は購読成功中30秒で、通知保留/欠落時の開始追従を別に検証する必要がある。

比較した案:

| 案 | 効果と注意 | 判断 |
| --- | --- | --- |
| SQL往復削減だけ | 低リスクだが人数分の直列待ちが残る | 読み取り分離と併用 |
| 読み取り分離＋短い更新処理＋通知再送 | 待ち列の原因を減らし、既存プロトコルを維持できる | 採用 |
| pool大幅増加・上位プラン・別基盤移行 | 同室mutexは残り、接続上限や費用の問題が増える | 現時点では採用しない |

## 3. 実装順序と必須契約

順序: 計測追加 → 認証障害の分類 → snapshot経路/SQL削減 → outbox再送 → 同期スケジューラ統合 → 接続設定の比較。JWKS最適化は別の条件付き工程。

維持する契約:

- start receipt/requestId/expectedRevision、再送上限、取消後の再開始、応答不明の回復、参加資格の保存とQR復旧。
- v1/v2、class/mate、5/15問、immediate/deferred、採点・準備期限・保存期間・42人上限。
- Google教員本人確認、allowlist、owner、participant token、membership再関連付け、削除/失効/epochの規則。
- 通知は既存5個の更新メタデータのみ。送信中にDB接続/transaction/lockを保持しない。古いackは差替え行を消さない。
- 古いPagesと新Edgeが併存しても動作する。API本文の既存フィールドを一括削除しない。

### A. 計測を先に追加

対象: gateway、postgres-runtime、useRoomSync、開始controller、PostgreSQL負荷スクリプト。

1. `join/state/manifest/ready/start/start-status`成功も標本抽出で記録。検証では全記録、本番は設定可能な低率。失敗は全記録。
2. `total/auth/quota/poolWait/roomLockWait/dbWork/queryCount/retryCount/route/role/phase/status`を分離。BEGIN待ちと接続確立が分離不能ならpoolWait定義を明記。commitやシリアライズなど未分類時間を隠さない。
3. outboxのpending age、defer理由、再送数、claim/send/ack、接続再作成数を記録。JWT/token/email/nickname/解答/問題本文は記録しない。
4. ブラウザは開始クリック→受付確認→manifest取得→IndexedDB保存→ready→第1問表示を計測。既定のカウントダウンは別表示。異なる端末の時計の単純差分は禁止し、同期誤差も記録する。
5. raw JSONと実行条件・commit・p50/p95/max・失敗数をリポジトリ内の検証報告へ残す。環境変数未設定なのに遅延200msと出すようなmetadata誤表示を防ぐ。

### B. 読み取りと更新の分離（最優先）

新しいルート分類を明示する。HTTP GETという理由だけで分類しない。

| 操作 | 通常経路 | 更新が必要な場合 |
| --- | --- | --- |
| state / realtime | 認可済みsnapshot | phase境界、初回binding、正当な再関連付けだけ短いroom transaction |
| manifest | 認可済みsnapshot | 必要なmembership整合処理だけ短いtransaction |
| start-status | 既存の優先snapshot | 更新しない |
| start/join/ready/operations/cancel等 | room command | receipt/世代/認可をtransaction内で再確認 |
| results等 | 今回は従来経路を維持 | 別途計測で対象化 |

実装手順:

1. 共通のreadonly認可コンテキストを作る。participantはroom+token hash+ACTIVE/REMOVED+uid binding、teacherは設定/allowlist/active binding+ownerを読む。mate host判定も同じsnapshot内。権限はクライアント指定roleを信頼しない。
2. binding不存在/旧uidの場合、現在の正当なtokenによる回復を403で壊さない。snapshotを閉じ、既存と同じ再関連付け/監査規則をroom transactionで再検査・実行し、新しいsnapshotで取り直す。token不正やREMOVEDをfallbackで復活させない。教員binding初期化/復帰も同様に既存契約を維持する。
3. 通常snapshotはrepeatable read/read only。teacherProviderの書込み、associateParticipantの無条件呼出、fingerprint比較、queueRoomEvents、全体cleanup、outbox空確認を行わない。応答は同じDB snapshotに属するroom/phase/own/topicsから組む。
4. phaseが時刻境界に達した場合だけsnapshotを閉じ、短いroom transactionで現在時刻・generation/revisionを再確認して遷移/finalizeし、必要なoutboxを同一transactionで作る。再snapshotは原則1回、競合継続時は明示的な再試行可能応答とし無限ループにしない。
5. ホストが閉じていても参加者のstate/results/operationsで期限到達を進められる現行性質を残す。初期対応ではGETからの必要時遷移を残し、独立タイマーだけに頼らない。v1/v2の全境界を列挙して回帰検証する。
6. 期限切れ閲覧は即410。全室の物理清掃は共有された短い保守処理へ移す。保持期間を延長する仕様変更はしない。現状の確率的auxiliary清掃だけに全室清掃を預けず、定期実行または期限付きDB leaseの保守トリガー、最終成功時刻、再試行を用意し、無アクセス期間後も回収できることを確認する。
7. SQLをJOIN/集計でまとめる。まず正常な参加者state/manifestを各5アプリSQL以内（quotaとtransaction制御を除く）の目標とする。無理な巨大SQL化や安全確認省略より、同条件の時間とqueryCount低下を優先する。実行計画で必要性を示した索引のみ追加する。
8. readyも毎回の全名簿比較・同じroomの再取得を削減する。最後のreadyによるCOUNTDOWN確定はroom lock/世代条件下で一度のみ。部分成功・古い世代・取消との競合を必ず検証。

接続方針: commandと通常snapshotを独立させ、start-statusがstateの大行列の後ろに入らない優先経路を残す。試験初期案はcommand1、normal snapshot1、critical/短いquota1の最大3接続/isolate。現在の2から増えるので、本番のpooler client/server枠、共有プロジェクトの他アプリ、isolate数を計測してから有効化する。quotaの行列がcriticalを圧迫するなら同プール内で待機中statusを先に処理するbounded schedulerを検証する。単にinspectへ全GETを移す実装は禁止。

### C. 認証障害の分類（必須）と高速化（条件付き）

必須:

- verifyUserは成功/無効/一時利用不可を区別する。既知の無効・期限切れ・欠落は401。Auth 429/5xx/通信失敗/timeoutは再試行可能503と安全なRetry-After。予期しない4xx/不正JSONもログを区別し、無条件401にしない。
- 401時のrefreshを同一タブでsingle-flight化。503ではrefreshやローカル資格破棄をしない。POSTをapiFetchで自動再送しない（start固有の同一requestId再送契約を維持）。
- 共有教員authorityも同じverifySupabaseUserを使うため、新しい戻り値/例外型を全call siteへ適用し、障害を不許可と誤認しないことを回帰検証。

条件付き候補:

Supabase getClaims/JWKSは非対称鍵ならAuthネットワーク往復を減らせる。HS256ではAuthへの照会が必要であり、メソッド名を置き換えるだけでは高速化しない。現在の鍵種別は本調査で確認していない。

初回リリースではremote verificationを維持する。別工程で鍵方式と失効契約を調べ、必要な保証を満たせる場合だけ参加者の高頻度readonly要求で試験する。issuer/audience/exp/nbf/alg/kid/署名を検証し、uidだけでなくDBのparticipant資格を毎回照合。未検証decode/getSessionを認可に使わない。教員Google identity/allowlist/owner確認をJWTの自己申告metadataへ置換しない。

JWKS検証は現在のユーザー状態照会と同義ではなく、利用停止/ユーザー削除/セッション失効の反映差がある。差を埋められない場合は採用せず、性能目標を理由に弱めない。鍵更新・未知kid・期限切れ・署名不正・JWKS障害・キャッシュ破棄を検証する。鍵移行やJWT有効期間変更をこの性能改修で自動実行しない。

### D. outboxの再送保証と同期要求の削減

1. flush結果を`pending/nextEligibleAt/deferReason`まで返せる形にする。間隔/予算によるskip、send失敗、lease残存を成功扱いで放置しない。
2. commit後のwake-upに加え、nextEligibleAtへの上限付き再試行を予約。待つ間はtransactionも接続も持たない。isolate内single-flight/dirty trailing drainを維持する。
3. Edge終了後もDB outboxは残す。プロジェクトで利用可能な定期drainを回復経路にし、複数workerは既存のevent/lease付きclaimで競合を解決する。定期実行の粒度が1分なら「数秒以内の通知保証」とは表現しない。
4. 普通のGETを減らす前に、GETが一切来ない状態でも保留通知を再試行するテストを通す。正常時control通知のenqueue→送信p95は2秒以内を目標。障害時はポーリングで回復し、通知だけに正しさを依存させない。
5. project全体90/秒の予算を維持し、複数ルームの公平性/古いpendingの飢餓を検証。42人+教員を1人2接続で見積もるcontrolは87、hostは3なので既に余裕が小さい。チャネル数とWebSocket接続数は別物。他アプリや上限超過ログも観測する。予算を無断で増やさない。
6. useRoomSyncの通知・poll・再接続・visibilityを1つのschedulerへ統合。single-flight+後続dirty取得、jitter、Retry-After、backoffを維持。host進捗は通常2秒以内の更新要求にまとめ、control/開始確定/取消は早める。時刻境界タイマーやCOUNTDOWN時計同期は別に維持する。
7. ポーリング延長だけを先行しない。通知欠落時、接続表示がSUBSCRIBEDのままでもWAITING参加者は最大約5秒、PREPARINGは約3秒で状態確認を試みる方針を検証（正常なAPI応答時間を別に加算）。42台での増加負荷も必ず測る。RUNNINGの参加者は既知deadlineと既存30秒確認を基本にする。host定期確認の延長は後段の任意最適化で、通知欠落時の名簿/進捗鮮度を悪化させるなら見送る。
8. endpoint応答をroom単位だけで共有cacheしない。個人解答/資格/教員情報の混線を防ぐ。ETag/304だけでは認可やDB往復は消えずserverTimingも扱う必要があるため、今回は必須化しない。

### E. 接続寿命・地域・初期表示

- idle_timeout1秒は間隔の空くpollで再接続を増やす可能性がある。1/10/20秒をwarm/cold、単一/複数isolateでA/B測定。再接続回数とpooler枠の両方を確認して採用値を決める。prepare:falseとTLSを維持する。
- DBと同地域のEdge実行を基本にし、実際の応答ヘッダ/ログで確認する。現行はSeoul指定を持つため「Tokyoへ変えれば速い」とはしない。地域固定は障害時の自動迂回を妨げるため、緊急切替手順を残す。
- 既存bundleサイズ警告は初回読み込みの別課題。QRカメラや教員管理の遅延読込は通信waterfallで効果が出た場合の後続項目とし、今回の開始API遅延対策の成果と混同しない。

## 4. 合格条件と検証

性能値は本仕様の提案目標であって、ベンダーの保証や既に達成した値ではない。

| 検証 | 合格条件 |
| --- | --- |
| 前回と同一の実PG試験、各30回 | start p95:20人2秒以下/42人3秒以下、manifest→全員ready p95:20人5秒以下/42人8秒以下を目標。時間切れ/二重生成0。未達は原因を示して継続改善し、達成したと記載しない |
| 同条件比較 | 元条件のmax1 command、Auth200ms、SQL10msを維持。追加read pool数を必ず記録。新旧双方に同じ総接続枠を与える対照試験も行い、改善が増枠だけかを区別 |
| 完全な開始シーケンス | control broadcast→state→manifest→IndexedDB→ready→COUNTDOWN→第1問。実測の開始クリックから全員表示までを別に報告。既定カウントダウンを除いた時間も併記 |
| 本番相当の通知 | flush有効、HTTP送信遅延/失敗/予算skip/通知欠落/重複/逆順/worker停止。commit後に追加APIが来ないケースも確認 |
| DB並行性 | 1/複数runtime、20/42人、同時2クラス、host+participant再接続burst。state中もstart/statusが進む。ready/取消/削除/期限境界の競合で整合性を維持 |
| 安全性 | owner以外start-status不可、token不正/削除者不可、許可された再関連付け可能、teacher allowlist変更反映、read-only経路にwriteなし、他人のデータ漏れなし |
| 認証障害 | Auth500/429/timeoutは401/refresh連打にならない。真の401の同時発生はタブ内1refresh。POSTの勝手な再送0 |
| リソース | pooler接続枠・projectの他アプリに余裕があり、outbox pendingが無期限増加しない。DB送信中の外部HTTPでopen transaction0 |

試験データは使い捨てDBまたは検証環境を使う。本番へ20/42人の一斉負荷を無断投入しない。公開後の少人数確認と、実際の授業規模・学校回線による確認は別の証拠として報告する。

必要なチェック: 関連RED回帰テスト→実装→全既存テスト（RUN_LOAD対象も含む）、typecheck、build、Edge bundle、git diff --check、実PostgreSQL試験、PlaywrightでQR参加/開始/取消/再開始/解答/結果、console/network、モバイル幅。前回の511件成功は新変更の検証の代替にしない。

## 5. Solへの実装・公開手順

1. 現在の差分と指示を確認し、既存変更を保持する。この仕様に沿う計測と回帰テストから着手する。
2. 上記A→Eを小さな変更単位で実装。BとDは相互依存するため、GET由来flushの除去だけを先に公開しない。
3. readonly経路はサーバー側feature flagを持ち、オフで既存経路に戻せるようにする。通常snapshotを純粋化する途中状態を本番へ公開しない。
4. migrationが必要なら追加的・後方互換とし、既存room/receipt/participant/outboxを消さない。清掃移管の有効化時も保持期間を維持。
5. 性能・競合・権限検証をレビューし、未達指標は記録。JWKS案は条件未成立なら未導入と明記して必須改善を進める。
6. 実装・公開が依頼された段階でEdge先行→旧Pages互換確認→Pages→公開確認。GitHub MCPのCI/deploy情報、公開asset、Playwrightの証拠を分けて残す。
7. rollbackはflag無効化または直前の対応Edge/UIへ戻す。基準はこの仕様時点の実装15dd01b/version19から、その時点の最新公開へ更新して記録する。実行中データの削除で戻さない。

## 6. 参照した一次資料

2026-10-05閲覧。文書上の制限と実プロジェクトの契約・設定は別に確認する。

- [GitHub Pagesの役割](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages): 静的配信とAPI性能を分ける根拠。
- [Postgres.js公式GitHub](https://github.com/porsager/postgres#the-connection-pool): max、transaction中の接続占有、idle_timeout秒単位。現行依存版との差は実装時確認。
- [Supabase EdgeとPostgres](https://supabase.com/docs/guides/functions/connect-to-postgres): 接続方式/transaction pooler利用時のprepare設定。
- [Supabase地域指定](https://supabase.com/docs/guides/functions/regional-invocation): DB往復の多い処理はDBと同地域を比較、固定時の迂回制限。
- [Supabase getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims): 非対称鍵のJWKS検証と、それ以外でのAuth照会。
- [Supabase JWT検証](https://supabase.com/docs/guides/auth/jwts): JWKSの鍵公開/キャッシュ/ローテーション、HS256の扱い。
- [Supabaseセッション](https://supabase.com/docs/guides/auth/sessions): JWTとセッション有効性の区別を実装時確認。
- [Supabase Realtime制限](https://supabase.com/docs/guides/realtime/limits): Freeの公表値200接続・100messages/秒、超過時切断。42人だから無条件安全とは判断しない。
