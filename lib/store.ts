import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  type AgentSpec,
  type Context,
  DomainError,
  emptyWorkspace,
  type WorkspaceState,
} from "./domain";

let database: ReturnType<typeof postgres> | undefined;
let initialized: Promise<void> | undefined;

function validateContext(ctx: Context) {
  if (
    !ctx.workspaceId ||
    !ctx.actorId ||
    ctx.workspaceId.length > 200 ||
    ctx.actorId.length > 200
  )
    throw new DomainError(
      "UNAUTHENTICATED",
      "Authenticated workspace and actor required",
      401,
    );
}

async function connection() {
  if (!process.env.DATABASE_URL) return undefined;
  database ??= postgres(process.env.DATABASE_URL, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
  });
  initialized ??=
    database`CREATE TABLE IF NOT EXISTS studio_workspaces (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.then(
      () => undefined,
    );
  await initialized;
  return database;
}

function localPath(workspaceId: string) {
  if (process.env.VERCEL || process.env.NODE_ENV === "production")
    throw new DomainError(
      "DATABASE_REQUIRED",
      "Set DATABASE_URL for persistent production storage",
      503,
    );
  const directory =
    process.env.STUDIO_DATA_DIR || join(process.cwd(), ".studio-data");
  return {
    directory,
    path: join(
      directory,
      `${createHash("sha256").update(workspaceId).digest("hex")}.json`,
    ),
  };
}

export async function transactWorkspace<T>(
  ctx: Context,
  change: (state: WorkspaceState) => T | Promise<T>,
): Promise<T> {
  validateContext(ctx);
  const sql = await connection();
  if (sql) {
    return (await sql.begin(async (tx) => {
      await tx`INSERT INTO studio_workspaces (id, state) VALUES (${ctx.workspaceId}, ${tx.json(JSON.parse(JSON.stringify(emptyWorkspace(ctx.workspaceId))))}) ON CONFLICT (id) DO NOTHING`;
      const rows =
        await tx`SELECT state FROM studio_workspaces WHERE id = ${ctx.workspaceId} FOR UPDATE`;
      const state = rows[0].state as WorkspaceState;
      const result = await change(state);
      await tx`UPDATE studio_workspaces SET state = ${tx.json(JSON.parse(JSON.stringify(state)))}, updated_at = now() WHERE id = ${ctx.workspaceId}`;
      return result;
    })) as T;
  }
  if (process.env.NODE_ENV === "production")
    throw new DomainError(
      "DATABASE_REQUIRED",
      "Set DATABASE_URL for persistent production storage",
      503,
    );
  const { directory, path } = localPath(ctx.workspaceId);
  await mkdir(directory, { recursive: true });
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      lock = await open(`${path}.lock`, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!lock)
    throw new DomainError(
      "STORE_BUSY",
      "Workspace is busy; retry the same operation ID",
      409,
    );
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let state = emptyWorkspace(ctx.workspaceId);
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = await change(state);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return result;
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function getWorkspace(ctx: Context): Promise<WorkspaceState> {
  return transactWorkspace(ctx, (state) => structuredClone(state));
}

export async function findPublicAgent(
  agentId: string,
): Promise<{ ctx: Context; agent: AgentSpec } | null> {
  if (!/^[a-f0-9-]{36}$/.test(agentId)) return null;
  const sql = await connection();
  let workspaces: WorkspaceState[];
  if (sql) {
    const rows =
      await sql`SELECT state FROM studio_workspaces WHERE state->'agents' ? ${agentId} LIMIT 1`;
    workspaces = rows.map((row) => row.state as WorkspaceState);
  } else {
    if (process.env.NODE_ENV === "production")
      throw new DomainError(
        "DATABASE_REQUIRED",
        "Set DATABASE_URL for persistent production storage",
        503,
      );
    const { directory } = localPath("lookup");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    workspaces = await Promise.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map(
          async (file) =>
            JSON.parse(
              await readFile(join(directory, file), "utf8"),
            ) as WorkspaceState,
        ),
    );
  }
  for (const state of workspaces) {
    const agent = state.agents[agentId];
    const deployment = state.deployments.find(
      (item) => item.agentId === agentId && item.active,
    );
    const snapshot =
      deployment &&
      state.revisions[agentId]?.find(
        (item) => item.revision === deployment.revision,
      );
    if (
      agent &&
      (agent.status === "live" || agent.status === "paused") &&
      snapshot
    )
      return {
        ctx: { workspaceId: state.workspaceId, actorId: "public" },
        agent: { ...structuredClone(snapshot), status: agent.status },
      };
  }
  return null;
}
