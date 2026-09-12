import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand, getWorkspace } from "../lib/commands";
import { type AgentSpec, type Context, specHash } from "../lib/domain";
import { assertCapability } from "../lib/policy";
import { findPublicAgent } from "../lib/store";

let directory: string;
const originalDatabase = process.env.DATABASE_URL;
const originalDirectory = process.env.STUDIO_DATA_DIR;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "studio-core-"));
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
const input = {
  name: "Quequito",
  purpose: "Ayudar al grupo",
  instructions: "Responde breve y con claridad.",
};
async function create(ctx: Context, overrides = {}) {
  return (
    await executeCommand(ctx, {
      type: "agents.create",
      operationId: "create",
      input: { ...input, ...overrides },
    })
  ).agent as AgentSpec;
}
async function preview(
  ctx: Context,
  agent: AgentSpec,
  mode: "fixture" | "model" = "model",
) {
  return executeCommand(ctx, {
    type: "previews.record",
    agentId: agent.id,
    operationId: `preview-${agent.revision}-${mode}`,
    input: {
      revision: agent.revision,
      specHash: specHash(agent),
      passed: true,
      input: "Hola",
      output: "Hola!",
      model: agent.model,
      mode,
    },
  });
}
async function deploy(ctx: Context, agent: AgentSpec) {
  await preview(ctx, agent);
  return executeCommand(ctx, {
    type: "deployments.create",
    agentId: agent.id,
    expectedRevision: agent.revision,
    operationId: `deploy-${agent.revision}`,
  });
}

