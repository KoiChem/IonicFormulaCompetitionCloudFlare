# Supabase向け性能改善 第3段階 — Sol実装仕様

作成日: 2026-10-06。対象: `KoiChem/IonicFormulaCompetition` / checkout `IonicFormulaCompetitionGitHub`。
基準commit: `6b30e43b0951a9f8187d39279e1141a4c384e72f`（第2段階実装 `dd25bc8`）。
状態: **仕様のみ。実装・migration適用・公開は未実施。**

## 1. 目的と承認範囲

20〜42人が同時参加し、ホストが開始した際の待ち時間を短縮する。ユーザー指定の順序で進める。

1. 事前通信（CORS preflight）のキャッシュと開始要求の優先化。
2. 参加（join）・準備完了（ready）のPostgreSQL DB関数への集約。

今回の範囲外: JWT/JWKS/getClaimsへの認証変更、Auth結果のTTLキャッシュ、DB地域移転、接続数・idle timeoutの変更、プラン変更、採点・問題生成のSQL移植、通知基盤の全面置換、カウントダウン短縮。
SupabaseへのHTTP認証照会、Google本人確認、allowlist、owner確認、参加者token、保持期間、既存APIの互換性を維持する。

本書はSolへの実装指示として使う。実装開始・公開はユーザーの次の承認による。現在の未追跡 `docs/SITES_GITHUB_RESPONSE_COMPARISON.md` を保持する。

## 2. 調査根拠と既存構成

- `postgres-runtime.ts`: command/read/criticalは各max1、計最大3接続/isolate。Supavisor transaction mode、TLS、prepare:false、idle_timeout1秒。
- `postgres-database.ts`: D1互換batchは各statementを順番にawaitして送る。DB内の一括呼び出しではない。
- `supabase-gateway.ts`: 全APIがAuth照会後、別transactionでquotaを更新。続いてroom commandまたはread-only snapshotを実行する。
- `priority-transactions.ts`: start-statusのquotaとsnapshotを優先するが、start POSTのquotaは通常列。優先8件の後は通常1件、待機上限256。
- join/readyのcommandでは、業務処理に加えてfingerprint、membership、topics、outboxのSQL往復がある。
- 2026-10-06の公開OPTIONS確認: 204、許可Origin限定、`Access-Control-Max-Age`なし。Edge応答地域とCLIのDB地域は共に`ap-northeast-2`。地域は変更しない。

前回の人工遅延付き実PostgreSQL試験ログを再集計した値:

| 指標 | 20人 | 42人 |
| --- | --- | --- |
| 個々のjoin応答 p95 / max | 4.707 / 4.962秒 | 9.533 / 10.080秒 |
| start POST p95 / max（初回のみ） | 0.842 / 0.843秒 | 1.149 / 1.153秒 |
| manifest取得開始→全員ready p95 / max | 3.718 / 3.735秒 | 7.377 / 7.411秒 |

joinは各600/1260要求の集計であり、各回の全員参加完了時間のp95ではない。42人側は9要求が10秒以上だったが、この試験はクライアントの10秒打切りを適用していないため「9件のタイムアウト」と報告しない。
joinは19アプリSQL/要求、通常readyは13、最後のreadyは最大19。quotaを含み、BEGIN/SET LOCAL/lock/COMMITを除く。42人joinのpoolWait p95は9.089秒。poolWaitはキュー待ち・接続確立・BEGIN待ち等を含む集計で、純粋なDBロック待ちではない。

根拠: `/private/tmp/ionic-phase2-final-load.log`、`/private/tmp/ionic-phase2-final-load-result.json`、[第2段階検証](../../CLASSROOM_PERFORMANCE_PHASE2_VERIFICATION.md)。これらは公開Supabase・学校回線・実機42台の測定ではない。

## 3. 第1段階: 事前通信キャッシュ

対象: `src/platform/supabase-gateway.ts` のCORS処理。

- 許可Originに対する正常なOPTIONS応答に `Access-Control-Max-Age: 600` を付ける。ステータス204、空bodyを維持。
- 現在の許可Origin、methods、headers（x-region等）、expose headersを維持。Originのワイルドカード化、credentials許可の追加はしない。
- `Vary: Origin`を維持し、既存Vary値があれば上書きで消さず併合する。
- 不許可/欠落Originには許可CORSヘッダー・max-ageを付与しない。実要求にも毎回Origin/Auth/認可を適用する。preflightキャッシュは操作権限のキャッシュではない。
- state/manifest等の `cache:no-store` は維持。API本文、問題、認証結果をHTTPキャッシュしない。
- max-ageはブラウザーの上限・キャッシュキーに従う。同一URL・method・header集合の再利用に効くが、新室URLや初回start/readyのOPTIONSをゼロにする保証はない。
- rollbackはmax-ageを0へ戻す。ただし既存ブラウザー内の許可情報は最大600秒残り得る。実要求の検査は継続するのでOrigin失効を実要求で拒否できることを確認する。

