import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAllowedOwner, isLocalOwnerRequest } from "../lib/auth";

const original = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.LOCAL_OWNER_MODE = "true";
  delete process.env.VERCEL;
  delete process.env.CLERK_ALLOWED_USER_IDS;
});

afterEach(() => {
  for (const key of [
    "NODE_ENV",
    "LOCAL_OWNER_MODE",
    "VERCEL",
    "CLERK_ALLOWED_USER_IDS",
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
