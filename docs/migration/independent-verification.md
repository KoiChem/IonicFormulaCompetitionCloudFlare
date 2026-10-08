# 独立版の検証記録

対象は KoiChem/IonicFormulaCompetitionCloudFlare の codex/cloudflare-independent。旧GitHub Pages / Supabaseは変更していない。

## ローカルで確認したこと

- `pnpm verify:cloudflare`: frontend/Worker型検査、既存＋UI551件、native Worker24件、D118件、production buildが成功（2026-10-08）。
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
