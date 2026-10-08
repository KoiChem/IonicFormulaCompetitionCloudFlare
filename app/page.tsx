import { appPath } from '../src/web/routing';
import { MateCreateLink } from "./MateCreateLink";
import { JoinCodeForm } from "../src/features/setup/JoinCodeForm";
import { ActiveRoomLinks } from "../src/features/setup/ActiveRoomLinks";
export default function Home() {
  return (
    <main>
      <section className="home-card" aria-labelledby="home-title">
        <header>
          <p className="eyebrow">IONIC FORMULA</p>
          <h1 id="home-title">Competition</h1>
          <div id="home-participation-status" className="home-participation-status" />
        </header>

        <JoinCodeForm />
        <ActiveRoomLinks />

        <nav aria-label="ルームを作成・管理する">
          <a className="secondary-link" href={appPath("/teacher")}>
            クラスコンペ
          </a>
          <MateCreateLink />
        </nav>
        <nav className="home-utility-actions" aria-label="履歴と関連アプリ">
          <a className="secondary-link" href={appPath("/history")}>過去の結果</a>
          <a className="secondary-link" href="https://koichem.github.io/IonicFormula/" target="_blank" rel="noopener noreferrer" aria-label="IonicFormula（新しいタブで開く）">IonicFormula</a>
        </nav>
      </section>
    </main>
  );
}
