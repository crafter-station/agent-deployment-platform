import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAllowedOwner, isLocalOwnerRequest, ownerContext } from "../lib/auth";

const original = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.LOCAL_OWNER_MODE = "true";
  delete process.env.VERCEL;
  delete process.env.CLERK_ALLOWED_USER_IDS;
  delete process.env.STUDIO_WORKSPACE_ALIASES;
});

afterEach(() => {
  for (const key of [
    "NODE_ENV",
    "LOCAL_OWNER_MODE",
    "VERCEL",
    "CLERK_ALLOWED_USER_IDS",
    "STUDIO_WORKSPACE_ALIASES",
  ]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function local(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/commands", {
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}

describe("owner authentication boundaries", () => {
  test("verified owner identities share the existing workspace without merging actors", () => {
    process.env.CLERK_ALLOWED_USER_IDS = "user_primary,user_crafter";
    process.env.STUDIO_WORKSPACE_ALIASES = JSON.stringify({
      user_crafter: "user:user_primary",
      user_stranger: "user:user_primary",
    });
    expect(ownerContext("user_primary")).toEqual({
      workspaceId: "user:user_primary",
      actorId: "user_primary",
    });
    expect(ownerContext("user_crafter")).toEqual({
      workspaceId: "user:user_primary",
      actorId: "user_crafter",
    });
    expect(() => ownerContext("user_stranger")).toThrow(
      "does not have pilot access",
    );
    process.env.STUDIO_WORKSPACE_ALIASES = JSON.stringify({ user_crafter: "" });
    expect(() => ownerContext("user_crafter")).toThrow(
      "not configured correctly",
    );
  });
  test("local owner is explicitly development-only", () => {
    expect(isLocalOwnerRequest(local())).toBe(true);
    Object.assign(process.env, { NODE_ENV: "production" });
    expect(isLocalOwnerRequest(local())).toBe(false);
    Object.assign(process.env, { NODE_ENV: "development" });
    process.env.VERCEL = "1";
    expect(isLocalOwnerRequest(local())).toBe(false);
    delete process.env.VERCEL;
    delete process.env.LOCAL_OWNER_MODE;
    expect(isLocalOwnerRequest(local())).toBe(false);
  });

  test("remote host, origin, and forwarding headers cannot enter local workspace", () => {
    expect(
      isLocalOwnerRequest(
        new Request("https://studio.example/api/commands", {
          headers: { host: "studio.example" },
        }),
      ),
    ).toBe(false);
    const cases: Record<string, string>[] = [
      { host: "studio.example" },
      { origin: "https://attacker.example" },
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-host": "localhost" },
      { "x-forwarded-proto": "http" },
      { forwarded: "for=127.0.0.1" },
      { "x-real-ip": "127.0.0.1" },
    ];
    for (const headers of cases)
      expect(isLocalOwnerRequest(local(headers))).toBe(false);
    expect(isLocalOwnerRequest()).toBe(false);
  });

  test("optional pilot owner list matches complete verified user IDs", () => {
    expect(isAllowedOwner("user_any")).toBe(true);
    process.env.VERCEL = "1";
    expect(isAllowedOwner("user_any")).toBe(false);
    process.env.CLERK_ALLOWED_USER_IDS = "user_owner, user_second";
    expect(isAllowedOwner("user_owner")).toBe(true);
    expect(isAllowedOwner("user_second")).toBe(true);
    expect(isAllowedOwner("owner")).toBe(false);
    expect(isAllowedOwner("user_other")).toBe(false);
  });
});
