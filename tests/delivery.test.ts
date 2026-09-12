import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import {
  type DeliveryDependencies,
  drainDeliveries,
  enqueue,
} from "../lib/delivery";
import {
  type AgentRun,
  type AgentSpec,
  agentInputSchema,
  emptyWorkspace,
  specHash,
  type WorkspaceState,
} from "../lib/domain";
import { validSignature } from "../lib/sessions";

test("webhook signatures bind the exact UTF-8 bytes and reject malformed signatures", () => {
  const raw = '{"text":"mañana ☀️"}';
  const secret = "fixture-only-signing-key";
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  expect(validSignature(raw, `sha256=${signature}`, secret)).toBe(true);
  expect(validSignature(`${raw}\n`, signature, secret)).toBe(false);
  expect(validSignature(raw, signature.slice(1), secret)).toBe(false);
  expect(validSignature(raw, "g".repeat(64), secret)).toBe(false);
  expect(validSignature(raw, null, secret)).toBe(false);
  expect(validSignature(raw, signature, undefined)).toBe(false);
});

test("injected queue connections reject missing or public schema before issuing SQL", async () => {
  let queries = 0;
  const connection = (() => {
    queries++;
    throw new Error("No SQL should run");
  }) as unknown as ReturnType<typeof postgres>;
  await expect(
    enqueue("fixture", "whatsapp", {}, connection),
  ).rejects.toMatchObject({ code: "TEST_SCHEMA_REQUIRED" });
  await expect(
    enqueue("fixture", "whatsapp", {}, connection, "public"),
  ).rejects.toMatchObject({ code: "TEST_SCHEMA_REQUIRED" });
  await expect(drainDeliveries({ sql: connection })).rejects.toMatchObject({
    code: "TEST_SCHEMA_REQUIRED",
  });
  expect(queries).toBe(0);
});

