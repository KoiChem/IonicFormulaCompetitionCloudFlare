# Cloudflare Independent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare版の競技・認証・通知を独立させ、Supabaseへの通常運用通信をゼロにして検証・公開する。

**Architecture:** Native WorkerはGoogle認証とtop-level APIを担当する。Room DOはroom commandを直列化し、D1を永続的な正として既存handlersを実行し、Hibernation WSとalarmで同期・期限を管理する。React画面は同一origin APIと独立session adapterへ接続する。

**Tech Stack:** TypeScript、React/Vite、pnpm、Wrangler 4.148.0、Vitest 3.2.4、matching Miniflare、D1、SQLite-backed Durable Objects、Web Crypto、Workers対応jose 6（導入時にnpmのstable版を確認しexact pin）。

**Spec:** `docs/superpowers/specs/2026-10-08-cloudflare-independent-design.md`（ユーザー承認済み）。

## Global Constraints

- Target KoiChem/IonicFormulaCompetitionCloudFlare only; branch codex/cloudflare-independent。mainへ未完了機能をpushしない。
- 旧GitHub Pages/Supabaseの設定・データ・他アプリ共有教員権限は変更しない。旧データ移送なし。
- Class50、Mate4、Googleは同じ初期masterアカウント、session8時間。新allowlistは独立管理。
- D1 source of truth、transactional=false。DOは明示queue、D1 CAS/receiptも残す。D1とDO跨ぎtransactionを仮定しない。
- 原教材/UI/採点/順位/QR/期限を維持。出題分immediate snapshot、v2 elapsed検証契約は変更しない。
- tokenをURL/logへ入れない。Secure/HttpOnly/SameSite=Lax/__Host- cookie、same-origin＋CSRF、teacher allowlist。
- WS通常接続中の短周期pollingなし。Google/物理端末/公開HTTP/WSの証拠をfixtureと区別。
- GitHub/Playwright MCP優先、CloudflareはWrangler。認証・権限追加のUI最終操作は必要な時点で具体的対象を提示。

## Review Focus

1. Google loginキャンセル/二重callback/別tabのstateがsessionを取り違えない（Task2）。
2. allowlist失効・参加者除外・session期限後の既存WSがprivate host通知を受けない（Task4）。
3. commit直後のDO停止、alarm遅延、未送信通知がroomを誤った状態に固定しない（Task4）。
4. 非表示/再表示・offline・複数tabでポーリング暴走/別owner再送を起こさない（Task5）。
5. migration途中・OAuth未設定・容量制限をhealth成功や独立版完成と誤認しない（Task7）。

## File/Interface Map

- `src/platform/api-routes.ts`: backend-neutral route registry。`resolveCompetitionRoute(path:string,method:string): RouteResolution`。RouteResolutionはtop/room handler名・publicId、または404/405。
- `worker/auth/types.ts`: `AuthEnvironment` (DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MASTER_TEACHER_EMAIL)、`AuthSessionView` ({identity:{id,email}|null,csrfToken:string|null,expiresAtMs:number|null})。
- `worker/auth/store.ts`: D1 transaction/session/subject binding。
- `worker/auth/google.ts`: `handleGoogleAuth(request:Request,env:AuthEnvironment):Promise<Response|null>`。
- `worker/auth/session.ts`: `readAuthSession(request:Request,env:AuthEnvironment):Promise<AuthSessionView>`、`createTeacherIdentityProvider(request,env):TeacherIdentityProvider`、`handleSessionRequest(request,env):Promise<Response|null>`。
- `worker/api.ts`: `createWorkerApi(env:Env): (request:Request)=>Promise<Response>`。Top routes実行・room DO転送、internal headerを必ずstrip。
- `worker/room.ts`: `export class RoomCoordinator extends DurableObject<Env>`。`fetch`、`webSocketMessage/Close/Error`、`alarm`。
- `worker/room-authority.ts`: `authorizeRoomConnection(db,request,publicId,now):Promise<RoomPrincipal>`。RoomPrincipalはteacher/host/participant、id/sessionHash又はparticipantId/tokenHash、expiry。秘密token自体をattachmentへ保存しない。
- `worker/room-events.ts`: public fingerprint/revision/通知snapshot、`reconcileRoomEvents(db,publicId,now):Promise<RoomNotification[]>`。RoomNotificationはkind/control又はhost、epoch/revision/eventId/roomIdと公開進捗のみ。
- `worker/maintenance.ts`: `cleanupIndependentStorage(env,now):Promise<CleanupSummary>`。Cron bounded cleanup。
- `src/web/auth.ts`: `getAuthSession():Promise<AuthSessionView>`、`beginGoogleLogin(returnPath:string):void`、`logout():Promise<void>`、`ownerIdentity(token?:string):Promise<string>`。
- `src/web/room-socket.ts`: `connectRoomSocket({roomId,token,onEvent,onStatus,onResync}):()=>void`。同一origin upgrade＋最初の認証message。
- `tests/cloudflare/helpers.ts`: local workerd/D1/DO fixture、Google signed token mockとtest-only identity wrapper。本番へのtest認証スイッチは禁止。

