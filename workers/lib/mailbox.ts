// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { mailboxAccessAllowed } from "./auth";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		// Set by the auth middleware (workers/app.ts). `authOwner` is the resolved
		// caller identity (an accountId / raft:${server_id}:${type}:${sub}, or
		// "local:admin"); `authScope` is the presented key's scope (a mailbox id,
		// "account", or "admin"); `authIsAdmin` short-circuits ownership checks.
		authOwner?: string;
		authScope?: string;
		authIsAdmin?: boolean;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists (GET so we can read its owner for authorization).
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.get(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Owner-scoped access: enforce for scoped-key callers. Legacy callers (CF
	// Access human session with no scope) pass through during the transition.
	const authScope = c.get("authScope");
	if (authScope) {
		const settings = (await obj.json().catch(() => ({}))) as { owner?: string };
		const allowed = mailboxAccessAllowed(
			{ owner: c.get("authOwner") ?? "", scope: authScope },
			{ id: mailboxId, owner: settings.owner ?? null },
		);
		if (!allowed) return c.json({ error: "Forbidden: this key is not scoped to this mailbox" }, 403);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);
	
	await next();
});
