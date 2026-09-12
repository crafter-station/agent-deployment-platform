# Pilot verification

Verified 2026-09-12. Initial source commit: `3e4af0d9429cf5001194a77dcf25b360bd1051cf`. Subsequent evidence and queue-test isolation correction are recorded in Git history.

## Live deployment

- Studio: https://quequito-studio.vercel.app
- Published agent: https://quequito-studio.vercel.app/a/bb0330f6-574d-434a-a4bb-f2e7ce9c7900
- GitHub main push automatically produced a READY production deployment. GitHub Verify workflow passed.
- Production health200, public agent metadata200, anonymous workspace401, unsigned Kapso webhook401.
- Real Clerk owner session accessed the deployed workspace with200. Hosted allowlist is owner-only. Authentication is a controlled Clerk development-instance pilot.

## Actual model and browser behavior

1. Owner created Quequito through conversation in a real browser. Model tools persisted the agent.
2. Owner changed personality by conversation to three sentences without emojis.
3. A real preview answered an unknown-date question without inventing a date.
4. The same revision was published. Later purpose edit, preview and publication completed successfully as revision4.
5. A fresh anonymous browser sent a message on the production web page and received a real model response respecting the tested behavior.
6. Reload preserved agent, revisions and history.

An earlier operator request completed its three actions but exceeded the final narration budget. The record is preserved honestly. The fix ends the loop after a successful deployment receipt and returns its confirmed revision. A later real request verified that corrected path.

## WhatsApp pilot

The existing Meta/Kapso number was reused without unlinking Meta. One active webhook routes to the new runtime; the duplicate registration is inactive. Kai WhatsApp is disabled while its Telegram route and shared service remain running.

The owner sent a real inbound message on 2026-09-12. Ingress persisted at20:20:42 UTC; one delivery attempt completed at20:20:45. Provider GET confirmed outbound status `delivered` at20:20:46. Model run succeeded using1789 reported tokens. Private message identifiers are excluded from this report.

A correctly signed webhook with a disallowed sender returned200 accepted:false. A bad signature returned401. The test payload was not queued. Pilot senders are explicitly allowlisted.

Telegram verification after cutover: getWebhookInfo ok, original /webhook/telegram URL, zero pending updates, no reported error. No unsolicited test notifications were sent.

## Automated checks

- TypeScript passes.
- 30 standard tests pass; live database delivery tests are opt-in.
- 9 delivery verification cases against Neon use mocked model/provider calls, with explicit isolated table identifiers after correction of a pooled search_path assumption.
- Biome check passes with CSS specificity warnings about distinct class selectors.
- Next production build passes. Dynamic local-store tracing warnings remain; .vercelignore and output tracing exclusions omit secret files, evidence, scripts and tests. Traced output was checked for secret paths.
- Production studio axe: zero violations and zero incomplete. Production public mobile: zero violations, one incomplete requiring human contrast judgement. Local studio desktop/mobile: zero violations and zero incomplete.

A final DB audit found two synthetic test rows because the pooler ignored a startup search_path. They were removed by exact fixture identity; the real WhatsApp receipt was unchanged. The test harness now uses schema-qualified identifiers and no TRUNCATE. This correction must be included before rerunning database tests.

## Boundaries

The first live channel pilot is DM and web, not an ordinary pre-existing WhatsApp group. Mother/group onboarding is not complete. GitHub source deployment and owner-scoped public repository reads are available; agent-owned GitHub App identity, GitHub writes/events, own inbox, scheduled agent tasks and billing remain subsequent slices. A successful preview is not comprehensive behavioral evaluation. Token limits are soft metering thresholds, not exact billing ceilings.
