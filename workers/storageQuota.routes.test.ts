import { describe, expect, it } from "vitest";
import { app, receiveEmail } from "./index";

function rawEmail(to: string) {
	const text = ["From: sender@example.com", `To: ${to}`, "Subject: hello", "", "body text", ""].join("\r\n");
	const bytes = new TextEncoder().encode(text);
	return { stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), size: bytes.byteLength };
}

function owner(opts: { ok: boolean; used?: number; limit?: number }) {
	const released: number[] = [];
	let pending = 0;
	return {
		released,
		binding: {
			idFromName: (id: string) => id,
			get: () => ({
				plan: async () => "free" as const,
				rememberPlan: async () => {},
				reserveStorage: async () => ({ ok: opts.ok, used: opts.used ?? 0, limit: opts.limit ?? 10, id: "hold" }),
				cancelStorage: async () => ({ used: 0 }),
				commitStorage: async () => ({ used: 0 }),
				openStorageDelete: async (_owner: string, bytes: number) => {
					pending = bytes;
					return { id: bytes > 0 ? "del" : "", used: 0 };
				},
				completeStorageDelete: async () => {
					if (pending > 0) released.push(pending);
					pending = 0;
					return { used: 0 };
				},
				abortStorageDelete: async () => {
					pending = 0;
					return { used: 0 };
				},
			}),
		},
	};
}

describe("storage quota on inbound and send", () => {
	it("rejects inbound with 552 and does not store the message", async () => {
		const { stream, size } = rawEmail("artin@mail.build");
		const rejects: string[] = [];
		const stored: unknown[] = [];
		const account = owner({ ok: false, used: 10, limit: 10 });
		const env = {
			DOMAINS: "mail.build",
			EMAIL_ADDRESSES: [],
			BUCKET: {
				head: async () => ({}),
				get: async () => ({ json: async () => ({ owner: "raft:artin" }) }),
				put: async () => { throw new Error("attachment put should not run"); },
			},
			MAILBOX: {
				idFromName: (n: string) => n,
				get: () => ({
					createEmail: async (_folder: string, row: unknown) => { stored.push(row); return { created: true, id: "id" }; },
					findThreadBySubject: async () => null,
				}),
			},
			OWNER: account.binding,
		};
		await receiveEmail(
			{ raw: stream, rawSize: size, setReject: (reason: string) => rejects.push(reason) },
			env as never,
			{ waitUntil() {} } as never,
		);
		expect(rejects).toEqual(["552 Quota exceeded"]);
		expect(stored).toHaveLength(0);
		expect(account.released).toHaveLength(0);
	});

	it("refuses a send that would pass the account cap and writes no Sent copy", async () => {
		const account = owner({ ok: false, used: 20, limit: 20 });
		const stored: unknown[] = [];
		const env = {
			DOMAINS: "mail.build",
			EMAIL_ADDRESSES: [],
			BUCKET: {
				head: async () => ({}),
				get: async () => ({ json: async () => ({ owner: "raft:artin" }) }),
			},
			MAILBOX: {
				idFromName: (n: string) => n,
				get: () => ({
					checkSendRateLimit: async () => null,
					createEmail: async (_folder: string, row: unknown) => { stored.push(row); return { created: true, id: "id" }; },
				}),
			},
			OWNER: account.binding,
		};
		const res = await app.request("/api/v1/mailboxes/artin@mail.build/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to: "other@mail.build", subject: "s", text: "hello" }),
		}, env as never);
		expect(res.status).toBe(413);
		expect((await res.json() as { code: string }).code).toBe("STORAGE_QUOTA_EXCEEDED");
		expect(stored).toHaveLength(0);
	});

	it("returns the deleted message's bytes to the account", async () => {
		const account = owner({ ok: true });
		const env = {
			BUCKET: {
				head: async () => ({}),
				get: async () => ({ json: async () => ({ owner: "raft:artin" }) }),
				delete: async () => {},
			},
			MAILBOX: {
				idFromName: (n: string) => n,
				get: () => ({
					measureEmailBytes: async () => 42,
					deleteEmail: async () => [],
				}),
			},
			OWNER: account.binding,
		};
		const res = await app.request("/api/v1/mailboxes/artin@mail.build/emails/msg-1", { method: "DELETE" }, env as never);
		expect(res.status).toBe(204);
		expect(account.released).toEqual([42]);
	});
});
