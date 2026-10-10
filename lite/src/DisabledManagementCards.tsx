// The normal management cards are visible in Lite; account and Mate operations
// stay disabled, as explicitly requested. No auth or site-settings API is called.
export function TeacherAccessCard(){return <section className="teacher-admin-card teacher-access-card" aria-labelledby="teacher-access-title" aria-disabled="true">
  <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">＋</span><div><p className="teacher-card-kicker">アクセスの管理</p><h2 id="teacher-access-title">許可教員の管理</h2></div><span className="teacher-count-badge">0 / 100人</span></div>
  <p>登録したGoogleアカウントで、クラスコンペを作成できます。</p>
  <form className="teacher-invite-form" onSubmit={e=>e.preventDefault()}><label htmlFor="teacher-email">教員のメールアドレス</label><div className="teacher-invite-row"><input id="teacher-email" type="email" autoComplete="email" placeholder="teacher@example.com" maxLength={254} required value="" disabled readOnly/><button type="submit" className="teacher-add-action" disabled>登録する</button></div></form>
  <div className="teacher-roster-heading"><h3>登録済みの教員</h3><button type="button" className="teacher-text-action" disabled>再読み込み</button></div><div className="teacher-roster" aria-busy="false"><p className="teacher-empty-state">許可教員はまだ登録されていません。</p></div><p className="teacher-master-identity">管理者教員<span>—</span></p>
</section>;}
export function MateAvailabilityCard(){return <section className="teacher-admin-card mate-availability-card" aria-labelledby="mate-availability-title" aria-disabled="true">
  <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">⇄</span><div><p className="teacher-card-kicker">参加の管理</p><h2 id="mate-availability-title">メイトマッチの作成</h2></div></div><p>生徒が新しいメイトマッチを作れるかを設定します。</p>
  <div className="teacher-availability-control"><div><strong>新規作成を停止中</strong><span>既存のルームはそのまま続行できます。</span></div><button type="button" className="teacher-switch" role="switch" aria-label="メイトマッチの新規作成を許可" aria-checked="false" disabled><span className="teacher-switch-track" aria-hidden="true"><span className="teacher-switch-thumb"/></span><span>OFF</span></button></div>
</section>;}
