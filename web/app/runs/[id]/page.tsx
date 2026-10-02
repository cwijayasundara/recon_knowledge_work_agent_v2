import { FlowShell } from "@/components/FlowShell";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FlowShell runId={id} />;
}
