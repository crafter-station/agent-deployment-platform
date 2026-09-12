import { errorResponse } from "@/lib/http";
import { findPublicAgent } from "@/lib/store";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const result = await findPublicAgent((await params).agentId);
    return result
      ? Response.json({
          id: result.agent.id,
          name: result.agent.name,
          purpose: result.agent.purpose,
          status: result.agent.status,
        })
      : Response.json({ error: "Agente no publicado." }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
