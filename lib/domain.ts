import { createHash } from "node:crypto";
import { z } from "zod";

export const grantsSchema = z.object({
  webReply: z.boolean().default(true),
  githubRead: z.boolean().default(false),
  githubWrite: z.boolean().default(false),
  whatsappSend: z.boolean().default(false),
});

export const budgetSchema = z.object({
  maxTokensPerRun: z.number().int().min(128).max(32000).default(4000),
  dailyRunLimit: z.number().int().min(1).max(10000).default(100),
});

export const agentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(2000),
    instructions: z.string().trim().min(1).max(24000),
    model: z.string().min(1).max(120).default("anthropic/claude-sonnet-5"),
    grants: grantsSchema.default({
      webReply: true,
      githubRead: false,
      githubWrite: false,
      whatsappSend: false,
    }),
    githubRepo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    budget: budgetSchema.default({ maxTokensPerRun: 4000, dailyRunLimit: 100 }),
  })
  .strict();

export type AgentInput = z.infer<typeof agentInputSchema>;
export type Capability = keyof AgentInput["grants"];
export type Context = { workspaceId: string; actorId: string };
export type AgentSpec = AgentInput & {
  id: string;
  revision: number;
  status: "draft" | "live" | "paused";
  createdAt: string;
  updatedAt: string;
};
export type Preview = {
  id: string;
  agentId: string;
  revision: number;
  specHash: string;
  passed: boolean;
  input: string;
  output: string;
  model: string;
  mode: "model" | "fixture";
  createdAt: string;
};
export type Deployment = {
  id: string;
  agentId: string;
  revision: number;
  specHash: string;
  previewId: string;
  createdAt: string;
  active: boolean;
};
export type AgentRun = {
  id: string;
  agentId: string;
  deploymentId?: string;
  revision: number;
  sessionId: string;
  channel: "web" | "whatsapp" | "preview" | "github";
  status: "queued" | "running" | "succeeded" | "failed" | "uncertain";
  input: string;
  output?: string;
  error?: string;
  checkpoints: { name: string; at: string; data?: Record<string, unknown> }[];
  tokens: number;
  createdAt: string;
  updatedAt: string;
  operationId?: string;
  requester?: "owner" | "public";
  specHash?: string;
  snapshot?: AgentSpec;
};
export type WorkspaceEvent = {
  id: string;
  type: string;
  agentId?: string;
  actorId: string;
  resourceId?: string;
  createdAt: string;
};
export type CommandResult = {
  operationId: string;
  replayed: boolean;
  agent?: AgentSpec;
  preview?: Preview;
  deployment?: Deployment;
  run?: AgentRun;
};
export type WorkspaceState = {
  version: 1;
  workspaceId: string;
  agents: Record<string, AgentSpec>;
  revisions: Record<string, AgentSpec[]>;
  previews: Preview[];
  deployments: Deployment[];
  runs: AgentRun[];
  events: WorkspaceEvent[];
  operations: Record<string, { fingerprint: string; result: CommandResult }>;
  runtimeMemory?: Record<string, Record<string, string>>;
  operatorHistory?: {
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }[];
  operatorRequests?: Record<
    string,
    {
      fingerprint: string;
      status: "running" | "succeeded" | "failed";
      actions: {
        type: string;
        agentId?: string;
        revision?: number;
        runId?: string;
        previewId?: string;
        deploymentId?: string;
        status?: string;
      }[];
      text: string;
      errorCode?: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
};
export type Command = {
  type:
    | "agents.create"
    | "agents.patch"
    | "agents.pause"
    | "agents.resume"
    | "previews.record"
    | "deployments.create"
    | "deployments.rollback"
    | "runs.create"
    | "runs.update";
  operationId: string;
  agentId?: string;
  expectedRevision?: number;
  input?: unknown;
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function specHash(spec: AgentSpec): string {
  const {
    status: _status,
    updatedAt: _updatedAt,
    createdAt: _createdAt,
    ...behavior
  } = spec;
  return createHash("sha256").update(canonical(behavior)).digest("hex");
}
export function emptyWorkspace(workspaceId: string): WorkspaceState {
  return {
    version: 1,
    workspaceId,
    agents: {},
    revisions: {},
    previews: [],
    deployments: [],
    runs: [],
    events: [],
    operations: {},
  };
}
