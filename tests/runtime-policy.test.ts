import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { executeCommand } from "../lib/commands";
import { type AgentSpec, type Context, specHash } from "../lib/domain";
import {
  memoryScope,
  type RunInput,
  type RuntimeDependencies,
  runAgent,
} from "../lib/runtime";
import { getWorkspace, transactWorkspace } from "../lib/store";

const originalDatabase = process.env.DATABASE_URL;
const originalDirectory = process.env.STUDIO_DATA_DIR;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "studio-runtime-"));
  process.env.STUDIO_DATA_DIR = directory;
  delete process.env.DATABASE_URL;
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  if (originalDatabase) process.env.DATABASE_URL = originalDatabase;
  else delete process.env.DATABASE_URL;
  if (originalDirectory) process.env.STUDIO_DATA_DIR = originalDirectory;
  else delete process.env.STUDIO_DATA_DIR;
});

const context = (): Context => ({
  workspaceId: crypto.randomUUID(),
  actorId: "owner",
});
const fixture: RuntimeDependencies = {
  generate: async () => ({ text: "Respuesta de prueba", tokens: 50 }),
};

async function create(ctx: Context, overrides = {}) {
  const result = await executeCommand(ctx, {
    type: "agents.create",
    operationId: crypto.randomUUID(),
    input: {
      name: "Quequito",
      purpose: "Ayudar",
      instructions: "Responde brevemente.",
      ...overrides,
    },
  });
  return result.agent as AgentSpec;
}

async function deployFixture(ctx: Context, agent: AgentSpec) {
  await executeCommand(ctx, {
    type: "previews.record",
    operationId: crypto.randomUUID(),
    agentId: agent.id,
    input: {
      revision: agent.revision,
      specHash: specHash(agent),
      passed: true,
      input: "Fixture setup",
      output: "Fixture setup",
      model: agent.model,
      mode: "model",
    },
  });
  await executeCommand(ctx, {
    type: "deployments.create",
    agentId: agent.id,
    expectedRevision: agent.revision,
    operationId: crypto.randomUUID(),
  });
}

function input(agent: AgentSpec, changes: Partial<RunInput> = {}): RunInput {
  return {
    agentId: agent.id,
    message: "Hola",
    sessionId: "conversation-a",
    environment: "preview",
    requester: "owner",
    operationId: crypto.randomUUID(),
    ...changes,
  };
}

async function invoke(tools: ToolSet, name: string, value: unknown) {
  const selected = tools[name];
  if (!selected?.execute) throw new Error(`Missing tool ${name}`);
  const execute = selected.execute as unknown as (
    input: unknown,
    options: { toolCallId: string; messages: never[] },
  ) => unknown;
  return execute(value, {
    toolCallId: crypto.randomUUID(),
    messages: [],
  });
}

