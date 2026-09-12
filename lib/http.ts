import { ZodError } from "zod";
import { DomainError } from "./domain";

export function errorResponse(error: unknown) {
  if (error instanceof DomainError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return Response.json(
      { error: "Revisa los datos enviados.", code: "VALIDATION" },
      { status: 400 },
    );
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : 500;
  return Response.json(
    {
      error:
        status === 401
          ? "Inicia sesión para continuar."
          : status === 403
            ? "No tienes acceso a esta acción."
            : "No se pudo completar. Tu última revisión sigue guardada.",
      code: "REQUEST_FAILED",
    },
    { status: [401, 403].includes(status) ? status : 500 },
  );
}
export async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 64000)
    throw new DomainError("TOO_LARGE", "Solicitud demasiado grande.", 413);
  const text = await request.text();
  if (text.length > 64000)
    throw new DomainError("TOO_LARGE", "Solicitud demasiado grande.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("INVALID_JSON", "JSON inválido.");
  }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new DomainError("ORIGIN_DENIED", "Origen no permitido.", 403);
}
