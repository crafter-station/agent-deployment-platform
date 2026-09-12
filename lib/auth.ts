import { auth } from "@clerk/nextjs/server";
import { type Context, DomainError } from "./domain";

export function isLocalOwnerRequest(request?: Request): boolean {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.LOCAL_OWNER_MODE !== "true" ||
    process.env.VERCEL ||
    !request
  )
    return false;

  for (const name of request.headers.keys()) {
    if (
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name === "x-real-ip"
    )
      return false;
  }

  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  const host = request.headers.get("host");
  if (!host || host !== url.host) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return true;
}

export function isAllowedOwner(userId: string): boolean {
  const owners = process.env.CLERK_ALLOWED_USER_IDS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!owners?.length) return !process.env.VERCEL;
  return owners.includes(userId);
}

export function ownerContext(userId: string): Context {
  if (!isAllowedOwner(userId))
    throw new DomainError(
      "forbidden",
      "This account does not have pilot access.",
      403,
    );
  let aliases: unknown;
  try {
    aliases = JSON.parse(process.env.STUDIO_WORKSPACE_ALIASES || "{}");
  } catch {
    throw new DomainError(
      "workspace_configuration",
      "Workspace access is not configured correctly.",
      503,
    );
  }
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases))
    throw new DomainError(
      "workspace_configuration",
      "Workspace access is not configured correctly.",
      503,
    );
  const mapped = Object.hasOwn(aliases, userId)
    ? (aliases as Record<string, unknown>)[userId]
    : `user:${userId}`;
  if (typeof mapped !== "string" || !/^user:user_[A-Za-z0-9]+$/.test(mapped))
    throw new DomainError(
      "workspace_configuration",
      "Workspace access is not configured correctly.",
      503,
    );
  return { workspaceId: mapped, actorId: userId };
}

export async function requireActor(request?: Request): Promise<Context> {
  if (isLocalOwnerRequest(request))
    return { workspaceId: "local-owner", actorId: "local-owner" };
  const { userId } = await auth();
  if (!userId)
    throw new DomainError(
      "unauthorized",
      "Sign in to access your workspace.",
      401,
    );
  return ownerContext(userId);
}
