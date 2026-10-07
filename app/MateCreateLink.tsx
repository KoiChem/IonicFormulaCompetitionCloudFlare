import { apiFetch } from '../src/web/api';
import { appPath } from '../src/web/routing';
"use client";
import { useEffect, useState } from "react";
export function MateCreateLink() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => { let active = true; void apiFetch("/api/public-config", { cache: "no-store" }).then(async response => await response.json() as { mateMatchEnabled?: boolean }).then(data => { if (active) setEnabled(data.mateMatchEnabled === true); }).catch(() => { if (active) setEnabled(false); }); return () => { active = false; }; }, []);
  if (enabled === null) return <span className="secondary-link" role="status">メイトマッチ</span>;
  if (!enabled) return <span className="secondary-link" role="status" aria-label="メイトマッチの新規作成は停止中">メイトマッチ</span>;
  return <a className="secondary-link" href={appPath("/mate/new")}>メイトマッチ</a>;
}
