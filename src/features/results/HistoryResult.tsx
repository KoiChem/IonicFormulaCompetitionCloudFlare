import { appPath } from '../../web/routing';
"use client";
import { useEffect, useState } from "react";
import { loadCredential } from "../play/useRoomSync";
import { Results } from "./Results";
import { useResults } from "./useResults";
import { ResultLoadPanel } from "./ResultLoadPanel";

export function HistoryResult({ roomId, role }: { roomId: string; role: "teacher" | "participant" }) {
  const [credential, setCredential] = useState<{ token: string } | null | undefined>(undefined);
  useEffect(() => setCredential(role === "participant" ? loadCredential(roomId) : null), [roomId, role]);
  const token = role === "participant" ? credential?.token : undefined;
  const resultLoad = useResults(roomId, token, role === "teacher" || Boolean(token));
  if (resultLoad.full) return <Results data={resultLoad.full}/>;
  if (role === "participant" && credential === undefined) return <main className="page-shell"><section className="panel"><h1>過去の結果</h1><p role="status">読み込み中…</p></section></main>;
  if (role === "participant" && !token) return <main className="page-shell"><section className="panel"><h1>過去の結果</h1><p role="alert">このブラウザに参加資格がありません</p><a href={appPath("/history")}>一覧へ戻る</a></section></main>;
  return <ResultLoadPanel state={resultLoad} retry={resultLoad.retry} history/>;
}
