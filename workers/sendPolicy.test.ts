import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app as routes } from "./index";
import type { MailboxContext } from "./lib/mailbox";

function fixture(plan: "free" | "pro", options: {
  recipientOwner?: string | null;
  lookupFailure?: boolean;
  rateLimited?: boolean;
  authenticated?: boolean;
} = {}) {
  const owner = "raft:server:human:user";
  const sends: unknown[] = [], writes: unknown[] = [];
  let admitted = false;
  let quotaCalls = 0;
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
      get: () => ({ reserveSend: async () => {
        quotaCalls++;
        if (admitted) return { ok: false, retryAt: Date.now() + 86_400_000 };
        admitted = true; return { ok: true, retryAt: Date.now() + 86_400_000 };
      } }),
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
  return { send, sends, writes, get quotaCalls() { return quotaCalls; } };
}

describe("account send policy on every HTTP send surface", () => {
  for (const path of ["send", "emails", "emails/original/reply", "emails/original/forward"]) {
    it(`Free cannot send through ${path}, without delivery or Sent writes`, async () => {
      const f = fixture("free"); const response = await f.send(path);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("SEND_REQUIRES_PRO");
      expect(f.sends).toHaveLength(0); expect(f.writes).toHaveLength(0);
    });
    it(`Pro admits one send through ${path} then rejects the next`, async () => {
      const f = fixture("pro"); expect((await f.send(path)).status).toBe(202);
      const count = f.writes.length;
      expect((await f.send(path)).status).toBe(429); expect(f.writes).toHaveLength(count);
    });
  }
  it("two simultaneous mailboxes of one account share the send admission", async () => {
    const f = fixture("pro");
    const responses = await Promise.all([f.send("send"), f.send("send", "sender-two@mail.build")]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 429]);
  });
});

describe("same-server mail does not use the external send allowance", () => {
  const paths = ["send", "emails", "emails/original/reply", "emails/original/forward"];
  for (const path of paths) {
    it(`Free can repeatedly send within the server through ${path}`, async () => {
      const f = fixture("free", { recipientOwner: "raft:server:agent:receiver" });
      expect((await f.send(path)).status).toBe(202);
      expect((await f.send(path)).status).toBe(202);
      expect(f.quotaCalls).toBe(0);
      expect(f.writes.length).toBeGreaterThan(0);
    });
    it(`internal ${path} remains available after the external allowance is spent`, async () => {
      const f = fixture("pro");
      expect((await f.send(path, undefined, { to: "colleague@mail.build" })).status).toBe(202);
      expect(f.quotaCalls).toBe(0);
      expect((await f.send(path)).status).toBe(202);
      expect((await f.send(path, undefined, { to: "colleague@mail.build" })).status).toBe(202);
      expect(f.quotaCalls).toBe(1);
      expect((await f.send(path)).status).toBe(429);
    });
    it(`same-server ${path} retains mailbox rate protection`, async () => {
      const f = fixture("free", { recipientOwner: "raft:server:agent:receiver", rateLimited: true });
      expect((await f.send(path)).status).toBe(429);
      expect(f.quotaCalls).toBe(0); expect(f.writes).toHaveLength(0);
    });
    it(`same-server ${path} still requires authentication`, async () => {
      const f = fixture("free", { recipientOwner: "raft:server:agent:receiver", authenticated: false });
      expect((await f.send(path)).status).toBe(401);
      expect(f.quotaCalls).toBe(0); expect(f.writes).toHaveLength(0);
    });
  }
  for (const path of paths.slice(1)) {
    for (const field of ["to", "cc", "bcc"]) {
      it(`an outside recipient in ${field} makes ${path} an external send`, async () => {
        const f = fixture("free", { recipientOwner: "raft:server:agent:receiver" });
        const recipients = field === "to" ? { to: ["receiver@mail.build", "outside@example.net"] }
          : { [field]: ["colleague@mail.build", "outside@example.net"] };
        expect((await f.send(path, undefined, recipients)).status).toBe(403);
        expect(f.quotaCalls).toBe(0); expect(f.writes).toHaveLength(0);
      });
    }
    it(`all To/Cc/Bcc on this server are exempt through ${path}`, async () => {
      const f = fixture("free", { recipientOwner: "raft:server:agent:receiver" });
      expect((await f.send(path, undefined, {
        to: ["ReCeIvEr+work@MAIL.BUILD", "colleague@mail.build"],
        cc: "colleague+cc@mail.build", bcc: ["receiver+bcc@mail.build"],
      })).status).toBe(202);
      expect(f.quotaCalls).toBe(0);
    });
  }
  for (const options of [{ recipientOwner: null }, { recipientOwner: "legacy-owner" }, { lookupFailure: true }]) {
    it(`unknown recipient ownership does not grant exemption: ${JSON.stringify(options)}`, async () => {
      const f = fixture("free", options);
      expect((await f.send("emails")).status).toBe(403);
      expect(f.quotaCalls).toBe(0); expect(f.writes).toHaveLength(0);
    });
  }
  it("same-server recipients cannot authorize a forged From mailbox", async () => {
    const f = fixture("free", { recipientOwner: "raft:server:agent:receiver" });
    expect((await f.send("emails", undefined, { from: "colleague@mail.build" })).status).toBe(400);
    expect(f.quotaCalls).toBe(0); expect(f.writes).toHaveLength(0);
  });
});

describe("new mailbox local-part length", () => {
  function claims(existingOwned = false) {
    const owner = "raft:server:human:user";
    const writes: string[] = [];
    const api = new Hono<MailboxContext>();
    api.use("*", async (c, next) => { c.set("authOwner", owner); c.set("authHandle", "claim"); c.set("authPlan", "pro"); await next(); });
    api.route("/", routes);
    const env = {
      DOMAINS: "mail.build", EMAIL_ADDRESSES: [],
      BUCKET: { get: async () => existingOwned ? { json: async () => ({ owner, fromName: "Existing" }) } : null,
        put: async (key: string) => { writes.push(key); } },
      OWNER: { idFromName: (s: string) => s, get: () => ({ reserve: async () => ({ ok: true, owned: 1 }), release: async () => ({ owned: 0 }) }) },
      MAILBOX: { idFromName: (s: string) => s, get: () => ({ getFolders: async () => [] }) },
    };
    return { writes, claim: (local: string) => api.request("/api/v1/mailboxes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${local}@mail.build`, name: "Claim" }),
    }, env as never) };
  }
  it("rejects 7 characters before @ without provisioning, and accepts 8", async () => {
    const f = claims();
    const denied = await f.claim("claim-x"); expect(denied.status).toBe(400);
    expect(((await denied.json()) as { code: string }).code).toBe("LOCALPART_TOO_SHORT"); expect(f.writes).toHaveLength(0);
    expect((await f.claim("claim-xy")).status).toBe(201); expect(f.writes.length).toBeGreaterThan(0);
  });
  it("keeps an existing owned short mailbox idempotently claimable", async () => {
    expect((await claims(true).claim("claim")).status).toBe(200);
  });
});
