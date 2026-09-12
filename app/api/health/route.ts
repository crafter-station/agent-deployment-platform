export function GET() {
  return Response.json({
    status: "ok",
    service: "quequito-studio",
    version: "0.1.0",
  });
}
