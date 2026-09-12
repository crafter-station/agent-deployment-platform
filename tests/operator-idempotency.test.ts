import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { executeCommand } from "../lib/commands";
import { type Context, DomainError, specHash } from "../lib/domain";
import { type OperatorInput, operator } from "../lib/operator";
import { getWorkspace, transactWorkspace } from "../lib/store";

let directory: string;
const originalDirectory = process.env.STUDIO_DATA_DIR;
const originalDatabase = process.env.DATABASE_URL;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "studio-operator-"));
  process.env.STUDIO_DATA_DIR = directory;
  delete process.env.DATABASE_URL;
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory) process.env.STUDIO_DATA_DIR = originalDirectory;
  else delete process.env.STUDIO_DATA_DIR;
  if (originalDatabase) process.env.DATABASE_URL = originalDatabase;
  else delete process.env.DATABASE_URL;
});

const context = (): Context => ({
  workspaceId: crypto.randomUUID(),
  actorId: "owner",
});
const request = (): OperatorInput => ({
  messages: [{ role: "user", content: "Crea Quequito para ayudar al grupo" }],
});
async function create(tools: ToolSet) {
  const execute = tools.createAgent.execute as unknown as (
    input: unknown,
    options: { toolCallId: string; messages: never[] },
  ) => Promise<unknown>;
  return execute(
    { name: "Quequito", purpose: "Ayudar al grupo", instructions: "Sé breve" },
    { toolCallId: "create", messages: [] },
  );
}

test("concurrent operator retries execute one model and one mutation", async () => {
  const ctx = context();
  const input = request();
  let calls = 0;
  let release: (() => void) | undefined;
  let toolSaved: (() => void) | undefined;
  const saved = new Promise<void>((resolve) => {
    toolSaved = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    generate: async ({ tools }: { tools: ToolSet }) => {
      calls++;
      await create(tools);
      toolSaved?.();
      await pending;
      return { text: "Creado" };
    },
  };
  const first = operator(ctx, input, deps);
  await saved;
  const concurrent = await operator(ctx, input, deps);
  expect(concurrent.status).toBe("running");
  expect(concurrent.replayed).toBe(true);
  expect(concurrent.actions).toHaveLength(1);
  release?.();
  const complete = await first;
  const replay = await operator(ctx, input);
  expect(calls).toBe(1);
  expect(complete.status).toBe("succeeded");
  expect(replay.text).toBe("Creado");
  expect(replay.actions).toHaveLength(1);
  expect(Object.keys((await getWorkspace(ctx)).agents)).toHaveLength(1);
  expect((await getWorkspace(ctx)).operatorHistory).toHaveLength(2);
});

test("failure after a mutation persists saved actions and never blindly retries", async () => {
  const ctx = context();
  const input = request();
  let calls = 0;
  const deps = {
    generate: async ({ tools }: { tools: ToolSet }) => {
      calls++;
      await create(tools);
      throw new Error("Bearer secret-that-must-not-appear");
    },
  };
  const first = await operator(ctx, input, deps);
  const replay = await operator(ctx, input, deps);
  expect(calls).toBe(1);
  expect(first.status).toBe("failed");
  expect(first.actions).toHaveLength(1);
  expect(first.text).toContain("1 operación(es) ya quedaron guardadas");
  expect(replay.errorCode).toBe("MODEL_FAILED");
  expect(replay.text).toBe(first.text);
  expect(JSON.stringify(await getWorkspace(ctx))).not.toContain(
    "secret-that-must-not-appear",
  );
});

test("replay recovers command evidence across a mutation-to-action crash gap", async () => {
  const ctx = context();
  const input = request();
  const first = await operator(ctx, input, {
    generate: async ({ tools }) => {
      await create(tools);
      return { text: "Creado" };
    },
  });
  await transactWorkspace(ctx, (state) => {
    const stored = state.operatorRequests?.[first.requestId];
    if (!stored) throw new Error("Missing request");
    stored.actions = [];
    stored.status = "running";
    stored.text = "La solicitud fue interrumpida";
  });
  const replay = await operator(ctx, input, {
    generate: async () => {
      throw new Error("Must never regenerate");
    },
  });
  expect(replay.status).toBe("running");
  expect(replay.actions).toHaveLength(1);
  expect(replay.actions[0].type).toBe("agents.create");
  expect(replay.actions[0].agentId).toBe(first.actions[0].agentId);
  expect(Object.keys((await getWorkspace(ctx)).agents)).toHaveLength(1);
});

test("an explicit operation ID rejects different payload and actor scope is isolated", async () => {
  const ctx = context();
  const input = { ...request(), operationId: "stable-request" };
  const deps = { generate: async () => ({ text: "Done" }) };
  const first = await operator(ctx, input, deps);
  await expect(
    operator(
      ctx,
      { ...input, messages: [{ role: "user", content: "Different request" }] },
      deps,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const second = await operator(
    { ...ctx, actorId: "another-owner" },
    input,
    deps,
  );
  expect(first.requestId).not.toBe(second.requestId);
  expect(second.replayed).toBe(false);
});

test("a completed deployment produces a truthful receipt even if final narration hits its budget", async () => {
  const ctx = context();
  const input = request();
  const result = await operator(ctx, input, {
    generate: async ({ tools }) => {
      const created = (await create(tools)) as {
        agent: { id: string; revision: number; instructions?: string };
      };
      expect(created.agent.instructions).toBeUndefined();
      const snapshot = (await getWorkspace(ctx)).agents[created.agent.id];
      await executeCommand(ctx, {
        type: "previews.record",
        agentId: snapshot.id,
        operationId: "fixture-preview",
        input: {
          revision: snapshot.revision,
          specHash: specHash(snapshot),
          passed: true,
          input: "Fixture setup",
          output: "Fixture setup",
          model: snapshot.model,
          mode: "model",
        },
      });
      const deploy = tools.deployAgent.execute as unknown as (
        input: unknown,
        options: { toolCallId: string; messages: never[] },
      ) => Promise<unknown>;
      await deploy(
        { agentId: snapshot.id, expectedRevision: snapshot.revision },
        { toolCallId: "deploy", messages: [] },
      );
      throw new DomainError(
        "OPERATOR_BUDGET",
        "Final model narration exceeded the budget",
        429,
      );
    },
  });
  expect(result.status).toBe("succeeded");
  expect(result.errorCode).toBeUndefined();
  expect(result.text).toContain("Desplegué Quequito en web con la revisión 1");
  const state = await getWorkspace(ctx);
  expect(state.deployments[0].active).toBe(true);
  expect(result.actions.at(-1)?.deploymentId).toBe(state.deployments[0].id);
  const replay = await operator(ctx, input);
  expect(replay.text).toBe(result.text);
  expect(replay.status).toBe("succeeded");
});

test("a rejected deployment cannot produce a success receipt", async () => {
  const ctx = context();
  const result = await operator(ctx, request(), {
    generate: async ({ tools }) => {
      const created = (await create(tools)) as {
        agent: { id: string; revision: number };
      };
      const deploy = tools.deployAgent.execute as unknown as (
        input: unknown,
        options: { toolCallId: string; messages: never[] },
      ) => Promise<unknown>;
      await deploy(
        { agentId: created.agent.id, expectedRevision: created.agent.revision },
        { toolCallId: "deploy", messages: [] },
      );
      return { text: "Should never reach this point" };
    },
  });
  expect(result.status).toBe("failed");
  expect(result.errorCode).toBe("PREVIEW_REQUIRED");
  expect(result.text).not.toContain("Desplegué");
  expect((await getWorkspace(ctx)).deployments).toHaveLength(0);
});
