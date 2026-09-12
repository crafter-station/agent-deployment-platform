import { drainDeliveries } from "@/lib/delivery";
import { errorResponse } from "@/lib/http";
export const maxDuration = 120;
export async function GET(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  )
    return new Response(null, { status: 401 });
  try {
    return Response.json({ processed: await drainDeliveries() });
  } catch (error) {
    return errorResponse(error);
  }
}
