import { type Capability, DomainError, type WorkspaceState } from "./domain";

export type CapabilityRequest = {
  agentId: string;
  capability: Capability;
  environment: "preview" | "production";
  sessionId?: string;
  githubRepo?: string;
  requester?: "owner" | "public";
  deploymentId?: string;
};

export function assertCapability(
  state: WorkspaceState,
  request: CapabilityRequest,
): void {
  const agent = state.agents[request.agentId];
  if (!agent) throw new DomainError("AGENT_NOT_FOUND", "Agent not found", 404);
  if (!agent.grants[request.capability])
    throw new DomainError(
      "CAPABILITY_DENIED",
      `${request.capability} is not granted`,
      403,
    );
  if (request.environment === "production") {
    if (agent.status !== "live")
      throw new DomainError("AGENT_NOT_LIVE", "Agent is not live", 409);
    const deployment = state.deployments.find(
      (item) =>
        item.agentId === agent.id &&
        item.active &&
        (!request.deploymentId || item.id === request.deploymentId),
    );
    if (!deployment)
      throw new DomainError(
        "DEPLOYMENT_REQUIRED",
        "An active deployment is required",
        409,
      );
    const revision = state.revisions[agent.id]?.find(
      (item) => item.revision === deployment.revision,
    );
    if (!revision?.grants[request.capability])
      throw new DomainError(
        "CAPABILITY_DENIED",
        "Capability was not granted in this deployment",
        403,
      );
    if (
      request.capability.startsWith("github") &&
      revision.githubRepo !== request.githubRepo
    )
      throw new DomainError(
        "RESOURCE_DENIED",
        "Repository is outside deployment scope",
        403,
      );
  }
  if (
    request.capability === "githubRead" ||
    request.capability === "githubWrite"
  ) {
    if (request.requester !== "owner")
      throw new DomainError(
        "REQUESTER_DENIED",
        "Repository access requires an authenticated owner",
        403,
      );
    if (!request.githubRepo || request.githubRepo !== agent.githubRepo)
      throw new DomainError(
        "RESOURCE_DENIED",
        "Repository is outside the current grant",
        403,
      );
  }
  if (
    (request.capability === "webReply" ||
      request.capability === "whatsappSend") &&
    !request.sessionId
  )
    throw new DomainError(
      "DESTINATION_REQUIRED",
      "A bound conversation destination is required",
      403,
    );
}