検証: 許可/拒否Origin、204、全許可ヘッダー、Vary併合。Playwright+ネットワーク観測で、同一URLへの反復通信を5秒超〜600秒未満の間隔で行い、初回OPTIONSと後続キャッシュ利用を確認する。page.requestだけではブラウザーのpreflightキャッシュを検証できない。ブラウザーのキャッシュ無効化設定を使わない。

## 4. 第1段階: startのquotaを優先

対象: gateway、`priority-transactions.ts`、該当試験。

- 優先quota対象を `startStatus` と `startRoom` にする。ルート定義に基づく分類とし、クライアント指定priorityは受け付けない。
- キュー選択用scopeは `quota:critical:<verified uid>`。quotaの保存bucketは従来の `<uid>:<minute>` のまま。優先用の別quota枠を作らない。
- 現行の180回/分、429/Retry-After、上限256、優先8件後に通常1件、実行中処理の非中断を維持する。
- Auth確認は優先キューより前。startの教員owner/mate host確認、requestId/bodyHash/expectedRevision、room lockは従来通り。
- **優先化するのは開始前のquota待ち。** room commandをread-only/critical接続へ移さない。実行中joinを追い越して中断せず、人数・room revisionの確定を壊さない。
- start/status以外のルートは通常列。startを連打しても通常列が飢餓状態にならないことを検証する。

検証: 通常quota42件待機中にstartを投入し、先行実行中1件と公平性の通常枠を考慮して次の3開始以内にstart quotaが選ばれること。継続する優先要求下でも通常要求が有限時間で進むこと。start/status/通常要求が同一quotaを消費し、owner不正、同一ID別body、不正revisionを従来通り拒否すること。

## 5. 第2段階: PostgreSQL専用のcommand経路

### 5.1 配置と呼び出し

新規候補: `src/platform/postgres-room-commands.ts`、追加migration `supabase/migrations/202610060001_native_room_commands.sql`。
関数名: 非公開schema `competition_private` に `join_room_v1` と `mark_ready_v1`。署名末尾のv1はDB関数契約の版であり、ゲームv1とは無関係。

- Edge→既存postgres.js transaction→DB関数という構成。ブラウザーからの直接RPC公開や、EdgeからPostgRESTへの新たなHTTP中継は追加しない。
- join/readyだけを専用経路に分岐。start、manifest、state、operations、結果、保守は現行経路を維持。
- 最初の対象はゲームv2のjoin/ready。v1 joinは従来経路へ戻す。対象判定はDB関数のroom読取りで行い、未対応の場合は一切書かず内部結果`unsupported`を返す。room不在/期限切れ等の業務エラーをunsupported扱いにしない。
- 同じroom command transaction内で、既存と同じ `room:<publicId>` のadvisory lock、read committed、timeoutを利用する。新旧コード・取消・remove・startと共通の排他順序を保つ。
- 関数も同じキーのtransaction lockを取得する契約にして、呼出元の違いによる排他漏れを防ぐ。同一transactionでの再取得は許容する。新たな別lockキーは作らない。
- 通常の匿名参加者では、quota1呼出＋command関数1呼出＝**アプリDB往復2回**を目標とする。DB関数内部のSQL本数は別集計。transaction制御はこの2回に含めず明示する。
- Googleログイン済み利用者が参加者として操作する場合、既存teacherProviderによる設定整合確認・bindingの副作用を無断で廃止しない。必要な既存provider処理を維持し、この経路の追加SQLは別計上する。
- native処理の後に従来のfingerprint/associateParticipant/queueRoomEventsを重ねて実行しない。それらの必要な処理は関数内で完了する。成功commit後の既存flush起動は1回だけ行う。
- 接続枠はcommand/read/critical各1のまま。quotaは別transactionのままとし、command失敗のrollbackでquota消費を取り消さない。

### 5.2 入出力・共通検証

