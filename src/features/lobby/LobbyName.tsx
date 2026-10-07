"use client";
import { useEffect, useRef } from "react";

export function LobbyName({ nickname }: { nickname: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const fit = () => {
      const width = element.clientWidth;
      if (!width) return;
      const style = getComputedStyle(element);
      context.font = `700 32px ${style.fontFamily}`;
      const naturalWidth = context.measureText(nickname).width;
      const size = naturalWidth ? Math.max(16, Math.min(32, Math.floor(32 * (width - 2) / naturalWidth))) : 32;
      element.style.fontSize = `${size}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nickname]);
  return <span ref={ref} className="lobby-name" title={nickname} aria-label={nickname}>{nickname}</span>;
}
