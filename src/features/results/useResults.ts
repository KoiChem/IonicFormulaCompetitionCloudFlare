"use client";

import { useEffect, useRef, useState } from "react";
import { ResultLoader, type ResultLoadState } from "./result-loader";

const initial: ResultLoadState = { full: null, summary: null, status: "loading", error: "", requestId: null,
  canRetry: false, terminal: false };

export function useResults(roomId: string, token: string | undefined, active: boolean, expiresAtMs?: number) {
  const [state, setState] = useState<ResultLoadState>(initial);
  const loaderRef = useRef<ResultLoader | null>(null);
  useEffect(() => {
    if (!active) { loaderRef.current?.dispose(); loaderRef.current = null; setState(initial); return; }
    const loader = new ResultLoader({ roomId, token, expiresAtMs,
      isAvailable: () => navigator.onLine !== false && !document.hidden,
      onChange: setState });
    loaderRef.current = loader;
    setState(loader.state);
    const resumed = () => loader.availabilityChanged();
    window.addEventListener("online", resumed);
    document.addEventListener("visibilitychange", resumed);
    void loader.start();
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
      window.removeEventListener("online", resumed);
      document.removeEventListener("visibilitychange", resumed);
    };
  }, [roomId, token, active, expiresAtMs]);
  return { ...state, retry: () => loaderRef.current?.retry() };
}
