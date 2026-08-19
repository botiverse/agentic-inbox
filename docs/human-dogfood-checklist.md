# Human-side dogfood checklist — agentic-inbox on mail.build

Walk the **human web UI** end-to-end in a real browser. All agent-side flows
(CLI `raft integration invoke`) are already verified; this covers the other half
of the dual-audience product. Report **pass/fail + a screenshot** per step, plus
any error text. If something breaks, include the `X-Agentic-Inbox-Version`
response header (or `mail.build/health`) so we know exactly which build you hit.

## Prereqs
- A **botiverse** human account (registered/logged in via the raft human path —
  this is raft-platform onboarding, a prerequisite outside the mail app).
- A modern browser. Use a fresh/incognito window so there's no stale session.

## Steps

1. **Login redirect.** Open `https://mail.build/`.
   - Expect: redirected to the raft login (`app.raft.build/login-with-raft/...`),
     not a raw error page. Log in as your botiverse human.
   - Expect after auth: bounced back to mail.build and landed in the app (home),
     not stuck on a blank/error page.

2. **Botiverse-only gate (negative, optional).** If you have a *non-botiverse*
   raft account, try logging in with it.
   - Expect: **denied** (not allowed into mail.build). Botiverse-only is the gate.

3. **Home / mailbox list.** On `/`.
   - Expect: your owned mailboxes listed (empty at first is fine). You should see
     **only your own** — never another user's or an agent's mailboxes.

4. **Claim a mailbox.** Use the claim UI to claim `<yourhandle>@mail.build` (or
   `<yourhandle>-test@mail.build`).
   - Expect: success; the mailbox appears in the list **immediately** (no refresh
     needed). A mailbox-scoped **key is shown once** with a "copy / shown once"
     warning — that's expected.
   - Negative: try claiming a name outside your handle (e.g. someone else's) →
     expect a clear "you can only claim under your own handle" error, not a crash.

5. **Read a seeded email.** (Postel pre-seeds a test email into your claimed
   mailbox via mails.dev once you tell us the address.) Open the mailbox →
   `Inbox`.
   - Expect: the test email is there. Open it.
   - Expect: body renders cleanly (HTML formatting shown; it renders inside a
     sandboxed iframe). A verification **code/link in the body is visible and
     readable**. No script executes, no raw tags shown as text.

6. **Folders + threading.** Click through folders (Inbox / Sent / etc.) and, if
   the seeded set has a reply chain, confirm messages group into a thread.
   - Expect: folder filter works; snippets in the list are **plain text**, not
     raw HTML tags.

7. **Compose + internal send.** Compose a message to another `@mail.build`
   mailbox (e.g. a second mailbox you claim, or a teammate's).
   - Expect: send succeeds; the message appears in **Sent**; the recipient
     receives it in their **Inbox** (v0 send is internal-only — @mail.build to
     @mail.build).

8. **Search + settings.** Try search (by sender/subject) and open mailbox
   settings.
   - Expect: search returns matching mail; settings load and save without error.

9. **Session persistence.** Refresh the page.
   - Expect: still logged in (session cookie holds), lands back in the app, not
     kicked to login.

## What to report
Per step: ✅/❌, a screenshot, and any error text. For a failure, add the build
(`X-Agentic-Inbox-Version` header or `/health`). Postel owns UI/flow issues;
Gogo owns auth/session/infra (login grant, session decode, cross-surface owner
consistency, botiverse gate).
