import { requireActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
export async function GET(request: Request) {
  try {
    await requireActor(request);
    let whatsapp = { configured: false, status: "Sin conectar", number: "" };
    if (process.env.KAPSO_API_KEY && process.env.KAPSO_PHONE_ID) {
      try {
        const response = await fetch(
          `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${process.env.KAPSO_PHONE_ID}`,
          {
            headers: { "X-API-Key": process.env.KAPSO_API_KEY },
            signal: AbortSignal.timeout(8000),
          },
        );
        const data = response.ok ? await response.json() : null;
        const phone = data?.data ?? data?.whatsapp_phone_number ?? data;
        const hooksResponse = await fetch(
          `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${process.env.KAPSO_PHONE_ID}/webhooks`,
          {
            headers: { "X-API-Key": process.env.KAPSO_API_KEY },
            signal: AbortSignal.timeout(8000),
          },
        );
        const hooks = hooksResponse.ok ? (await hooksResponse.json()).data : [];
        const base =
          process.env.APP_URL ??
          (process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : new URL(request.url).origin);
        const active = Array.isArray(hooks)
          ? hooks.filter((item: { active: boolean }) => item.active)
          : [];
        const routed =
          active.length === 1 &&
          active[0].url === `${base}/api/webhooks/kapso` &&
          Boolean(process.env.KAPSO_AGENT_ID);
        const connected = response.ok && phone?.status === "CONNECTED";
        whatsapp = {
          configured: connected && routed,
          status: connected
            ? routed
              ? "Conectado · DM piloto"
              : "Número disponible · conexión pendiente"
            : "No se pudo verificar",
          number: phone?.display_phone_number_normalized
            ? `•••• ${String(phone.display_phone_number_normalized).slice(-4)}`
            : "",
        };
      } catch {
        whatsapp = {
          configured: false,
          status: "Proveedor no disponible",
          number: "",
        };
      }
    }
    return Response.json(
      {
        model: {
          configured: Boolean(process.env.AI_GATEWAY_API_KEY),
          status: process.env.AI_GATEWAY_API_KEY
            ? "AI Gateway conectado"
            : "Falta API key",
        },
        github: {
          configured: true,
          status: "Lectura de repositorios públicos",
          account: "GitHub App: identidad propia pendiente",
        },
        whatsapp,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
