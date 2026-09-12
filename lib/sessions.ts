import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DomainError } from "./domain";

export function validSignature(
  raw: string,
  signature: string | null,
  secret: string | undefined,
) {
  if (!secret || !signature) return false;
  const supplied = signature.replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}
export function publicSession(request: Request) {
  const secret = process.env.PUBLIC_SESSION_SECRET;
  if (!secret)
    throw new DomainError(
      "SESSION_UNAVAILABLE",
      "La sesión no está configurada.",
      503,
    );
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("studio_session="))
    ?.split("=")[1];
  const [id, signature] = token?.split(".") ?? [];
  if (id && /^[a-f0-9-]{36}$/.test(id) && validSignature(id, signature, secret))
    return { id, cookie: null };
  const next = randomUUID();
  const sig = createHmac("sha256", secret).update(next).digest("hex");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id: next,
    cookie: `studio_session=${next}.${sig}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`,
  };
}
