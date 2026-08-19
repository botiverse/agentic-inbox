# Agentic Inbox — Agent-Facing Error Codes (canonical)

Canonical reference for the raft CLI (`raft integration invoke`) and the Raft
Manual. Source of truth is the worker (`workers/index.ts`, `workers/lib/mailbox.ts`).

## The rule (for the CLI — raft #4894)

Every 4xx the app emits is a structured JSON body: `{ error: string, code: string, ...context }`
with the correct HTTP status. **Every app-emitted 4xx carries a `code`.**

The *only* re-login-fixable failure is an **auth-layer session expiry** — and the
app does **not** emit that. It comes from the session/middleware layer as a bare
401/403 with **no app `code`**. So:

- **Body has a `code` → surface `code` + `error` to the agent.** Do **not** say
  "session expired, re-login" — re-login fixes none of these.
- **Bare auth-layer 401/403 with no `code` → the session case →** "run integration
  login and retry."

Mechanical rule: *has JSON body with `code` → surface it; bare auth-layer 403 →
the session message.* Anything else makes agents loop on re-login for errors that
re-login cannot fix (dogfood: Cardy/Duoyu hit this on QUOTA_EXCEEDED, FORBIDDEN,
and MAILBOX_NOT_LINKED — all masked as "session rejected").

## Codes (agent action surface)

| code | HTTP | when it fires | agent remedy (NOT re-login) |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | claim with no authenticated owner | authenticate (login) |
| `BAD_REQUEST` | 400 | malformed body / missing field (claim, send, mailbox id) | fix the request |
| `ADDRESS_NOT_ALLOWED` | 403 | claim an address not under a configured domain/allowlist | claim `<handle>@<configured-domain>` |
| `NAMESPACE_FORBIDDEN` | 403 | claim outside your handle namespace, or a reserved system name | claim `<yourhandle>@` or `<yourhandle>-*` |
| `QUOTA_EXCEEDED` | 403 | mailbox count == plan limit (free=1, pro=10); body carries `plan`, `owned` | release a mailbox, or upgrade plan |
| `MAILBOX_TAKEN` | 409 | claim an address already owned by another account | pick a different address |
| `MAILBOX_NOT_LINKED` | 403 | read a mailbox that exists but is ownerless | claim it first (adopts it) |
| `FORBIDDEN` | 403 | access a mailbox owned by another account | use one you own |
| `NOT_FOUND` | 404 | mailbox / email does not exist | check the id |
| `SEND_EXTERNAL_UNSUPPORTED` | 400 | send to a recipient outside the configured domain | v0 is internal-only; recipient must be `@<configured-domain>` and already exist |
| `RATE_LIMITED` | 429 | send rate limit hit | back off and retry later |

Reachable via the agent manifest actions: `claim-mailbox`, `list-mailboxes`,
`list-emails`, `get-email`, `release-mailbox`, `send-mail`. Human-UI-only routes
(folders, attachments, email mutation) carry their own errors but agents don't
reach them.