describe.skipIf(process.env.STUDIO_DATABASE_TESTS !== "true")(
  "isolated Postgres delivery queue",
  () => {
    let admin: ReturnType<typeof postgres>;
    let sql: ReturnType<typeof postgres>;
    let table: postgres.Helper<string, []>;
    let productionBaseline: { id: string; fingerprint: string }[] = [];
    const namespace = `delivery_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const oldEnvironment = {
      phone: process.env.KAPSO_PHONE_ID,
      senders: process.env.KAPSO_ALLOWED_SENDERS,
      key: process.env.KAPSO_API_KEY,
    };
    const ctx = { workspaceId: "delivery-fixture", actorId: "public" };
    let state: WorkspaceState;
    let deps: DeliveryDependencies;
    let sends: number;
    let calls: number;
    let messages: unknown[];
    let ids: string[];
    const agentId = "ee85736a-b7ef-4ccc-a889-05d1c2b0cbaa";
    const payload = {
      agentId,
      sender: "fixture-sender",
      text: "Fixture input",
      phoneId: "fixture-phone",
    };

    beforeAll(async () => {
      if (!process.env.DATABASE_URL)
        throw new Error("DATABASE_URL required for isolated queue tests");
      admin = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
      const existingFixtures =
        await admin`SELECT count(*)::int AS count FROM public.studio_deliveries WHERE payload->>'agentId'=${agentId}`;
      if (existingFixtures[0].count !== 0)
        throw new Error(
          "Production contains test fixtures; stop and investigate before testing",
        );
      productionBaseline =
        await admin`SELECT id,md5(to_jsonb(d)::text) AS fingerprint FROM public.studio_deliveries d WHERE id LIKE 'wa:%' AND status='succeeded'`;
      await admin`CREATE SCHEMA ${admin(namespace)}`;
      sql = postgres(process.env.DATABASE_URL, {
        max: 4,
        prepare: false,
      });
      table = sql(`${namespace}.studio_deliveries`);
      process.env.KAPSO_PHONE_ID = payload.phoneId;
      process.env.KAPSO_ALLOWED_SENDERS = payload.sender;
      process.env.KAPSO_API_KEY = "fixture-not-a-real-provider-key";
      await enqueue("initialization", "whatsapp", payload, sql, namespace);
      const actual =
        await sql`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass(${`${namespace}.studio_deliveries`})`;
      expect(actual[0]?.schema).toBe(namespace);
    });
    afterAll(async () => {
      if (sql) await sql.end();
      if (admin) {
        await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;
        const after =
          await admin`SELECT id,md5(to_jsonb(d)::text) AS fingerprint FROM public.studio_deliveries d WHERE id=ANY(${productionBaseline.map((row) => row.id)})`;
        const fingerprints = new Map(
          after.map((row) => [row.id, row.fingerprint]),
        );
        for (const row of productionBaseline)
          expect(fingerprints.get(row.id)).toBe(row.fingerprint);
        const fixtures =
          await admin`SELECT count(*)::int AS count FROM public.studio_deliveries WHERE payload->>'agentId'=${agentId}`;
        expect(fixtures[0].count).toBe(0);
        await admin.end();
      }
      if (oldEnvironment.phone)
        process.env.KAPSO_PHONE_ID = oldEnvironment.phone;
      else delete process.env.KAPSO_PHONE_ID;
      if (oldEnvironment.senders)
        process.env.KAPSO_ALLOWED_SENDERS = oldEnvironment.senders;
      else delete process.env.KAPSO_ALLOWED_SENDERS;
      if (oldEnvironment.key) process.env.KAPSO_API_KEY = oldEnvironment.key;
      else delete process.env.KAPSO_API_KEY;
    });
    beforeEach(async () => {
      await sql`DELETE FROM ${table} WHERE payload->>'agentId'=${agentId} AND payload->>'sender'=${payload.sender} AND payload->>'phoneId'=${payload.phoneId}`;
      sends = 0;
      calls = 0;
      messages = [];
      ids = [];
      const now = new Date().toISOString();
      const agent: AgentSpec = {
        ...agentInputSchema.parse({
          name: "Queue fixture",
          purpose: "Test only",
          instructions: "Fixture",
          grants: {
            webReply: true,
            githubRead: false,
            githubWrite: false,
            whatsappSend: true,
          },
        }),
        id: agentId,
        revision: 1,
        status: "live",
        createdAt: now,
        updatedAt: now,
      };
      state = emptyWorkspace(ctx.workspaceId);
      state.agents[agentId] = agent;
      state.revisions[agentId] = [structuredClone(agent)];
      state.deployments = [
        {
          id: "deployment-fixture",
          agentId,
          revision: 1,
          specHash: specHash(agent),
          previewId: "preview-fixture",
          createdAt: now,
          active: true,
        },
      ];
      deps = {
        sql,
        schema: namespace,
        find: async (id) =>
          id === agentId ? { ctx, agent: structuredClone(agent) } : null,
        workspace: async () => state,
        transact: async (_ctx, change) => change(state),
        run: async (_ctx, input) => {
          calls++;
          ids.push(input.operationId);
          const run: AgentRun = {
            id: crypto.randomUUID(),
            agentId,
            deploymentId: "deployment-fixture",
            revision: 1,
            sessionId: input.sessionId,
            channel: "whatsapp",
            status: "succeeded",
            input: input.message,
            output: "Fixture reply",
            checkpoints: [],
            tokens: 10,
            operationId: input.operationId,
            createdAt: now,
            updatedAt: now,
          };
          state.runs.push(run);
          return { run, text: "Fixture reply", replayed: false };
        },
        send: async (_url, init) => {
          sends++;
          messages.push(JSON.parse(String(init?.body)));
          return Response.json({ messages: [{ id: "provider-fixture-id" }] });
        },
      };
    });

    test("durable ingress deduplicates and concurrent workers dispatch once", async () => {
      const inserts = await Promise.all(
        Array.from({ length: 4 }, () =>
          enqueue("duplicate", "whatsapp", payload, sql, namespace),
        ),
      );
      expect(inserts.filter(Boolean)).toHaveLength(1);
      await Promise.all(Array.from({ length: 4 }, () => drainDeliveries(deps)));
      expect(calls).toBe(1);
      expect(sends).toBe(1);
      expect(messages[0]).toMatchObject({
        to: payload.sender,
        text: { body: "Fixture reply" },
      });
      const [row] = await sql`SELECT * FROM ${table} WHERE id='duplicate'`;
      expect(row.status).toBe("succeeded");
      expect(row.result).toEqual({
        messageId: "provider-fixture-id",
        providerStatus: "accepted",
      });
      expect(row.attempts).toBe(1);
      expect(
        await enqueue("duplicate", "whatsapp", payload, sql, namespace),
      ).toBe(false);
    });

    test("timeout after dispatch is uncertain and never automatically sent again", async () => {
      await enqueue("unknown", "whatsapp", payload, sql, namespace);
      deps.send = async () => {
        sends++;
        throw new Error("provider timed out");
      };
      expect(await drainDeliveries(deps)).toEqual([
        { id: "unknown", status: "uncertain" },
      ]);
      expect(await drainDeliveries(deps)).toEqual([]);
      expect(sends).toBe(1);
      expect(calls).toBe(1);
    });

    test("a success response without provider receipt stays uncertain", async () => {
      await enqueue("missing-receipt", "whatsapp", payload, sql, namespace);
      deps.send = async () => {
        sends++;
        return Response.json({});
      };
      expect(await drainDeliveries(deps)).toEqual([
        { id: "missing-receipt", status: "uncertain" },
      ]);
      expect(sends).toBe(1);
      const [row] =
        await sql`SELECT result FROM ${table} WHERE id='missing-receipt'`;
      expect(row.result.code).toBe("RECEIPT_MISSING");
    });

    test("revocation after inference blocks the final send", async () => {
      await enqueue("revoked", "whatsapp", payload, sql, namespace);
      const originalRun = deps.run!;
      deps.run = async (...args) => {
        const result = await originalRun(...args);
        state.agents[agentId].grants.whatsappSend = false;
        return result;
      };
      expect(await drainDeliveries(deps)).toEqual([
        { id: "revoked", status: "failed" },
      ]);
      expect(calls).toBe(1);
      expect(sends).toBe(0);
    });

    test("failed inference and unsupported channels never report successful delivery", async () => {
      await enqueue("failed-run", "whatsapp", payload, sql, namespace);
      const originalRun = deps.run!;
      deps.run = async (...args) => {
        const result = await originalRun(...args);
        result.run.status = "failed";
        return result;
      };
      expect(await drainDeliveries(deps)).toEqual([
        { id: "failed-run", status: "failed" },
      ]);
      await sql`INSERT INTO ${table} (id,kind,payload) VALUES ('unsupported','github',${sql.json(payload)})`;
      expect(await drainDeliveries(deps)).toEqual([
        { id: "unsupported", status: "failed" },
      ]);
      expect(sends).toBe(0);
    });

    test("stale pre-send recovery marks interrupted inference and uses a new attempt", async () => {
      await enqueue("stale", "whatsapp", payload, sql, namespace);
      const originalRun = await deps.run!(ctx, {
        agentId,
        message: payload.text,
        environment: "whatsapp",
        sessionId: "fixture-session",
        operationId: "stale:attempt:1",
        requester: "public",
      });
      originalRun.run.status = "running";
      await sql`UPDATE ${table} SET status='running',attempts=1,updated_at=now()-interval '6 minutes' WHERE id='stale'`;
      expect(await drainDeliveries(deps)).toEqual([
        { id: "stale", status: "succeeded" },
      ]);
      expect(String(originalRun.run.status)).toBe("failed");
      expect(originalRun.run.error).toContain("DELIVERY_INTERRUPTED");
      expect(ids).toEqual(["stale:attempt:1", "stale:attempt:2"]);
      expect(sends).toBe(1);
      await enqueue("exhausted", "whatsapp", payload, sql, namespace);
      await sql`UPDATE ${table} SET status='running',attempts=3,updated_at=now()-interval '6 minutes' WHERE id='exhausted'`;
      expect(await drainDeliveries(deps)).toEqual([]);
      const [row] = await sql`SELECT status FROM ${table} WHERE id='exhausted'`;
      expect(row.status).toBe("failed");
      expect(sends).toBe(1);
    });

    test("expired sending is uncertain and loss of lease prevents stale dispatch", async () => {
      await enqueue("expired-send", "whatsapp", payload, sql, namespace);
      await sql`UPDATE ${table} SET status='sending',attempts=1,updated_at=now()-interval '6 minutes' WHERE id='expired-send'`;
      expect(await drainDeliveries(deps)).toEqual([]);
      const [expired] =
        await sql`SELECT status FROM ${table} WHERE id='expired-send'`;
      expect(expired.status).toBe("uncertain");
      await enqueue("lease-lost", "whatsapp", payload, sql, namespace);
      const originalRun = deps.run!;
      deps.run = async (...args) => {
        const result = await originalRun(...args);
        await sql`UPDATE ${table} SET attempts=2,status='queued' WHERE id='lease-lost'`;
        return result;
      };
      expect(await drainDeliveries(deps)).toEqual([
        { id: "lease-lost", status: "lease_lost" },
      ]);
      expect(sends).toBe(0);
      const [lost] =
        await sql`SELECT status,attempts FROM ${table} WHERE id='lease-lost'`;
      expect(lost).toMatchObject({ status: "queued", attempts: 2 });
    });
  },
);
