import type { Context } from "hono";
import type { MailboxContext } from "./mailbox";
import { sameServerOwners } from "./inboxNotify";
import { mailboxOf, readMailboxSettings } from "./mailboxRef";

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

export function checkSendIdentity(c: Context<MailboxContext>): Response | undefined {
  if (!c.get("authOwner")) return c.json({ code: "AUTH_REQUIRED", error: "Authentication required" }, 401);
}

export function checkSendPlan(c: Context<MailboxContext>): Response | undefined {
  const denied = checkSendIdentity(c);
  if (denied) return denied;
  if (c.get("authPlan") !== "pro") {
    return c.json({ code: "SEND_REQUIRES_PRO", error: "Sending outside your Raft server requires Pro. Same-server mail is available on every plan." }, 403);
  }
}

export type SendRecipients = {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
};

/** The mailbox owner, not a caller-provided From header, determines its server.
 * Missing or unreadable settings never establish the same-server exemption. */
async function mailboxOwner(c: Context<MailboxContext>, address: string): Promise<string | null> {
  try {
    const settings = await readMailboxSettings<{ owner?: unknown }>(c.env, address);
    return typeof settings?.owner === "string" ? settings.owner : null;
  } catch {
    return null;
  }
}

async function allRecipientsOnSameServer(c: Context<MailboxContext>, recipients: SendRecipients): Promise<boolean> {
  const senderOwner = await mailboxOwner(c, c.req.param("mailboxId") ?? "");
  if (!sameServerOwners(senderOwner, c.get("authOwner"))) return false;
  const addresses = [...new Set([recipients.to, recipients.cc, recipients.bcc]
    .flatMap(field => field === undefined ? [] : Array.isArray(field) ? field : [field])
    .map(mailboxOf))];
  if (addresses.length === 0) return false;
  for (const address of addresses) {
    if (!address || !sameServerOwners(senderOwner, await mailboxOwner(c, address))) return false;
  }
  return true;
}

/**
 * Take the external slot for an authenticated session, after storage admission.
 * A storage refusal must not consume the slot. The slot cannot be returned,
 * so the caller releases its storage hold when this denies the send.
 * Same-server To/Cc/Bcc skip the plan and the daily slot.
 */
export async function reserveAuthenticatedSend(
  c: Context<MailboxContext>,
  recipients: SendRecipients,
): Promise<Response | undefined> {
  if (!c.get("authOwner")) return;
  return reserveAccountSend(c, recipients);
}

/** Call after validation and mailbox rate checks, before delivery or Sent writes.
 * Only all-same-server To/Cc/Bcc bypass the external plan and daily admission. */
export async function reserveAccountSend(c: Context<MailboxContext>, recipients: SendRecipients): Promise<Response | undefined> {
  const authDenied = checkSendIdentity(c);
  if (authDenied) return authDenied;
  if (await allRecipientsOnSameServer(c, recipients)) return;
  const denied = checkSendPlan(c);
  if (denied) return denied;
  const owner = c.get("authOwner")!;
  const result = await c.env.OWNER.get(c.env.OWNER.idFromName(owner)).reserveSend();
  if (!result.ok) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))));
    return c.json({
      code: "SEND_QUOTA_EXCEEDED",
      error: "Pro accounts can send one email outside their Raft server per 24 hours across all mailboxes.",
      retryAt: new Date(result.retryAt).toISOString(),
    }, 429);
  }
}
