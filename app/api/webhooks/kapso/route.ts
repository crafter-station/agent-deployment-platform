import { after } from "next/server";
import { z } from "zod";
import { allowedSenders, drainDeliveries, enqueue } from "@/lib/delivery";
import { errorResponse } from "@/lib/http";
import { validSignature } from "@/lib/sessions";

export const maxDuration = 120;
const schema = z.object({
  phone_number_id: z.union([z.string(), z.number()]),
  message: z.object({
    id: z.string().min(1).max(200),
    from: z.string().max(30).optional(),
    kapso: z.object({ direction: z.enum(["inbound", "outbound"]) }),
    text: z.object({ body: z.string().max(8000) }).optional(),
  }),
  conversation: z.object({ phone_number: z.string().optional() }).optional(),
});
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 64000) return new Response(null, { status: 413 });
    if (
      !validSignature(
        raw,
        request.headers.get("X-Webhook-Signature"),
        process.env.KAPSO_WEBHOOK_SECRET,
      )
    )
      return new Response(null, { status: 401 });
    if (request.headers.get("X-Webhook-Event") !== "whatsapp.message.received")
      return Response.json({ accepted: false });
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) return Response.json({ accepted: false });
    const data = parsed.data;
    const sender = data.message.from ?? data.conversation?.phone_number;
    if (
      String(data.phone_number_id) !== process.env.KAPSO_PHONE_ID ||
      !sender ||
      !allowedSenders().includes(sender) ||
      data.message.kapso.direction !== "inbound" ||
      !data.message.text?.body
    )
      return Response.json({ accepted: false });
    if (!process.env.KAPSO_AGENT_ID) return new Response(null, { status: 503 });
    const id = `wa:${data.phone_number_id}:${data.message.id}`;
    const created = await enqueue(id, "whatsapp", {
      agentId: process.env.KAPSO_AGENT_ID,
      sender,
      text: data.message.text.body,
      phoneId: String(data.phone_number_id),
    });
    after(async () => {
      await drainDeliveries();
    });
    return Response.json({ accepted: true, duplicate: !created });
  } catch (error) {
    return errorResponse(error);
  }
}
