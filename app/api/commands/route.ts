import { z } from "zod";
import { requireActor } from "@/lib/auth";
import { executeCommand } from "@/lib/commands";
import { checkOrigin, errorResponse, readBody } from "@/lib/http";

const schema = z
  .object({
    type: z.enum([
      "agents.create",
      "agents.patch",
      "agents.pause",
      "agents.resume",
      "deployments.create",
      "deployments.rollback",
    ]),
    operationId: z.string().min(8).max(200),
    agentId: z.string().optional(),
    expectedRevision: z.number().int().optional(),
    input: z.unknown().optional(),
  })
  .strict();
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const ctx = await requireActor(request);
    return Response.json(
      await executeCommand(ctx, schema.parse(await readBody(request))),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