Edge側で既存のbodyサイズ、Content-Type、CSRF、未知キー、requestId、ニックネーム正規化、token形式、SHA-256、bodyHashの処理を共有する。似た別実装を作らない。raw JWT/tokenはDB関数に渡さない。

join入力: public room ID、検証済みSupabase uid、tokenHash、生成済みparticipantId、requestId、既存方式のbodyHash、nickname、nicknameKey。
ready入力: public room ID、検証済みuid、tokenHash、任意のclaimed participant ID、manifestId、evaluatorVersion、preparationGeneration。
uid/生成ID/hashはEdgeの信頼済み値。ブラウザーのbodyからuid/role/内部room IDを採用しない。

関数はDB内でroomとtokenの対応を再確認し、期限・世代・資格を判定する。時刻はロック取得後の `clock_timestamp()` をミリ秒へ変換し、readyのCOUNTDOWN決定直前に再取得する。transaction開始固定時刻の `now()` で長い待機時間を隠さない。
SQL側の人数・保持時間・5秒カウントダウン等は現行設定に一致させ、TS定数との一致テストを置く。外部リクエストから上限値を指定させない。

戻り値は内部envelope（成功body、既存status/error code、またはunsupported）。ブラウザーへのJSON形状・日本語エラー・HTTPステータス・request-idは現行APIに合わせる。DB内部ID、SQL、token hash、uidを新たにレスポンスへ出さない。

### 5.3 権限・失敗時の原子性

- 専用schemaをData APIの公開schemaに追加しない。PUBLIC/anon/authenticatedからschema使用権と新規関数EXECUTEを明示的にREVOKEする。新規関数がPUBLIC EXECUTEを持つPostgresの初期値に依存しない。
- SECURITY INVOKER、固定search_path、テーブル・補助関数のschema修飾を基本とする。現在のEdge接続roleだけから実行可能にする。新規の広いservice_role/ブラウザー権限を付与しない。
- 関数の業務エラーreturnで部分更新がcommitされないこと。書込み前に検証し、書込み後の失敗を捕捉してenvelopeへ変換する場合はPL/pgSQL例外blockのsubtransactionで当該command全体をrollbackする。
- 未知のSQLエラーは握り潰さず外側transactionをrollbackし、現行503/Retry-Afterへ。`40001`/`40P01`の現行再試行方針を維持する。失敗を成功receiptとして記録しない。
- uniqueness違反、別requestIdで同じtoken、再送中の削除などは旧経路のstatus/codeと差分比較する。新たな「同じtokenなら無条件成功」を導入しない。
- native障害後、同じPOSTを自動で旧経路へ再送しない。fallbackは書込み前の機能flag無効/unsupportedだけ。結果不明時は既存の同一requestId回復を用いる。

## 6. join DB関数の契約

1. public IDからroomを解決し、期限・ゲーム版を検証。
2. `join:<tokenHash>`＋requestIdで有効receiptを確認。同一ID別bodyは409。既存receiptのparticipantがREMOVED/不整合なら復活させない。
3. 新規参加時はWAITINGかつ準備未開始、定員（class42/mate4）、nickname重複、token制約を従来通り確認。同じroomの直列処理を維持する。
4. room revision更新、participant挿入、joinedOrder確定、receipt記録を1transactionで行う。削除済み行も含む従来の順序採番を維持し、空き番号へ詰め直さない。
5. topicsの初期行、membershipの関連付けを完了。正当なtokenと既存membershipのuidが異なる場合は現行の再関連付け・監査を維持し、既存triggerによるepoch更新/古いoutbox除去を妨げない。
6. 必要な通知を同じtransaction内でoutboxへ書く。通常joinの名簿変更はhost向けのみ。epoch変更等で必要なcontrol通知は残す。
7. receipt再送はparticipant/revisionを増やさない。同じuidで変更のない再送は不要なoutboxを増やさない。uid回復によるepoch変更があればその通知は必要。
8. 返却は既存の201 `{ participant: { id, nickname, joinedOrder, revision } }`。既存receiptの再送時の返却契約も保持。

参加者、room revision、receipt、membership、epoch、監査、outboxの各書込み後で障害を注入し、すべてrollbackすることを検証する。

## 7. ready DB関数の契約

