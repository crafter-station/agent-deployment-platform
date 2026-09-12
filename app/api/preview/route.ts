import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { checkOrigin, errorResponse, readBody } from "@/lib/http";
import { runAgent } from "@/lib/runtime";

export const maxDuration = 120;
const schema = z.object({
  agentId: z.string(),
  message: z.string().min(1).max(16000),
  sessionId: z.string().min(1).max(100),
  operationId: z.string().min(8).max(100),
});
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const ctx = await requireActor(request);
    return Response.json(
      await runAgent(ctx, {
        ...schema.parse(await readBody(request)),
        environment: "preview",
        requester: "owner",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