Interfaceの型は各責務moduleへ置き、後続Taskはここに定義した名前を使用する。room tokenはuseRoomRealtimeへ明示引数で渡す。teacher WSはHttpOnly sessionをhandshakeで使う。

### Task 1: Native route境界とtest harness

**Files:** Create `src/platform/api-routes.ts`, `tests/cloudflare/helpers.ts`, `tests/cloudflare/routes.test.ts`, `vitest.cloudflare.config.ts`; Modify `src/platform/supabase-gateway.ts`, `package.json`, `.github/workflows/verify.yml`。

**Consumes:** createApiHandlers/CompetitionApiHandlers、existing tests/d1 helpers。
**Produces:** resolveCompetitionRoute、isolated native Worker fixture。

- [ ] route testsを先に書く: 全既存route、GET/PATCH/POST契約、未知path404、wrong method405、encoded publicId、path suffix拒否。Supabase gatewayも同じregistryを使うこと。
- [ ] `pnpm exec vitest run tests/cloudflare/routes.test.ts` でmissing module/未実装によるREDを確認。
- [ ] route tablesを抽出しresolveCompetitionRouteを実装。gatewayの認証/PG behaviorは変えない。
- [ ] harnessはesbuild bundle＋MiniflareでDB/ROOMS/ASSETSを渡し、各test独立DBへmigrationを順番に適用。package script `test:cloudflare` を追加し一般suiteと二重収集しない。
- [ ] route test＋existing gateway API testsを実行してPASS、typecheck。変更をcommit。

### Task 2: Google OIDCとD1 session/教員権限

**Files:** Create `worker/auth/{types,store,google,session}.ts`, `migrations/d1/0002_independent_auth.sql`, `tests/cloudflare/auth.test.ts`; Modify `package.json`, lockfile, `worker-configuration.d.ts`, `tsconfig.worker.json`。

**Consumes:** Task1 fixture、TeacherIdentityProvider、hashParticipantToken相当のWeb Crypto hash。
**Produces:** AuthSessionView、handleGoogleAuth/readAuthSession/createTeacherIdentityProvider/handleSessionRequest。

- [ ] signed local RSA/JWKS fixtureのtestsを追加: wrong issuer/audience/expiry/nonce/signature/unverified email拒否、state/cookie不一致、cancel、二重callback、一回限りtransaction、open redirect拒否。
- [ ] session testsを追加: expiry=created+8*60*60*1000、raw token未保存、正しいcookie属性、CSRF不一致403、logout失効、master固定、same email/different sub拒否、失効allowlist拒否。missing auth config503。
- [ ] `pnpm test:cloudflare -- auth` でREDを確認。
- [ ] additive schemaを作成: cf_auth_config、cf_google_identities（sub PK/email UNIQUE）、cf_oauth_transactions（state hash/browser hash/nonce/verifier/created/expiry）、cf_sessions（token hash/sub/CSRF hash/expiry）＋expiry indexes。OAuthのverifierはexchangeまで必要なため短寿命transactionだけに保存し、消費時削除する。
- [ ] joseはnpmのstable version/Workers互換を確認してexact pin。Google固定discovery/JWKSとtoken endpoint、署名/claims検証を実装。OAuth stateはDELETE RETURNING相当で一回だけconsume。上限付きJSON/timeout、secretログなし。
- [ ] server callback成功はsession発行後same-origin `/#/teacher` へredirect。Google errorもtoken/codeを画面URLへ残さず日本語loginエラーへ戻す。
- [ ] auth tests＋D1 schema適用/二回目no-op＋typechecksを実行。commit。

### Task 3: Worker APIとD1認可

**Files:** Create `worker/api.ts`, `worker/room-authority.ts`, `tests/cloudflare/api.test.ts`; Modify `worker/index.ts`, `src/platform/http.ts`, `tsconfig.worker.json`。

**Consumes:** Task1 route resolution、Task2 identity provider、fromD1、createApiHandlers。
**Produces:** createWorkerApi、authorizeRoomConnection/RoomPrincipal、same-origin API contract。

