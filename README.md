# Quequito Studio

Create, edit, test and deploy an agent by conversation. An original, open source agent studio built with Next.js, Bun, Clerk, Neon and Vercel AI SDK.

The platform operator manages your agents. Deployed agents receive only their own instructions, conversation memory and explicitly enabled capabilities. Every publication points to a real model preview of that exact revision.

## Start

```sh
bun install
cp .env.example .env.local
bun run dev
```

Configure Clerk and AI Gateway. Add a Neon connection string for persistent hosting. Development can use a local file store; production refuses to start storage without Postgres. Local owner mode is opt-in, loopback-only and unavailable on Vercel.

## Deploy

[Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcrafter-station%2Fagent-deployment-platform&env=DATABASE_URL,AI_GATEWAY_API_KEY,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,CLERK_SECRET_KEY,PUBLIC_SESSION_SECRET,CRON_SECRET&project-name=quequito-studio&repository-name=quequito-studio)

The button creates a deployment and asks for provider credentials. It does not provision accounts silently. With credentials connected, publishing an individual agent is one action inside the studio. Vercel cron every minute needs a plan that supports that frequency. Self-hosters must call the authenticated drain endpoint on a regular schedule.

## Workflow

1. Describe the agent in Studio. The operator calls the real command service.
2. Edit its personality, repository and grants in the same versioned document.
3. Send a test message in Probar. A successful model run records the exact revision hash.
4. Publish. Share `/a/<agentId>` or embed that page in an iframe.
5. Inspect real activity, pause, or return to an earlier deployment. Current permission revocations still apply to old versions.

Preview is execution evidence, not a guarantee of all future behavior. Test representative and adversarial prompts before broader use.

## Integrations

- **Web:** published chat, signed per-browser conversation sessions, bounded agent budgets.
- **GitHub:** owner previews can read the exact public repository assigned to an agent. Public visitors cannot inherit this access. Source repository pushes can deploy through Vercel Git integration. Private repositories, agent-owned GitHub App identity and GitHub writes are not connected in this version.
- **WhatsApp:** Kapso adapter with signed ingress, explicit phone/sender allowlist, durable deduplication and delivery state. Inference completion is distinct from provider acceptance. Unknown delivery outcomes are never automatically resent.
- **Email:** no inbox is provisioned in this version.

The current WhatsApp pilot is direct messages to a dedicated existing Meta/Kapso number. This does not enable an ordinary existing WhatsApp group. Official Groups API eligibility and group access are separate from phone connectivity.

## Developer API

All owner endpoints require a verified Clerk session and derive actor/workspace from it. Browser and conversational controls share `executeCommand`.

- `GET /api/workspace`
- `POST /api/operator`: `{messages:[{role:"user",content:"Create an agent..."}],selectedAgentId?}`
- `POST /api/commands`: `{type,operationId,agentId?,expectedRevision?,input?}`
- `POST /api/preview`: `{agentId,message,sessionId,operationId}`
- `GET /api/connections`
- `GET /api/public/agents/:id`
- `POST /api/public/chat`: `{agentId,message,operationId}`; use the returned session cookie.
- `POST /api/webhooks/kapso`: provider signature required.
- `GET /api/cron/drain`: `Authorization: Bearer <CRON_SECRET>`.

Public command types: `agents.create`, `agents.patch`, `agents.pause`, `agents.resume`, `deployments.create`, `deployments.rollback`. Internal preview and run mutation commands cannot be invoked through the owner command endpoint. Reusing an operation ID with a different payload returns a conflict. Editors pass `expectedRevision`.

## Operational scope

Neon serializes each workspace transaction. Provider inbox entries persist before acknowledgement; `after()` starts processing and cron drains queued work. A crashed in-flight delivery becomes uncertain for manual diagnosis. No exactly-once delivery claim.

Run budgets limit requests and model steps. Token metering can detect an in-flight overshoot only after the provider returns, so it is not a hard monetary ceiling. Logs, conversation history and memory reside in the workspace database. Delivery payload content is cleared after seven days while deduplication identifiers are retained. Workspace deletion, configurable retention, billing, scheduled agent tasks and multi-organization administration remain product work.

Clerk development instances are suitable for a controlled pilot. A production launch needs a production Clerk instance/domain and the appropriate access policy. `CLERK_ALLOWED_USER_IDS` limits a deployment to known pilot owners.

## Verify

```sh
bun test
bun run typecheck
bun run check
bun run build
```

`evidence/` records verification on this build. Local credentials and sign-in tickets are gitignored. The Kai cutover helpers are operator tools for this pilot; they default to inspection and preserve Telegram.

## Reference architecture

WAPI and Jibaru/wspbot informed the research. This implementation does not vendor their source. Original code is MIT licensed. See the product shaping notes in Hunter's Brain for the broader roadmap.
