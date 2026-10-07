import { HistoryResult } from "../../../src/features/results/HistoryResult";

export default async function HistoryResultPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ role?: string }> }) {
  const { id } = await params;
  const { role } = await searchParams;
  return <HistoryResult roomId={id} role={role === "teacher" ? "teacher" : "participant"}/>;
}