- [ ] API fixture testsを追加: public-config/join-info匿名OK、Class作成teacherのみ、master管理、Mate作成/host、他参加者result拒否、旧UID/header注入拒否、CSRF、unknown/methodエラー。
- [ ] D1 handler command testsでcreate/join/ready/start/operations/resultsを両mode完走。50人/51拒否・同request再送・start/interrupt/remove競合もHTTP境界で確認。
- [ ] `pnpm test:cloudflare -- api` でREDを確認。
- [ ] WorkerはDB/teacher provider/server config/now/randomUUIDを注入。Supabase gateway/PG/匿名identityをimportしない。OriginなしGETは許可し、mutationは既存same-origin/CSRF規則へ沿わせる。
- [ ] room routesはROOMS.getByName(publicId)へ転送。外部requestが内部URL/headerを偽装できないよう転送metadataを再生成。DO内でも認可を行う。`/api/auth/*` は固定routeのみ。
- [ ] createApiHandlersでD1非transactional時にCASが不足する箇所だけ修正。lazy global cleanupをroom requestへ毎回混ぜずCron中心へ移す。既存contractの意図は変えない。
- [ ] API認可/HTTP regression、既存546、native D118＋typechecksを実行。commit。

### Task 4: Room DO / Hibernation WS / alarm

**Files:** Create `worker/room.ts`, `worker/room-events.ts`, `migrations/d1/0003_room_notifications.sql`, `tests/cloudflare/realtime.test.ts`, `tests/cloudflare/alarms.test.ts`; Modify `wrangler.jsonc`, `worker/index.ts`, generated types。

**Consumes:** Task2 auth、Task3 RoomPrincipal/handlers。
**Produces:** RoomCoordinator、RoomNotification、D1 revision bookkeeping、role-safe realtime metadata in state responses。

- [ ] native DO testsを追加: simultaneous mutations直列化、join51→50、HTTP tokenとWS token認可一致、未認証WSデータなし/認証期限close、cross-origin upgrade拒否、studentにhost通知なし。
- [ ] removal/allowlist/session失効後の既存WS close/通知拒否、hibernate attachment復元、commit直後停止と再通知、duplicate/out-of-order revision、deadline/collection alarm遅延・再起動testsを追加してRED。
- [ ] wranglerにROOMS binding＋SQLite DO migrationを追加しtest環境にも明示。D1通知テーブルはroom FKでcascade、control/progress revisionとlast fingerprint/dirtyを保存。
- [ ] explicit promise queueでfetch/WS/alarm commandを調整。D1 commit後reconcile、未配送revisionを残してalarm retry。通知private answerなし、host progressは集約。通知前principalを再認可。
- [ ] WebSocket認証messageは最大4KiB、初回期限5秒。teacherはhandshake session、studentはmessage token。ping/pongはHibernation auto response、無制限memory queueを作らない。
- [ ] alarmは最早deadline/collection/notification retry/expiryから設定。expiryでsocket close、最終確定は既存idempotent D1 command。DO storageは運用metadataだけ。
- [ ] native DO/WS/alarms tests、typechecks、bundle graphを確認しcommit。

### Task 5: Reactを独立Auth/API/WSへ接続

**Files:** Create `src/web/auth.ts`, `src/web/room-socket.ts`, `tests/ui/cloudflare-auth.test.ts`, `tests/ui/cloudflare-realtime.test.ts`, `tests/ui/independent-sync.test.ts`; Modify `src/web/{api,realtime,main,room-sync-scheduler}.ts(x)`, `src/features/lobby/useStartRoom.tsx`, `src/features/play/useRoomSync.ts`, `app/teacher/page.tsx`, `package.json`, frontend env examples。

**Consumes:** Task2 session endpoints、Task3 API、Task4 realtime metadata。
**Produces:** 同一origin frontend、独立teacher UI、生徒匿名Auth不要、event-driven room sync。

- [ ] testsを先に追加: apiFetch URLがsame-origin、apikey/Supabase bearerなし、participant Authorization維持、teacher cookie/CSRF、Google login redirect/logout、room ownerの切替検出。
- [ ] WS testsはtokenがqueryに現れないこと、初回message、reconnect/backoff、cleanup、duplicate revisions、非表示/再表示、offline/onlineを確認。
- [ ] scheduler fake-clock testでWS接続中に60秒経過しても定期HTTPが発生しないこと、イベント/締切/refreshで1fetch、disconnected時bounded backoff、owner切替で古いstart再送なしを確認してRED。
- [ ] auth.tsとroom-socket.tsを実装しteacher page/main/useStartRoomを接続。ownerIdentityはteacher Google sub又はroom token hash由来とし、任意local IDを教員権限にしない。
- [ ] schedulerはdelay Infinityをidleとして扱い、timer Infinity overflowを起こさない。境界timer、visibility wake、clock syncThreeと既存stale response防止を維持。
- [ ] Supabase frontend runtime importsを除去し、SDKをpackageから削除。参照用PG/旧backend testsは必要に応じ保持し、削除してテスト数を減らさない。
- [ ] focused UI tests＋全suite＋build。distとWorker import graphにSupabase endpoint/SDK/PG driverなしを確認。commit。

