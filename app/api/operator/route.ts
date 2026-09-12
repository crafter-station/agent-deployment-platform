import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { checkOrigin, errorResponse, readBody } from "@/lib/http";
import { operator } from "@/lib/operator";

export const maxDuration = 120;
const schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(16000),
      }),
    )
    .min(1)
    .max(40),
  selectedAgentId: z.string().optional(),
  operationId: z.string().min(8).max(200).optional(),
});
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const ctx = await requireActor(request);
    return Response.json(
      await operator(ctx, schema.parse(await readBody(request))),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
