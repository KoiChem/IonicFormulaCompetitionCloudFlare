# Collecting parade implementation plan
**Goal:** ホストだけに集計中行進を表示して結果受信時に即座に切り替える。
**Architecture:** 独立したCollectingParadeとgeometry helperを既存ホスト待機分岐へ組み込む。
**Tech Stack:** React, TypeScript, SVG, CSS, Vitest, Playwright
**Spec:** ../specs/2026-10-31-collecting-parade-design.md
## Global Constraints
参加者の送信処理をアンマウントしない。追加の待機時間を設けない。ホストのclassだけ。
## Review Focus
1人/50人、画面幅変更、結果受信、軽量/OS reduced motion、未受信の時間切れを確認。
### Task 1: parade
- [x] geometryの順番・循環・間隔と静的描画の名前・色・コピーのテストを作り失敗確認。
- [x] src/features/lobby/CollectingParade.tsx とcollecting-parade.cssに実装しLite App.tsxと共通RoomScreen.tsxへ統合。
- [x] 両リポジトリのテスト・型検査・ビルド、ブラウザの進行と結果切替確認。
- [x] コミット・公開・公開ページ確認。
