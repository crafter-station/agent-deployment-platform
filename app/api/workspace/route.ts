import { requireActor } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getWorkspace } from "@/lib/store";

export async function GET(request: Request) {
  try {
    const state = await getWorkspace(await requireActor(request));
    const { operations: _operations, ...view } = state;
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