1. room期限・ゲームv2・tokenHash・任意claimed participant IDを確認。REMOVED、他人ID、他室tokenを拒否。
2. manifestId/evaluatorVersion/preparationGeneration一致、PREPARING/COUNTDOWN/RUNNINGの状態を確認。
3. ACTIVE参加者のready_generationを更新し、同じtransactionでACTIVE人数とready人数を計算。冪等再送で人数を二重加算しない。単なる累積counterへの置換はしない。
4. 全員readyかつPREPARING、決定時刻がprepared_at+30000ms未満のときだけCOUNTDOWNへ遷移。room、manifest、creation/command receiptsの保持期限を現行通り更新。
5. 開始時刻は決定直前のDB時刻＋5000ms。既存COUNTDOWN/RUNNINGへのready再送は開始時刻・期限を延ばさない。古い世代のreadyは取消・再開始後の世代を進めない。
6. 準備30秒超過は現行の `preparationTimedOut` 応答を維持し、勝手に開始しない。readyが成功扱いの場合のmembership回復とepoch処理も現行通り。
7. readyCount、participantCount、state、startAtMs、deadlineAtMs、preparationTimedOutを返す。COUNTDOWN確定前後の値を別snapshotから混ぜない。
8. host向けready更新と、COUNTDOWNへのcontrol通知を同じtransactionでoutboxへ。冪等再送時の余分な通知は削減可能だが、未送信outboxは残す。

クライアントの「manifest取得→IndexedDB保存成功→ready」は変更しない。manifest取得だけでready扱いにしたり、端末保存前に先行readyを送ったりしない。

## 8. 通知・新旧併存の契約

- 既存outbox schema、eventId、revision、epoch、lease CAS、毎分maintenanceを使用する。既存triggerは削除しない。
- payloadは現在の5項目（eventId/roomId/epoch/revision/roomRevision）のみ。nickname、問題、解答、JWT等を含めない。
- 新イベントのupsertはleaseを現行通り失効させ、古い送信ackが新イベントを削除できないようにする。queued_at更新も維持する。
- 通常join/readyの度に全員へ通知せず、hostとcontrolを区別する。既存の配信予算・coalescing・再試行を維持。
- DB関数内ではRealtime HTTPを呼ばない。外部送信中にtransaction/DB接続を保持しない。
- native経路と旧経路が同時に同じ室を操作する混在試験を行う。全workerを同時更新できる前提にしない。

## 9. 計測と合格基準

### 9.1 計測の定義

既存total/auth/quota/poolWait/roomLockWait/dbWork/retryに、legacy/native経路とアプリDB往復数を識別できる情報を加える。SQL内部statement数とネットワーク往復数を混同しない。BEGIN/SET/lock/COMMIT等の制御往復も別に記録する。
成功は低率sampling、失敗は全件。JWT/token、名前、email、解答、問題本文、秘密のSQL引数はログに出さない。

DB関数はクライアントから1往復で内部SQLを実行する。比較用10ms遅延は「各クライアント→DB呼出の追加往復遅延」と定義し、関数内SQL一つごとには加えない。旧試験の遅延がアプリSQLのみだったことも記載する。旧経路・nativeとも同じ定義で測り、別途制御往復にも遅延を加えた感度試験を実施する。DB関数内部の実行時間・計画は実PostgreSQLで確認し、PGlite/D1や固定mockだけで高速化を主張しない。

### 9.2 比較試験

同じマシン・PostgreSQL17・データ初期状態・3接続・Auth200ms・追加DB往復10msで、baseline→第1段階→第2段階を各人数30回比較する。15問/ion/normal/formula/immediate/3分を基本にする。

- 個々のjoinと「全員join完了」のp50/p95/maxをそれぞれ記録。
- 全員join後、host+各参加者stateを同時投入してstart。初回startとreceipt再送は別集計。
- manifest→端末保存を模した処理→ready→COUNTDOWNを計測。API試験の模擬保存と実ブラウザーIndexedDBを区別する。
- API待機打切り10秒のクライアント試験を追加し、失敗数と結果不明後の同一ID回復を記録。単なる試験コードのタイムアウト延長で合格にしない。
- 第1段階は公平性/OPTIONS削減を主に評価。ローカルAPI呼出だけでpreflightの速度改善を数値化しない。

第2段階の設計目標（未測定。達成見込みを成果として報告しない）:

| 指標 | 20人 p95 | 42人 p95 |
| --- | --- | --- |
| 全員join完了 | 2秒以下 | 3秒以下 |
| 初回start POST | 0.85秒以下 | 1.15秒以下 |
| manifest→全員ready | 2.5秒以下 | 4秒以下 |

