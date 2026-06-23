# Testing — dynamic mailbox support

Two layers, by design.

## Layer A — hermetic unit tests (gate every commit / PR)

Fast, deterministic, no Cloudflare bindings or network.

```bash
npm test
```

Covers the dynamic allow logic (`workers/lib/allowlist.ts`) used by both the
mailbox-create gate and the inbound-receive gate:
- address under a configured `DOMAINS` is allowed (dynamic self-service, no redeploy)
- explicit `EMAIL_ADDRESSES` entries still allowed (backwards-compatible)
- case-insensitive on address, allowlist, and domain
- rejects unconfigured domains; rejects when nothing is configured

> Fast-follow: a full-stack hermetic test (HTTP create + `email()` receive against
> Miniflare bindings) via `@cloudflare/vitest-pool-workers`. Deferred because the
> worker's react-router entry needs a dedicated test entry to load DOs without the
> SPA build; the live E2E (Layer B) covers the full chain in the meantime.

## Layer B — live end-to-end smoke (proves the goal; new QA pattern)

Runs against the **deployed** worker. Proves a brand-new, dynamically-created
mailbox receives a **real external email** end-to-end (mails.dev → CF Email
Routing catch-all → `receiveEmail` → inbox) with **no redeploy** — and cleans up.

```bash
AGENTIC_INBOX_TOKEN=sk_aibx_... MAILS_DEV_API_KEY=mk_... npm run e2e
```

Optional env: `AGENTIC_INBOX_URL`, `MAILS_DEV_SEND_URL` (default
`https://api.mails.dev/v1/send`), `E2E_DOMAIN` (default `mail.build`),
`E2E_NAMESPACE` (default `postel-e2e`), `E2E_TIMEOUT_MS`, `E2E_POLL_MS`.

Why an external sender (mails.dev) instead of the worker's own send API:
Cloudflare's `send_email` binding only delivers to **verified** destination
addresses, so the worker can't self-send to an arbitrary dynamic alias.
mails.dev is an external HTTP sender that faithfully exercises the real inbound
path. It has a **monthly send quota** (100/mo on the current plan), so Layer B is
**not** a per-commit gate — run it on demand / on a schedule. The script is also
the new QA onboarding-mailbox pattern: an ephemeral unique mailbox per run, no
literal pre-allocation (replaces the 30 `pai-onboard-daily-NNN` literals).

Keys are secrets — keep them out of source and out of public channels
(e.g. `.secrets/agentic-inbox-token.txt`, `.secrets/mails-dev-api-key.txt`,
gitignored, mode 600).
