import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app as routes } from "./index";
import type { MailboxContext } from "./lib/mailbox";

function fixture(plan: "free" | "pro", options: {
  recipientOwner?: string | null;
  lookupFailure?: boolean;
  rateLimited?: boolean;
  authenticated?: boolean; storageDenied?: boolean; sendRpcFailure?: boolean;
} = {}) {
  const owner = "raft:server:human:user";
  const sends: unknown[] = [], writes: unknown[] = [];
  let admitted = false;
  let quotaCalls = 0; let storageCalls = 0; let cancellations = 0;
  const env = {
    DOMAINS: "mail.build", EMAIL_ADDRESSES: [],
    BUCKET: {
      get: async (key: string) => {
        if (["mailboxes/sender-one@mail.build.json", "mailboxes/sender-two@mail.build.json"].includes(key)) return { json: async () => ({ owner }) };
        if (key === "mailboxes/receiver@mail.build.json") {
          if (options.lookupFailure) throw new Error("recipient settings unavailable");
          const recipientOwner = options.recipientOwner === undefined ? "raft:other:agent:receiver" : options.recipientOwner;
          return recipientOwner === null ? null : { json: async () => ({ owner: recipientOwner }) };
        }
        if (key === "mailboxes/colleague@mail.build.json") return { json: async () => ({ owner: "raft:server:agent:colleague" }) };
        return null;
      },
      head: async () => ({}), put: async () => {},
    },
    OWNER: {
      idFromName: (id: string) => id,
      get: () => ({
        reserveSend: async () => {
          quotaCalls++; if (options.sendRpcFailure) throw new Error("injected send admission reply loss");
          if (admitted) return { ok: false, retryAt: Date.now() + 86_400_000 };
          admitted = true; return { ok: true, retryAt: Date.now() + 86_400_000 };
        },
        plan: async () => "pro" as const,
        rememberPlan: async () => {},
        reserveStorage: async () => { storageCalls++; return options.storageDenied ? { ok: false, used: 10, limit: 10 } : { ok: true, used: 0, limit: 10, id: "hold" }; },
        cancelStorage: async () => { cancellations++; return { used: 0 }; },
        commitStorage: async () => ({ used: 0 }),
      }),
    },
    EMAIL: { send: async (mail: unknown) => { sends.push(mail); return { messageId: "provider-id" }; } },
    MAILBOX: { idFromName: (id: string) => id, get: () => ({
      checkSendRateLimit: async () => options.rateLimited ? "Mailbox rate limit" : null,
      getEmail: async () => ({ id: "original", message_id: "original@example.com", subject: "Hi", sender: "other@example.com", recipient: "sender-one@mail.build", date: new Date().toISOString(), body: "Original" }),
      createEmail: async (_folder: string, row: unknown) => { writes.push(row); return { created: true, id: "sent-id" }; },
      markThreadRead: async () => {},
    }) },
  };
  const api = new Hono<MailboxContext>();
  api.use("*", async (c, next) => { if (options.authenticated !== false) { c.set("authOwner", owner); c.set("authScope", "account"); c.set("authPlan", plan); } await next(); });
  api.route("/", routes);
  async function send(path: string, mailbox = "sender-one@mail.build", override: Record<string, unknown> = {}) {
    const waiting: Promise<unknown>[] = [];
    const body = path === "send" ? { to: "receiver@mail.build", subject: "Hi", text: "Body" }
      : { from: mailbox, to: "receiver@mail.build", subject: "Hi", text: "Body" };
    const response = await api.request(`/api/v1/mailboxes/${mailbox}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...override }),
    }, env as never, { waitUntil: (p: Promise<unknown>) => waiting.push(p) } as never);
    await Promise.all(waiting);
    return response;
  }
  return { send, sends, writes, get storageCalls() { return storageCalls; }, get cancellations() { return cancellations; }, get quotaCalls() { return quotaCalls; } };
}


for (const path of ["send", "emails", "emails/original/reply", "emails/original/forward"]) {
 it(`cross combined: storage refusal precedes daily external slot on ${path}`, async () => {
  const f=fixture("pro",{storageDenied:true});
  expect((await f.send(path)).status).toBe(413);
  expect(f.quotaCalls).toBe(0);expect(f.writes).toHaveLength(0);expect(f.sends).toHaveLength(0);
 });
 it(`cross combined: Free external refusal releases storage on ${path}`, async () => {
  const f=fixture("free");expect((await f.send(path)).status).toBe(403);
  expect(f.storageCalls).toBe(1);expect(f.cancellations).toBe(1);expect(f.writes).toHaveLength(0);
 });
 it(`cross combined: failed quota RPC before delivery releases storage on ${path}`, async () => {
  const f=fixture("pro",{sendRpcFailure:true});expect((await f.send(path)).status).toBe(500);
  expect(f.writes).toHaveLength(0);expect(f.sends).toHaveLength(0);
  expect(f.storageCalls).toBe(1);expect(f.cancellations).toBe(1);
 });
}
