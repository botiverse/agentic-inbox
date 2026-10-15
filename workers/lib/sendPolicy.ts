import type { Context } from "hono";
import type { MailboxContext } from "./mailbox";

export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
type Admission = { ok: boolean; retryAt: number };

/** One durable reservation per account, shared by every mailbox/send route.
 * Reserve before delivery: an uncertain provider failure must not allow a
 * retry to send a second message. No email deletion or mailbox release resets it.
 */
export async function reserveDailySend(
  storage: Pick<DurableObjectStorage, "transaction">,
  now = Date.now(),
): Promise<Admission> {
  return storage.transaction(async (tx) => {
    const retryAt = await tx.get<number>("send:nextAllowedAt") ?? 0;
    if (retryAt > now) return { ok: false, retryAt };
    const next = now + SEND_WINDOW_MS;
    await tx.put("send:nextAllowedAt", next);
    return { ok: true, retryAt: next };
  });
}

export function checkSendPlan(c: Context<MailboxContext>): Response | undefined {
  if (!c.get("authOwner")) return c.json({ code: "AUTH_REQUIRED", error: "Authentication required" }, 401);
  if (c.get("authPlan") !== "pro") {
    return c.json({ code: "SEND_REQUIRES_PRO", error: "Sending requires Pro. Free accounts can receive email." }, 403);
  }
}

/**
 * Take the daily slot for an authenticated session, after storage admission.
 * A storage refusal must not consume the slot. The slot cannot be returned,
 * so the caller releases its storage hold when this denies the send.
 * No session means the outer login wall already rejected the request in
 * production; direct router tests cover storage without a session.
 */
export async function reserveAuthenticatedSend(c: Context<MailboxContext>): Promise<Response | undefined> {
  if (!c.get("authOwner")) return;
  return reserveAccountSend(c);
}

/** Call only after request validation and before any send or Sent write. */
export async function reserveAccountSend(c: Context<MailboxContext>): Promise<Response | undefined> {
  const denied = checkSendPlan(c);
  if (denied) return denied;
  const owner = c.get("authOwner")!;
  const result = await c.env.OWNER.get(c.env.OWNER.idFromName(owner)).reserveSend();
  if (!result.ok) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))));
    return c.json({
      code: "SEND_QUOTA_EXCEEDED",
      error: "Pro accounts can send one email per 24 hours across all mailboxes.",
      retryAt: new Date(result.retryAt).toISOString(),
    }, 429);
  }
}
