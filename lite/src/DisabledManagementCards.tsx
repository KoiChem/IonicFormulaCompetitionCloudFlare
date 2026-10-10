// Mate operations remain disabled in Lite.
export function MateAvailabilityCard(){return <section className="teacher-admin-card mate-availability-card" aria-labelledby="mate-availability-title" aria-disabled="true">
  <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">⇄</span><div><p className="teacher-card-kicker">参加の管理</p><h2 id="mate-availability-title">メイトマッチの作成</h2></div></div><p>生徒が新しいメイトマッチを作れるかを設定します。</p>
  <div className="teacher-availability-control"><div><strong>新規作成を停止中</strong><span>既存のルームはそのまま続行できます。</span></div><button type="button" className="teacher-switch" role="switch" aria-label="メイトマッチの新規作成を許可" aria-checked="false" disabled><span className="teacher-switch-track" aria-hidden="true"><span className="teacher-switch-thumb"/></span><span>OFF</span></button></div>
</section>;}