### Task 6: Classroom/多room/負荷・ブラウザ

**Files:** Create `tests/cloudflare/load.test.ts`, `scripts/verify-independent-remote.mjs`, `docs/migration/independent-verification.md`; Modify fixture、CI/scripts。

**Consumes:** Task1〜5 independent stack。
**Produces:** ローカルHTTP/WS完走、独立性と実測記録、productionに混ざらないremote test setup。

- [ ] 50clients×2mode×15question×2field、teacher1、Mate4、51拒否、interrupt/pass、同順位、replay、複数room並行をnative HTTP/WSで実行するtestsを追加。database command直呼びだけでは通さない。
- [ ] Google署名fixtureはtest bundle限定。公開Workerへtest login endpoint/configを追加しない。remoteは専用test Worker/D1、authはGoogleの実loginを利用し必要なsessionはsecretとしてローカルにだけ保持。
- [ ] Playwright MCPでteacher/students/Mate、manual/QR scanner（syntheticは明記）、nickname/ready/start/submit/review、390px/desktop、console/networkを確認。Supabase全URLへのrequestを検出したらfail。
- [ ] reload/duplicate tab/WS loss/foreground/expired reviewを確認し、証拠を残す。実機camera/touchはユーザー操作が必要な実機チェックとして分離。
- [ ] rows read/written、DO requests/WS、CPUを収集可能な範囲で記録。負荷fixture時間をproduction latencyと誤表現しない。remote mutation後のcleanupはnamed testroomだけ。
- [ ] 完了証拠と未検証境界をcommit。

### Task 7: Google設定・remote検証・候補公開

**Files:** Create `worker/maintenance.ts`, `docs/migration/independent-operations.md`; Modify `worker/index.ts`, `wrangler.jsonc`, `scripts/deploy-cloudflare.mjs`, health tests、verification doc。

**Consumes:** 全Tasks、既存Cloudflare build token、自動main公開。
**Produces:** Supabase非依存candidate、health、Cron、operation/rollback手順。

- [ ] native health testsでmigration未適用/DO未設定/Auth未設定を成功扱いしない。competitionBackend cloudflare、Class50/Mate4、releaseSHA、必要module準備状況を確認。
- [ ] cleanupIndependentStorageはroom/session/OAuthの期限をbounded処理しCron設定。expires判定/cleanup再実行/途中失敗をテスト。
- [ ] `pnpm verify:cloudflare` にnative cloudflare testsを追加し全typechecks/546＋D118＋新規tests/build/dryrunを実行。whole-branch independent reviewを行い指摘を修正して再検証。
- [ ] Google CloudでOAuth client/callback `https://ionicformulacompetition.taiyakiyaita.workers.dev/api/auth/google/callback` を準備。既存callback保持、scopes openid/emailのみ。設定保存に権限追加の確認が必要なら具体的対象を提示。client secret/正確なmaster emailはWorker secretに保存しチャット/ソースへ出さない。
- [ ] dedicated test environmentのmigration/DO/authと実HTTP/WS/Google loginを検証。設定値・resource IDs・テスト先を記録してからcandidate D1へadditive migrations。
- [ ] 検証済みbranchをmainへ統合・push。Cloudflare automatic buildとGitHub CI成功を待つ。公開SHA、health、static hash、実Google/class/Mate/reconnect/WS、Supabase network0を再確認。
- [ ] docsに旧版URL、新版データ独立、session/allowlist管理、alarm/Cron、usage、rollback（新版roomを旧版で継続不可）を記載。public evidenceを保存。全境界が満たされるまで「独立版完成」と言わない。

## Plan Self-Review

仕様の認証/認可/保存/API/DO/WS/期限/UI/負荷/公開はTask1〜7に対応。Review Focus5件はそれぞれtest stepsに割当済み。RoomPrincipal/AuthSessionView/RoomNotificationは定義場所を固定した。正確なOAuth secretとmaster emailは設定時の入力であり未実装仕様のplaceholderではない。実機や外部認証で人の操作が必要になっても、独立したコード/テスト作業を先に完了してから渡す。
