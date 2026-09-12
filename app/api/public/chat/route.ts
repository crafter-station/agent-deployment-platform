import { z } from "zod";
import { DomainError } from "@/lib/domain";
import { checkOrigin, errorResponse, readBody } from "@/lib/http";
import { runAgent } from "@/lib/runtime";
import { publicSession } from "@/lib/sessions";
import { findPublicAgent } from "@/lib/store";

export const maxDuration = 120;
const schema = z.object({
  agentId: z.string().uuid(),
  message: z.string().min(1).max(8000),
  operationId: z.string().min(8).max(100),
});
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const input = schema.parse(await readBody(request));
    const bound = await findPublicAgent(input.agentId);
    if (!bound)
      throw new DomainError("NOT_FOUND", "Este agente no está publicado.", 404);
    const session = publicSession(request);
    const result = await runAgent(
      { ...bound.ctx, actorId: `public:${session.id}` },
      {
        ...input,
        sessionId: session.id,
        environment: "web",
        requester: "public",
      },
    );
    return Response.json(
      { text: result.text, runId: result.run.id, replayed: result.replayed },
      { headers: session.cookie ? { "Set-Cookie": session.cookie } : {} },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
