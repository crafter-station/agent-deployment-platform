import postgres from "postgres";
import { type Context, DomainError, type WorkspaceState } from "./domain";
import { assertCapability } from "./policy";
import { runAgent } from "./runtime";
import { findPublicAgent, getWorkspace, transactWorkspace } from "./store";

type DeliveryPayload = {
  agentId: string;
  sender: string;
  text: string;
  phoneId: string;
};
type DeliveryRow = {
  id: string;
  kind: string;
  payload: DeliveryPayload;
  status: string;
  attempts: number;
};
export type DeliveryDependencies = {
  sql?: ReturnType<typeof postgres>;
  schema?: string;
  run?: typeof runAgent;
  find?: typeof findPublicAgent;
  workspace?: typeof getWorkspace;
  transact?: <T>(
    ctx: Context,
    change: (state: WorkspaceState) => T | Promise<T>,
  ) => Promise<T>;
  send?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
};

let db: ReturnType<typeof postgres> | undefined;
const initializations = new WeakMap<
  ReturnType<typeof postgres>,
  Promise<unknown>
>();
async function database(
  provided?: ReturnType<typeof postgres>,
  schema?: string,
) {
  if (provided && (!schema || !/^delivery_test_[a-f0-9]{32}$/.test(schema)))
    throw new DomainError(
      "TEST_SCHEMA_REQUIRED",
      "Injected delivery SQL requires an explicit isolated test schema.",
    );
  if (!provided && schema)
    throw new DomainError(
      "TEST_CONNECTION_REQUIRED",
      "A schema override requires an isolated SQL connection.",
    );
  if (!provided && !process.env.DATABASE_URL)
    throw new DomainError(
      "DATABASE_REQUIRED",
      "El receptor necesita una base de datos.",
      503,
    );
  if (!provided && !db)
    db = postgres(process.env.DATABASE_URL as string, {
      max: 2,
      prepare: false,
      idle_timeout: 20,
    });
  const sql = provided ?? (db as ReturnType<typeof postgres>);
  const table = sql(`${schema ?? "public"}.studio_deliveries`);
  let ready = initializations.get(sql);
  if (!ready) {
    ready =
      sql`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, result jsonb, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now())`.then(
        () => undefined,
      );
    initializations.set(sql, ready);
  }
  await ready;
  return { sql, table };
}

export async function enqueue(
  id: string,
  kind: "whatsapp",
  payload: Record<string, unknown>,
  provided?: ReturnType<typeof postgres>,
  schema?: string,
) {
  if (kind !== "whatsapp")
    throw new DomainError("CHANNEL_UNSUPPORTED", "Canal no implementado.");
  const { sql, table } = await database(provided, schema);
  const result =
    await sql`INSERT INTO ${table} (id,kind,payload) VALUES (${id},${kind},${sql.json(payload as postgres.JSONValue)}) ON CONFLICT (id) DO NOTHING RETURNING id`;
  return result.length > 0;
}

async function markInterrupted(
  row: DeliveryRow,
  dependencies: DeliveryDependencies,
) {
  const bound = await (dependencies.find ?? findPublicAgent)(
    row.payload.agentId,
  );
  if (!bound) return;
  const ctx = { ...bound.ctx, actorId: `whatsapp:${row.payload.sender}` };
  await (dependencies.transact ?? transactWorkspace)(ctx, (state) => {
    const run = state.runs.find(
      (item) =>
        item.agentId === row.payload.agentId &&
        item.operationId === `${row.id}:attempt:${row.attempts}` &&
        (item.status === "running" || item.status === "queued"),
    );
    if (!run) return;
    run.status = "failed";
    run.error =
      "DELIVERY_INTERRUPTED: The pre-send invocation expired; no provider dispatch was recorded.";
    run.updatedAt = new Date().toISOString();
    run.checkpoints.push({
      name: "delivery.interrupted.before-send",
      at: run.updatedAt,
    });
  });
}