describe("deployed runtime authority and persistence", () => {
  test("persists run before inference and concurrent duplicate cannot execute twice", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const request = input(agent);
    let calls = 0;
    const deps: RuntimeDependencies = {
      generate: async () => {
        calls++;
        expect((await getWorkspace(ctx)).runs[0].status).toBe("running");
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { text: "Una sola respuesta", tokens: 10 };
      },
    };
    await Promise.all([
      runAgent(ctx, request, deps),
      runAgent(ctx, request, deps),
    ]);
    const replay = await runAgent(ctx, request, deps);
    expect(calls).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.text).toBe("Una sola respuesta");
    expect((await getWorkspace(ctx)).runs).toHaveLength(1);
    await expect(
      runAgent(ctx, { ...request, message: "Different" }, deps),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("model fixture is labeled and cannot authorize deployment", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const result = await runAgent(ctx, input(agent), fixture);
    expect(result.preview?.mode).toBe("fixture");
    expect(result.preview?.specHash).toBe(specHash(agent));
    await expect(
      executeCommand(ctx, {
        type: "deployments.create",
        agentId: agent.id,
        expectedRevision: agent.revision,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
  });

  test("editing during preview preserves the immutable tested revision", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const result = await runAgent(ctx, input(agent), {
      generate: async () => {
        await executeCommand(ctx, {
          type: "agents.patch",
          agentId: agent.id,
          expectedRevision: 1,
          operationId: crypto.randomUUID(),
          input: { instructions: "Instructions changed while running" },
        });
        return { text: "Original revision output", tokens: 20 };
      },
    });
    expect(result.preview?.revision).toBe(1);
    expect(result.preview?.specHash).toBe(specHash(agent));
    expect((await getWorkspace(ctx)).agents[agent.id].revision).toBe(2);
  });

  test("revocation during inference withholds the final reply and replay", async () => {
    const ctx = context();
    const agent = await create(ctx);
    await deployFixture(ctx, agent);
    const request = input(agent, { environment: "web", requester: "public" });
    const result = await runAgent(ctx, request, {
      generate: async () => {
        await executeCommand(ctx, {
          type: "agents.patch",
          agentId: agent.id,
          expectedRevision: 1,
          operationId: crypto.randomUUID(),
          input: { grants: { webReply: false } },
        });
        return { text: "Must not escape", tokens: 30 };
      },
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toContain("CAPABILITY_DENIED");
    expect(result.text).toBe("");
    expect(result.run.output).toBeUndefined();
    await expect(runAgent(ctx, request, fixture)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
  });

  test("public member cannot use owner GitHub credentials even when agent has a read grant", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      githubRepo: "owner/repository",
      grants: { githubRead: true },
    });
    await deployFixture(ctx, agent);
    let providerCalls = 0;
    const result = await runAgent(
      ctx,
      input(agent, { environment: "web", requester: "public" }),
      {
        githubRead: async () => {
          providerCalls++;
          return { repo: "owner/repository", entries: [] };
        },
        generate: async ({ tools }) => {
          expect(Object.keys(tools)).not.toContain("editAgent");
          expect(Object.keys(tools)).not.toContain("deployAgent");
          await expect(invoke(tools, "githubRead", {})).rejects.toMatchObject({
            code: "REQUESTER_DENIED",
          });
          return {
            text: "No tengo acceso al repositorio en esta conversación.",
            tokens: 20,
          };
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(result.run.status).toBe("succeeded");
  });

  test("memory is isolated by agent, conversation and preview environment", async () => {
    const ctx = context();
    const first = await create(ctx);
    const second = await create(ctx);
    await deployFixture(ctx, first);
    const remember: RuntimeDependencies = {
      generate: async ({ tools }) => {
        await invoke(tools, "memoryRemember", {
          key: "deadline",
          value: "Friday",
        });
        return { text: "Saved", tokens: 20 };
      },
    };
    await runAgent(ctx, input(first, { environment: "web" }), remember);
    const read: RuntimeDependencies = {
      generate: async ({ tools }) => {
        expect(await invoke(tools, "memoryRead", { key: "deadline" })).toEqual({
          value: null,
        });
        return { text: "No saved deadline", tokens: 20 };
      },
    };
    await runAgent(
      ctx,
      input(first, { environment: "web", sessionId: "conversation-b" }),
      read,
    );
    await runAgent(ctx, input(first), read);
    await runAgent(ctx, input(second), read);
    const state = await getWorkspace(ctx);
    expect(
      state.runtimeMemory?.[memoryScope(first.id, "web", "conversation-a")]
        ?.deadline,
    ).toBe("Friday");
  });

  test("daily budget claims are serialized and unauthorized content is not persisted", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      budget: { dailyRunLimit: 1, maxTokensPerRun: 4000 },
    });
    await runAgent(ctx, input(agent), fixture);
    await expect(
      runAgent(
        ctx,
        input(agent, { message: "Do not store this second input" }),
        fixture,
      ),
    ).rejects.toMatchObject({ code: "DAILY_BUDGET" });
    expect((await getWorkspace(ctx)).runs).toHaveLength(1);
    const other = context();
    await expect(runAgent(other, input(agent), fixture)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect((await getWorkspace(other)).runs).toHaveLength(0);
  });

  test("provider failure is durable and never leaks raw secrets in traces", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const request = input(agent);
    const result = await runAgent(ctx, request, {
      generate: async () => {
        throw new Error("Bearer secret-provider-token");
      },
    });
    expect(result.run.status).toBe("failed");
    expect(JSON.stringify(await getWorkspace(ctx))).not.toContain(
      "secret-provider-token",
    );
    expect((await runAgent(ctx, request, fixture)).run.status).toBe("failed");
    expect((await getWorkspace(ctx)).previews).toHaveLength(0);
  });

  test("over-budget inference is metered but cannot pass preview", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      budget: { maxTokensPerRun: 4000, dailyRunLimit: 100 },
    });
    const result = await runAgent(ctx, input(agent), {
      generate: async () => ({ text: "Withheld", tokens: 4001 }),
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.tokens).toBe(4001);
    expect(result.run.error).toContain("TOKEN_BUDGET");
    expect(result.preview).toBeUndefined();
  });

  test("input budget preflight refuses oversized context before calling the provider", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      budget: { maxTokensPerRun: 128, dailyRunLimit: 100 },
    });
    let calls = 0;
    const result = await runAgent(ctx, input(agent), {
      generate: async () => {
        calls++;
        return { text: "Must never be generated", tokens: 10 };
      },
    });
    expect(calls).toBe(0);
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toContain("TOKEN_BUDGET");
    expect(result.run.tokens).toBe(0);
  });

  test("a later provider failure preserves already reported step usage", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const result = await runAgent(ctx, input(agent), {
      generate: async ({ onUsage }) => {
        await onUsage?.(900);
        throw new Error("Second provider step failed");
      },
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.tokens).toBe(900);
    expect((await getWorkspace(ctx)).runs[0].tokens).toBe(900);
  });

  test("crashed in-flight operation is not blindly run a second time", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const request = input(agent);
    const first = await runAgent(ctx, request, fixture);
    await transactWorkspace(ctx, (state) => {
      const stored = state.runs.find((run) => run.id === first.run.id)!;
      stored.status = "running";
      delete stored.output;
    });
    let calls = 0;
    const replay = await runAgent(ctx, request, {
      generate: async () => {
        calls++;
        return { text: "Duplicate", tokens: 10 };
      },
    });
    expect(calls).toBe(0);
    expect(replay.run.status).toBe("running");
    expect(replay.text).toBe("");
  });
});