公開前の性能ゲート: 全60回で10秒打切りゼロ、上記目標達成、二重参加/二重COUNTDOWNゼロ、同時採取baseline比でstart/status p95の10%超悪化なし。目標未達なら原因・測定条件を報告して仕様を再検討し、黙って基準を緩めない。pool増枠で数字を合わせない。

これとは別に、追加遅延なし・flush有効・複数runtime・20人室と42人室の同時運用で計測する。5/15問×immediate/deferred、class/mate、v1 fallback、Googleログイン済み参加者も回帰確認。公開20/42試験は実Auth・TLS・Supavisor・Realtimeで実施し、人工遅延モデルとは別表にする。実機/学校Wi-Fiは別途の確認範囲。

### 9.3 整合性・権限の必須試験

- 同時43人以上の参加でclass上限42、mate上限4。joinedOrder重複ゼロ、nickname NFKC衝突を旧経路通り拒否。
- 同一requestIdの並行再送、同一ID別body、別ID同一token、commit後応答切断、REMOVED後の再送。
- join対start/cancel/remove、ready対cancel/restart/remove、最後の複数ready、旧世代ready。古いmanifestやreceiptで新世代を上書きしない。
- 正当なtokenによるuid回復とepoch更新、監査、旧topic拒否。他人のparticipant ID指定、不正/欠落tokenは拒否。
- DB関数をanon/authenticated/PUBLIC相当から直接実行できないこと。検索パス乗っ取りを避けること。
- 各書込み地点の障害でroom/participant/receipt/membership/outboxの部分commitなし。quotaは消費済みのまま。
- 長いキュー待ち後でもカウントダウン5秒を確保。準備期限の前後、COUNTDOWN/RUNNING再送時刻不変。
- native/legacy混在、flag切替、outbox送信中のイベント差替え、通知失敗とworker終了後のmaintenance回収。
- PlaywrightでQRが指す参加URL→参加→開始→準備→第1問→提出→結果、取消→再開始、390×844、console/network失敗を確認。通常の5秒カウントダウンは測定で別表示。

## 10. 実装単位・公開順序・rollback

Solは次の順で小さく実装・検証する。

1. CORSヘッダーとstart quota分類、公平性の回帰テスト。既存コード以外の認証/プール設定を変更しない。
2. 共有入力検証とnative dispatcher、関数権限付き追加migration、join関数、旧経路との契約比較。
3. ready関数とoutboxの共通処理、時刻/競合/新旧混在試験。
4. 30回性能比較、flush有効試験、全テスト・typecheck/build/Edge bundle、diff check。native SQLが既存schema生成スクリプトで失われないことも確認。
5. 以下の順序で段階公開し、公開結果を検証文書へ残す。

公開手順:

- 第1段階を先行公開・観測。既存APIと同じ本文なので旧Pagesのまま確認可能。
- 追加schema/関数migrationを適用。データのリセット、既存列削除、receiptの削除はしない。
- `COMPETITION_NATIVE_JOIN=false`、`COMPETITION_NATIVE_READY=false` を既定とするEdgeを公開。DB migration未適用でもflag offなら旧経路で動く。
- 検証後joinだけON→公開参加試験→readyもON→公開開始試験。各段階で旧Pages互換、機能flag、計測経路を確認。
- rollbackは該当flagをOFF。既存データ・追加関数は保持して旧経路へ戻す。エラー時に自動でflagを書き換えたりPOSTを二重送信したりしない。
- 公開APIの形を変えないため、速度改善だけを理由にPages更新を必須にしない。UI計測等を追加した場合は必要なPages公開と配信asset確認を行う。

提出物: 実装差分、追加migration、回帰/権限/競合テスト、各段階のraw測定JSON、条件と失敗数を含む検証レポート、公開commit/Edge版/適用migration/flag/rollback手順。実装・公開状況と未測定範囲を明記する。

## 11. 参照

- [Supabase DB Functions](https://supabase.com/docs/guides/database/functions): DB関数、実行権限、search_path。
- [Supabase Postgres接続](https://supabase.com/docs/guides/database/connecting-to-postgres): transaction poolerの利用条件。
- [Supabase regional invocation](https://supabase.com/docs/guides/functions/regional-invocation): DBと同じ地域での処理、region固定の特性。本件は既に対応済み。
- [MDN Access-Control-Max-Age](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age): preflightキャッシュの範囲・ブラウザー上限。
- [前段階仕様](2026-10-05-classroom-performance-phase2-design.md)、[実装検証](../../CLASSROOM_PERFORMANCE_PHASE2_VERIFICATION.md)。
