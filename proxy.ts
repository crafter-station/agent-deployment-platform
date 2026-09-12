import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";
import { isAllowedOwner, isLocalOwnerRequest } from "./lib/auth";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/access",
  "/a/:id",
  "/api/public/(.*)",
  "/api/webhooks/(.*)",
  "/api/health",
  "/api/cron/drain",
]);

const authenticate = clerkMiddleware(async (session, request) => {
  if (isPublicRoute(request) || isLocalOwnerRequest(request))
    return NextResponse.next();
  const { userId } = await session();
  if (!userId) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error: {
            code: "unauthorized",
            message: "Sign in to access your workspace.",
          },
        },
        { status: 401 },
      );
    }
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("redirect_url", request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }
  if (!isAllowedOwner(userId)) {
    if (!request.nextUrl.pathname.startsWith("/api/"))
      return NextResponse.redirect(new URL("/access", request.url));
    return NextResponse.json(
      {
        error: {
          code: "forbidden",
          message: "This workspace is limited to the pilot owners.",
        },
      },
      { status: 403 },
    );
  }
  return NextResponse.next();
});

export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const path = request.nextUrl.pathname;
  if (
    path.startsWith("/api/public/") ||
    path.startsWith("/api/webhooks/") ||
    path === "/api/health" ||
    path === "/api/cron/drain"
  )
    return NextResponse.next();
  const response = await authenticate(request, event);
  if (response?.headers.get("x-middleware-rewrite") === request.url) {
    response.headers.delete("x-middleware-rewrite");
    response.headers.set("x-middleware-next", "1");
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
