import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AgentRun,
  type AgentSpec,
  agentInputSchema,
  type Command,
  type CommandResult,
  type Context,
  canonical,
  type Deployment,
  DomainError,
  type Preview,
  specHash,
} from "./domain";
import { transactWorkspace } from "./store";

export { getWorkspace } from "./store";

const patchSchema = z
  .object({
    name: agentInputSchema.shape.name.optional(),
    purpose: agentInputSchema.shape.purpose.optional(),
    instructions: agentInputSchema.shape.instructions.optional(),
    model: z.string().min(1).max(120).optional(),
    githubRepo: agentInputSchema.shape.githubRepo,
    budget: z
      .object({
        maxTokensPerRun: z.number().int().min(128).max(32000),
        dailyRunLimit: z.number().int().min(1).max(10000),
      })
      .optional(),
    grants: z
      .object({
        webReply: z.boolean().optional(),
        githubRead: z.boolean().optional(),
        githubWrite: z.boolean().optional(),
        whatsappSend: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const previewSchema = z
  .object({
    revision: z.number().int().positive(),
    specHash: z.string().length(64),
    passed: z.boolean(),
    input: z.string().max(16000),
    output: z.string().max(48000),
    model: z.string(),
    mode: z.enum(["model", "fixture"]),
  })
  .strict();
const runSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    channel: z.enum(["web", "whatsapp", "preview", "github"]),
    input: z.string().min(1).max(16000),
    deploymentId: z.string().optional(),
  })
  .strict();
const runUpdateSchema = z
  .object({
    runId: z.string(),
    status: z
      .enum(["queued", "running", "succeeded", "failed", "uncertain"])
      .optional(),
    output: z.string().max(48000).optional(),
    error: z.string().max(2000).optional(),
    tokens: z.number().int().nonnegative().optional(),
    checkpoint: z
      .object({
        name: z.string().max(120),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();

export async function executeCommand(
  ctx: Context,
  command: Command,
): Promise<CommandResult> {
  if (!command.operationId || command.operationId.length > 200)
    throw new DomainError(
      "OPERATION_ID_REQUIRED",
      "Provide a stable operation ID",
    );
  const fingerprint = createHash("sha256")
    .update(canonical(command))
    .digest("hex");
  const key = createHash("sha256")
    .update(`${ctx.actorId}\0${command.operationId}`)
    .digest("hex");
  return transactWorkspace(ctx, (state) => {
    const previous = state.operations[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "Operation ID already belongs to different input",
          409,
        );
      return { ...structuredClone(previous.result), replayed: true };
    }
    const now = new Date().toISOString();
    const result: CommandResult = {
      operationId: command.operationId,
      replayed: false,
    };
    let agent: AgentSpec | undefined;
    if (command.type !== "agents.create") {
      agent = command.agentId ? state.agents[command.agentId] : undefined;
      if (!agent)
        throw new DomainError(
          "AGENT_NOT_FOUND",
          "Agent not found in this workspace",
          404,
        );
      if (
        command.expectedRevision !== undefined &&
        command.expectedRevision !== agent.revision
      )
        throw new DomainError(
          "REVISION_CONFLICT",
          `Expected revision ${command.expectedRevision}; current revision is ${agent.revision}`,
          409,
        );
    }
    switch (command.type) {
      case "agents.create": {
        const input = agentInputSchema.parse(command.input);
        const created: AgentSpec = {
          ...input,
          id: randomUUID(),
          revision: 1,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        };
        state.agents[created.id] = created;
        state.revisions[created.id] = [structuredClone(created)];
        result.agent = created;
        break;
      }
      case "agents.patch": {
        if (command.expectedRevision === undefined)
          throw new DomainError(
            "REVISION_REQUIRED",
            "Editing requires expectedRevision",
            409,
          );
        const current = agent as AgentSpec;
        const patch = patchSchema.parse(command.input);
        const updated: AgentSpec = {
          ...current,
          ...patch,
          grants: { ...current.grants, ...patch.grants },
          revision: current.revision + 1,
          updatedAt: now,
        };
        state.agents[current.id] = updated;
        state.revisions[current.id].push(structuredClone(updated));
        result.agent = updated;
        break;
      }
      case "agents.pause":
      case "agents.resume": {
        const current = agent as AgentSpec;
        if (
          command.type === "agents.resume" &&
          !state.deployments.some(
            (item) => item.agentId === current.id && item.active,
          )
        )
          throw new DomainError(
            "DEPLOYMENT_REQUIRED",
            "Deploy a tested revision before resuming",
            409,
          );
        current.status = command.type === "agents.pause" ? "paused" : "live";
        current.updatedAt = now;
        result.agent = current;
        break;
      }
      case "previews.record": {
        const current = agent as AgentSpec;
        const input = previewSchema.parse(command.input);
        const tested = state.revisions[current.id].find(
          (item) => item.revision === input.revision,
        );
        if (!tested || specHash(tested) !== input.specHash)
          throw new DomainError(
            "PREVIEW_MISMATCH",
            "Preview must reference an existing exact revision",
            409,
          );
        const preview: Preview = {
          ...input,
          id: randomUUID(),
          agentId: current.id,
          createdAt: now,
        };
        state.previews.push(preview);
        result.preview = preview;
        break;
      }
      case "deployments.create": {
        const current = agent as AgentSpec;
        if (command.expectedRevision === undefined)
          throw new DomainError(
            "REVISION_REQUIRED",
            "Deploying requires expectedRevision",
            409,
          );
        const hash = specHash(current);
        const preview = state.previews.findLast(
          (item) =>
            item.agentId === current.id &&
            item.revision === current.revision &&
            item.specHash === hash &&
            item.passed &&
            item.mode === "model",
        );
        if (!preview)
          throw new DomainError(
            "PREVIEW_REQUIRED",
            "Run a successful model preview of this revision before deploying",
            409,
          );
        state.deployments
          .filter((item) => item.agentId === current.id)
          .forEach((item) => {
            item.active = false;
          });
        const deployment: Deployment = {
          id: randomUUID(),
          agentId: current.id,
          revision: current.revision,
          specHash: hash,
          previewId: preview.id,
          createdAt: now,
          active: true,
        };
        state.deployments.push(deployment);
        current.status = "live";
        current.updatedAt = now;
        result.agent = current;
        result.deployment = deployment;
        break;
      }
      case "deployments.rollback": {
        const current = agent as AgentSpec;
        const input = z
          .object({ deploymentId: z.string() })
          .strict()
          .parse(command.input);
        const target = state.deployments.find(
          (item) =>
            item.id === input.deploymentId && item.agentId === current.id,
        );
        if (!target)
          throw new DomainError(
            "DEPLOYMENT_NOT_FOUND",
            "Deployment not found",
            404,
          );
        state.deployments
          .filter((item) => item.agentId === current.id)
          .forEach((item) => {
            item.active = item.id === target.id;
          });
        current.updatedAt = now;
        result.agent = current;
        result.deployment = target;
        break;
      }
      case "runs.create": {
        const current = agent as AgentSpec;
        const input = runSchema.parse(command.input);
        const deployment = state.deployments.find(
          (item) =>
            item.agentId === current.id &&
            item.active &&
            (!input.deploymentId || input.deploymentId === item.id),
        );
        if (
          input.channel !== "preview" &&
          (current.status !== "live" || !deployment)
        )
          throw new DomainError(
            "AGENT_NOT_LIVE",
            "A live deployment is required",
            409,
          );
        const todayCount = state.runs.filter(
          (item) =>
            item.agentId === current.id &&
            item.channel !== "preview" &&
            item.createdAt.slice(0, 10) === now.slice(0, 10),
        ).length;
        if (
          input.channel !== "preview" &&
          todayCount >= current.budget.dailyRunLimit
        )
          throw new DomainError(
            "BUDGET_EXHAUSTED",
            "Daily run budget exhausted",
            429,
          );
        const revision =
          input.channel === "preview"
            ? current.revision
            : (deployment as Deployment).revision;
        const snapshot = state.revisions[current.id].find(
          (item) => item.revision === revision,
        ) as AgentSpec;
        const run: AgentRun = {
          ...input,
          id: randomUUID(),
          agentId: current.id,
          deploymentId:
            input.channel === "preview" ? undefined : deployment?.id,
          revision,
          snapshot: structuredClone(snapshot),
          specHash: specHash(snapshot),
          status: "queued",
          checkpoints: [],
          tokens: 0,
          operationId: command.operationId,
          createdAt: now,
          updatedAt: now,
        };
        state.runs.push(run);
        result.run = run;
        break;
      }
      case "runs.update": {
        const current = agent as AgentSpec;
        const input = runUpdateSchema.parse(command.input);
        const run = state.runs.find(
          (item) => item.id === input.runId && item.agentId === current.id,
        );
        if (!run) throw new DomainError("RUN_NOT_FOUND", "Run not found", 404);
        const transitions: Record<AgentRun["status"], AgentRun["status"][]> = {
          queued: ["running", "failed"],
          running: ["succeeded", "failed", "uncertain"],
          succeeded: [],
          failed: [],
          uncertain: [],
        };
        if (input.status && !transitions[run.status].includes(input.status))
          throw new DomainError(
            "RUN_STATE_CONFLICT",
            `Cannot move run from ${run.status} to ${input.status}`,
            409,
          );
        if (
          input.status === "running" &&
          run.channel !== "preview" &&
          current.status !== "live"
        )
          throw new DomainError(
            "AGENT_NOT_LIVE",
            "Agent was paused before dispatch",
            409,
          );
        if (input.tokens !== undefined && input.tokens < run.tokens)
          throw new DomainError(
            "TOKEN_COUNT_INVALID",
            "Token usage cannot decrease",
          );
        if (input.status) run.status = input.status;
        if (input.output !== undefined) run.output = input.output;
        if (input.error !== undefined) run.error = input.error;
        if (input.tokens !== undefined) run.tokens = input.tokens;
        if (input.checkpoint)
          run.checkpoints.push({ ...input.checkpoint, at: now });
        run.updatedAt = now;
        result.run = run;
        break;
      }
      default:
        throw new DomainError("UNKNOWN_COMMAND", "Unsupported command");
    }
    state.events.push({
      id: randomUUID(),
      type: command.type,
      actorId: ctx.actorId,
      agentId: result.agent?.id || command.agentId,
      resourceId: result.preview?.id || result.deployment?.id || result.run?.id,
      createdAt: now,
    });
    state.operations[key] = { fingerprint, result: structuredClone(result) };
    return structuredClone(result);
  });
}