export async function drainDeliveries(dependencies: DeliveryDependencies = {}) {
  const { sql, table } = await database(dependencies.sql, dependencies.schema);
  await sql`UPDATE ${table} SET status='uncertain',updated_at=now() WHERE status='sending' AND updated_at < now() - interval '5 minutes'`;
  const interrupted =
    await sql`UPDATE ${table} SET status=CASE WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,updated_at=now() WHERE status='running' AND updated_at < now() - interval '5 minutes' RETURNING *`;
  for (const row of interrupted)
    await markInterrupted(row as DeliveryRow, dependencies);
  const rows =
    await sql`UPDATE ${table} SET status='running',attempts=attempts+1,updated_at=now() WHERE id IN (SELECT id FROM ${table} WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
  const outcomes: { id: string; status: string }[] = [];
  for (const row of rows) {
    let dispatchStarted = false;
    try {
      if (row.kind !== "whatsapp")
        throw new DomainError("CHANNEL_UNSUPPORTED", "Canal no implementado.");
      const payload = row.payload as DeliveryPayload;
      const bound = await (dependencies.find ?? findPublicAgent)(
        payload.agentId,
      );
      if (
        !bound ||
        payload.phoneId !== process.env.KAPSO_PHONE_ID ||
        !allowedSenders().includes(payload.sender)
      )
        throw new DomainError(
          "DESTINATION_DENIED",
          "Destino no permitido.",
          403,
        );
      const ctx = { ...bound.ctx, actorId: `whatsapp:${payload.sender}` };
      const sessionId = `whatsapp:${payload.phoneId}:${payload.sender}`;
      const result = await (dependencies.run ?? runAgent)(ctx, {
        agentId: payload.agentId,
        message: payload.text,
        sessionId,
        environment: "whatsapp",
        requester: "public",
        operationId: `${row.id}:attempt:${row.attempts}`,
      });
      if (result.run.status !== "succeeded" || !result.text.trim())
        throw new DomainError(
          "RUN_NOT_COMPLETE",
          "La ejecución no produjo una respuesta entregable.",
          409,
        );
      assertCapability(await (dependencies.workspace ?? getWorkspace)(ctx), {
        agentId: payload.agentId,
        capability: "whatsappSend",
        environment: "production",
        sessionId,
        requester: "public",
        deploymentId: result.run.deploymentId,
      });
      if (!process.env.KAPSO_API_KEY)
        throw new DomainError(
          "CONNECTION_REQUIRED",
          "Falta conexión Kapso.",
          503,
        );
      const dispatch =
        await sql`UPDATE ${table} SET status='sending',updated_at=now() WHERE id=${row.id} AND status='running' AND attempts=${row.attempts} RETURNING id`;
      if (!dispatch.length)
        throw new DomainError(
          "LEASE_LOST",
          "La ejecución perdió su turno de entrega.",
          409,
        );
      dispatchStarted = true;
      const response = await (dependencies.send ?? fetch)(
        `https://api.kapso.ai/meta/whatsapp/v24.0/${payload.phoneId}/messages`,
        {
          method: "POST",
          headers: {
            "X-API-Key": process.env.KAPSO_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: payload.sender,
            type: "text",
            text: { body: result.text.slice(0, 4000) },
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) {
        const status = response.status >= 500 ? "uncertain" : "failed";
        await sql`UPDATE ${table} SET status=${status},result=${sql.json({ httpStatus: response.status })},updated_at=now() WHERE id=${row.id} AND attempts=${row.attempts}`;
        outcomes.push({ id: row.id, status });
        continue;
      }
      const receipt = await response.json();
      const messageId = receipt.messages?.[0]?.id;
      if (typeof messageId !== "string" || !messageId)
        throw new DomainError(
          "RECEIPT_MISSING",
          "El proveedor no devolvió un identificador de aceptación.",
          502,
        );
      await sql`UPDATE ${table} SET status='succeeded',result=${sql.json({ messageId, providerStatus: "accepted" })},updated_at=now() WHERE id=${row.id} AND attempts=${row.attempts}`;
      outcomes.push({ id: row.id, status: "succeeded" });
    } catch (error) {
      const status = dispatchStarted ? "uncertain" : "failed";
      const saved =
        await sql`UPDATE ${table} SET status=${status},result=${sql.json({ code: error instanceof DomainError ? error.code : "PROCESSING_FAILED" })},updated_at=now() WHERE id=${row.id} AND attempts=${row.attempts} AND status IN ('running','sending') RETURNING id`;
      outcomes.push({
        id: row.id,
        status: saved.length ? status : "lease_lost",
      });
    }
  }
  await sql`UPDATE ${table} SET payload='{}'::jsonb WHERE created_at < now() - interval '7 days' AND status IN ('succeeded','failed') AND payload <> '{}'::jsonb`;
  return outcomes;
}

export function allowedSenders() {
  return (process.env.KAPSO_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
