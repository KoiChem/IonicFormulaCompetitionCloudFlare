import type { ReactNode } from "react";

export function PodiumPlace({ rank, name, children, trailing, className = "" }: { rank: number; name?: string; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return <div className={`podium-place ${rank >= 1 && rank <= 3 ? `podium-rank-${rank}` : ""} ${className}`.trim()}>
    <div className="podium-content"><strong className="podium-title">{rank}位{name ? <>　{name}</> : null}</strong><span className="podium-detail">{children}</span></div>
    {trailing}
  </div>;
}
