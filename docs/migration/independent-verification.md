# 独立版の検証記録

対象は KoiChem/IonicFormulaCompetitionCloudFlare の codex/cloudflare-independent。旧GitHub Pages / Supabaseは変更していない。

## ローカルで確認したこと

- `pnpm verify:cloudflare`: frontend/Worker型検査、既存＋UI552件、native Worker28件、D118件、production buildが成功（2026-10-08）。
- native HTTP/DO/WS: Class50名、51人目拒否、15問×式/名の2欄、即時/一括両方式、1500欄を各方式で保存・採点、同点同時間の全員1位、同request再送。約3.2秒/2ケースはローカルfixture全体の所要時間であり公開環境の応答時間ではない。
- 未認証WSにはroomデータを送らず5秒alarmで切断。教員用host通知を生徒へ送らない。除外/教員session失効で既存接続も失効。Hibernationでattachmentを復元し、未送信D1 revisionを再送。
- deadline後、参加者HTTPがなくてもalarmがCOLLECTINGと10秒のcollection windowを経てFINISHEDへ確定。
- WS接続中60秒のfake-clockテストで定期HTTPなし、失敗時有限backoff、重複通知除外・再接続・timer破棄。
- Playwright MCP: native workerd/D1/DOのlocalhost fixture。教員作成、QRリンク、390px匿名参加、開始/ready/countdown、イオン名正解1問/パス4問/提出、教員・生徒の最終結果、結果reload。390px/1280pxで横はみ出しなし、console error0、Supabase resource request0。Mate2端末でも一括判定の作成/開始/入力/提出/最終結果を確認。カメラ読み取りは未実施。
- Browser fixtureはテスト専用Google identityとloopback origin変換を使用する。Google実認証・公開HTTPSの証拠として扱わない。production Workerからtest entryへのimportはない。
- 専用remote D1へ0002/0003 additive migrations適用、二回目`No migrations to apply`。本番D1へはまだ適用していない。

## 公開前の必要な証拠

Google専用OAuth設定、秘密設定、専用test Workerの実HTTP/WS/Google login、全体review、main統合とCI/Cloudflare build、公開URLの実HTTP/WS/Google loginを確認後、結果を追記する。D1 query/batch制限はnative D1の既存予算テストで確認したが、公開CPU/rows/WS課金値は未計測。実機camera/touchは別の手動確認対象。

公式参考: [Hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)、[Cloudflare GitHub docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/best-practices/websockets.mdx)。

## レビュー後の追記

専用検証Worker（846b550）でHTTPS経由のMate4名・提出・同順位確定、実WSSのhost/participant認証とping/pongを確認。実Google認証は未設定でhealthはauthReady=false/503を返す。GitHub CI 37715145844は成功。

レビューで期限超過後のmanifest取得がalarmをroom expiryまで先送りする問題と、半切断WSがHTTP復帰を妨げる問題を確認。両方の回帰テストが修正前に失敗することを確認し、期限超過は即時alarm、pong未応答10秒でHTTP再同期へ戻す修正を実施。
外部レビューは利用上限により最終判定前に終了したため、全体レビュー完了とは扱わない。実Googleログインと本番公開は保留。

## 実Google認証・公開検証版（2026-10-08）

専用OAuth clientをユーザーが作成し、検証Workerの秘密設定を保存。`https://ionicformulacompetition-phase1-test.koichem.workers.dev/api/health` は200、authReady/D1/DO=true。Safariで実Googleログインにより管理者教員となり、5問/3分/問題毎/イオン名のClassを作成。Playwright MCPの独立した匿名生徒が参加し、教員に参加者通知、開始/ready/countdown、N3−に窒化物イオンを回答して1点、残り4問をpass、提出。生徒と教員の最終結果は同じ1位/正解1/01:27.32/提出。教員画面が背面にある場合は待機し、ユーザーがSafariを前面にすると最終結果へ復帰することも確認。

ユーザーの明示承認後、本番Workerへ同じ専用OAuth client/masterの秘密設定を保存し、本番D1の0002/0003 migrationを適用済み。既存Supabase/Pagesは変更していない。本番独立コードへの切替・公開検証は以下に追記する。

同じ外部レビュアーが最終レビューを再開・完了。Criticalなし、残るImportantは期限切れCOUNTDOWN/COLLECTINGのalarm連続起動。両phaseのnative回帰テストで修正前に1.1秒219/321回のD1通知更新を確認。synchronizeで期限切れroomのWSを閉じalarmを削除する修正を追加。修正後の全検証552/28/18件、型検査・build成功を確認。

## 本番公開確認（2026-10-08）

mainを `2e898b66235ce02f97b2d6784e1cf99c54d9840c` にfast-forwardしてpush。GitHub CI [37769191635](https://github.com/KoiChem/IonicFormulaCompetitionCloudFlare/actions/runs/37769191635) の全工程成功、Cloudflare自動Build `8949f596-dc14-4306-bfee-6808dc62ed74` 成功（3m15s）を確認。公開healthは200、build=2e898b6、phase=independent、competitionBackend=cloudflare、D1/Auth/DO=true、Class50/Mate4。

- 本番URL: https://ionicformulacompetition.koichem.workers.dev/
- Safariで本番→Googleアカウント選択→教員/管理者画面へ復帰し、15問/3分/一括/イオン名Classを作成。
- 作成した専用検証Classのみへ50名の匿名credentialを実HTTPSで参加。教員UIに50名表示、51人目は409で拒否。実教員の開始要求、50名manifest/ready、実countdown後50名finishを受理。0点/同時間/同順位1位の生徒結果を確認。これは正答入力を省略した提出・容量検証であり、1500欄保存/採点の負荷検証はnative fixtureで別に実施した。
- 本番Mate4名を実HTTPSで作成・参加・開始・ready・提出・最終同順位1位まで確認。host/participantの実WSS認証、ping/pongをPlaywrightで確認。
- 本番ホームの横はみ出しなし、pageerror0、Supabase resource request0。実Google認証はSafari、匿名生徒/公開HTTP・WSSはPlaywright/CLIと証拠を分離。
- 作成したsynthetic roomは元の保持期限に従う。既存room/旧Supabase/Pagesデータは操作していない。
- 公開CPU/rows/WS課金の詳細な負荷計測、実機カメラ・タッチは未実施。ブラウザ確認を実機確認とは扱わない。
