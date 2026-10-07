"use client";
import { useState } from "react";
import { TeacherAccessPanel } from "./TeacherAccessPanel";
import { MateAvailabilityPanel } from "./MateAvailabilityPanel";
import { QuestionProfileDialog } from "./QuestionProfileDialog";

// Rendered only after TeacherClient verifies the master role; APIs enforce it too.
export function TeacherManagement() {
  const [profileOpen, setProfileOpen] = useState(false);
  return <div className="teacher-management-grid">
    <TeacherAccessPanel/>
    <div className="teacher-management-tools">
      <MateAvailabilityPanel/>
      <section className="teacher-admin-card difficulty-management-card" aria-labelledby="difficulty-management-title">
        <div className="teacher-card-heading"><span className="teacher-card-symbol" aria-hidden="true">≋</span><div><p className="teacher-card-kicker">出題設定</p><h2 id="difficulty-management-title">出題の難易度</h2></div></div>
        <p>錯イオンの割合と、各イオン・化合物の出題対象を調整します。</p>
        <div className="teacher-card-foot"><span>新しく作るルームに反映</span><button type="button" className="teacher-open-action" onClick={() => setProfileOpen(true)}>難易度を調整<span aria-hidden="true">→</span></button></div>
      </section>
    </div>
    {profileOpen && <QuestionProfileDialog onClose={() => setProfileOpen(false)}/>}
  </div>;
}
