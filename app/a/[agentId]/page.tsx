import PublicChat from "@/components/public-chat";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return <PublicChat agentId={agentId} />;
}