describe("transactional agent commands", () => {
  test("concurrent duplicate creates have one result and conflicting payloads fail", async () => {
    const ctx = context();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        executeCommand(ctx, {
          type: "agents.create",
          operationId: "same",
          input,
        }),
      ),
    );
    expect(new Set(results.map((result) => result.agent?.id)).size).toBe(1);
    expect(Object.keys((await getWorkspace(ctx)).agents)).toHaveLength(1);
    await expect(
      executeCommand(ctx, {
        type: "agents.create",
        operationId: "same",
        input: { ...input, name: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  test("partial edits preserve model, grants and budget; optimistic revisions reject a lost update", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      model: "custom/model",
      grants: {
        webReply: true,
        githubRead: true,
        githubWrite: true,
        whatsappSend: false,
      },
      githubRepo: "owner/repo",
      budget: { maxTokensPerRun: 5000, dailyRunLimit: 3 },
    });
    const changed = await executeCommand(ctx, {
      type: "agents.patch",
      operationId: "patch",
      agentId: agent.id,
      expectedRevision: 1,
      input: { name: "Nuevo" },
    });
    expect(changed.agent?.model).toBe("custom/model");
    expect(changed.agent?.grants.githubWrite).toBe(true);
    expect(changed.agent?.budget.dailyRunLimit).toBe(3);
    await expect(
      executeCommand(ctx, {
        type: "agents.patch",
        operationId: "lost",
        agentId: agent.id,
        expectedRevision: 1,
        input: { name: "Lost" },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  test("fixture previews cannot deploy and later edits require a new exact preview", async () => {
    const ctx = context();
    const agent = await create(ctx);
    await preview(ctx, agent, "fixture");
    await expect(
      executeCommand(ctx, {
        type: "deployments.create",
        operationId: "unverified",
        agentId: agent.id,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    await deploy(ctx, agent);
    const changed = (
      await executeCommand(ctx, {
        type: "agents.patch",
        operationId: "patch",
        agentId: agent.id,
        expectedRevision: 1,
        input: { instructions: "Other behavior" },
      })
    ).agent as AgentSpec;
    await expect(
      executeCommand(ctx, {
        type: "deployments.create",
        operationId: "stale",
        agentId: agent.id,
        expectedRevision: changed.revision,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
  });
  test("revocation survives rollback and public callers never inherit repo access", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      grants: {
        webReply: true,
        githubRead: true,
        githubWrite: true,
        whatsappSend: false,
      },
      githubRepo: "owner/repo",
    });
    const deployment = (await deploy(ctx, agent)).deployment;
    const state = await getWorkspace(ctx);
    expect(() =>
      assertCapability(state, {
        agentId: agent.id,
        capability: "githubRead",
        environment: "production",
        githubRepo: "owner/repo",
        requester: "public",
      }),
    ).toThrow("authenticated owner");
    await executeCommand(ctx, {
      type: "agents.patch",
      operationId: "revoke",
      agentId: agent.id,
      expectedRevision: 1,
      input: { grants: { githubWrite: false } },
    });
    await executeCommand(ctx, {
      type: "deployments.rollback",
      operationId: "rollback",
      agentId: agent.id,
      input: { deploymentId: deployment?.id },
    });
    expect(() =>
      assertCapability(state, {
        agentId: agent.id,
        capability: "githubRead",
        environment: "production",
        githubRepo: "other/repo",
        requester: "owner",
      }),
    ).toThrow();
    expect(() =>
      assertCapability(state, {
        agentId: agent.id,
        capability: "webReply",
        environment: "production",
      }),
    ).toThrow("destination");
    const revoked = await getWorkspace(ctx);
    expect(() =>
      assertCapability(revoked, {
        agentId: agent.id,
        capability: "githubWrite",
        environment: "production",
        githubRepo: "owner/repo",
        requester: "owner",
      }),
    ).toThrow("not granted");
  });
  test("workspace isolation and public lookup require actual deployment", async () => {
    const ctx = context();
    const agent = await create(ctx);
    expect(await findPublicAgent(agent.id)).toBeNull();
    expect(Object.keys((await getWorkspace(context())).agents)).toHaveLength(0);
    await deploy(ctx, agent);
    expect((await findPublicAgent(agent.id))?.ctx.workspaceId).toBe(
      ctx.workspaceId,
    );
  });
  test("public metadata stays on the deployed revision through draft edits and rollback", async () => {
    const ctx = context();
    const agent = await create(ctx);
    const original = (await deploy(ctx, agent)).deployment;
    const changed = (
      await executeCommand(ctx, {
        type: "agents.patch",
        operationId: "unpublished-metadata",
        agentId: agent.id,
        expectedRevision: 1,
        input: { name: "Private draft name", purpose: "Unpublished purpose" },
      })
    ).agent as AgentSpec;
    const beforePublish = await findPublicAgent(agent.id);
    expect(beforePublish?.agent.name).toBe(agent.name);
    expect(beforePublish?.agent.purpose).toBe(agent.purpose);
    expect(beforePublish?.agent.revision).toBe(1);
    expect(beforePublish?.agent.status).toBe("live");
    await deploy(ctx, changed);
    expect((await findPublicAgent(agent.id))?.agent.name).toBe(changed.name);
    await executeCommand(ctx, {
      type: "agents.pause",
      operationId: "pause-metadata",
      agentId: agent.id,
    });
    await executeCommand(ctx, {
      type: "deployments.rollback",
      operationId: "rollback-metadata",
      agentId: agent.id,
      input: { deploymentId: original?.id },
    });
    const afterRollback = await findPublicAgent(agent.id);
    expect(afterRollback?.agent.name).toBe(agent.name);
    expect(afterRollback?.agent.purpose).toBe(agent.purpose);
    expect(afterRollback?.agent.revision).toBe(1);
    expect(afterRollback?.agent.status).toBe("paused");
  });
  test("run budget is atomic and uncertain sends cannot be claimed again", async () => {
    const ctx = context();
    const agent = await create(ctx, {
      budget: { maxTokensPerRun: 1000, dailyRunLimit: 1 },
    });
    await deploy(ctx, agent);
    const outcomes = await Promise.allSettled(
      ["one", "two"].map((operationId) =>
        executeCommand(ctx, {
          type: "runs.create",
          operationId,
          agentId: agent.id,
          input: { sessionId: "public-session", channel: "web", input: "Hola" },
        }),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const run = (await getWorkspace(ctx)).runs[0];
    await executeCommand(ctx, {
      type: "runs.update",
      operationId: "claim",
      agentId: agent.id,
      input: { runId: run.id, status: "running" },
    });
    await executeCommand(ctx, {
      type: "runs.update",
      operationId: "unknown",
      agentId: agent.id,
      input: { runId: run.id, status: "uncertain" },
    });
    await expect(
      executeCommand(ctx, {
        type: "runs.update",
        operationId: "retry",
        agentId: agent.id,
        input: { runId: run.id, status: "running" },
      }),
    ).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
  });
});
