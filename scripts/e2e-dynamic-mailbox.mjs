#!/usr/bin/env node
// Layer B — live end-to-end smoke test for dynamic mailbox support.
//
// Proves the goal against the DEPLOYED worker:
//   1. Create a brand-new mailbox under a configured domain (no redeploy).
//   2. Send a real email to it (self-send A->A: worker -> CF EMAIL -> catch-all
//      Email Routing -> receiveEmail). This exercises the full delivery chain.
//   3. Poll the inbox until the message arrives -> proves the dynamic gate +
//      catch-all routing + DOMAINS config all work together.
//   4. Clean up the throwaway mailbox.
//
// This same script is the new QA onboarding-mailbox pattern: an ephemeral,
// unique mailbox per run with no literal pre-allocation.
//
// Usage:
//   AGENTIC_INBOX_TOKEN=sk_aibx_... npm run e2e
// Optional env:
//   AGENTIC_INBOX_URL   (default https://agentic-inbox.botiverse.workers.dev)
//   E2E_DOMAIN          (default mail.build)
//   E2E_NAMESPACE       (default postel-e2e)
//   E2E_TIMEOUT_MS      (default 120000)
//   E2E_POLL_MS         (default 5000)

const BASE = (process.env.AGENTIC_INBOX_URL || "https://agentic-inbox.botiverse.workers.dev").replace(/\/$/, "");
const TOKEN = process.env.AGENTIC_INBOX_TOKEN;
const DOMAIN = process.env.E2E_DOMAIN || "mail.build";
const NS = process.env.E2E_NAMESPACE || "postel-e2e";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120000);
const POLL_MS = Number(process.env.E2E_POLL_MS || 5000);

if (!TOKEN) {
	console.error("FATAL: AGENTIC_INBOX_TOKEN is required (the agentic-inbox API key).");
	process.exit(2);
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const log = (...a) => console.log(`[e2e ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
	return { status: res.status, body: json };
}

async function main() {
	// Unique per run so it never collides and needs no pre-allocation.
	const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const mailbox = `${NS}-${stamp}@${DOMAIN}`.toLowerCase();
	const token = `E2E-TOKEN-${stamp}`;
	const subject = `dynamic-mailbox e2e ${token}`;
	let created = false;

	try {
		// 0. connectivity + auth
		const cfg = await req("GET", "/api/v1/config");
		if (cfg.status !== 200) throw new Error(`/config expected 200, got ${cfg.status}: ${JSON.stringify(cfg.body)}`);
		log("auth + connectivity OK; configured domains:", cfg.body?.domains);

		// 1. dynamic create (no redeploy) — must succeed even though not in EMAIL_ADDRESSES
		const create = await req("POST", "/api/v1/mailboxes", { email: mailbox, name: `E2E ${stamp}` });
		if (create.status !== 201) throw new Error(`create expected 201, got ${create.status}: ${JSON.stringify(create.body)}`);
		created = true;
		log("created dynamic mailbox:", mailbox);

		// 2. real self-send (A -> A) through the full delivery chain
		const send = await req("POST", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails`, {
			from: mailbox,
			to: mailbox,
			subject,
			text: `End-to-end delivery probe ${token}. If you can read this in the inbox, dynamic mailbox delivery works.`,
		});
		if (send.status !== 202) throw new Error(`send expected 202, got ${send.status}: ${JSON.stringify(send.body)}`);
		log("sent probe email; waiting for inbound delivery...");

		// 3. poll inbox for the probe
		const deadline = Date.now() + TIMEOUT_MS;
		let found = false;
		while (Date.now() < deadline) {
			await sleep(POLL_MS);
			const inbox = await req("GET", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails?folder=inbox`);
			const emails = Array.isArray(inbox.body) ? inbox.body : inbox.body?.emails || [];
			if (emails.some((e) => (e.subject || "").includes(token))) {
				found = true;
				log(`PROBE RECEIVED in inbox after ~${Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000)}s`);
				break;
			}
			log(`...not yet (${emails.length} in inbox), ${Math.round((deadline - Date.now()) / 1000)}s left`);
		}
		if (!found) throw new Error(`probe email never arrived within ${TIMEOUT_MS}ms — dynamic delivery FAILED`);

		log("✅ PASS: dynamic mailbox created and received real email end-to-end (no redeploy).");
	} finally {
		if (created) {
			const del = await req("DELETE", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}`);
			log(`cleanup DELETE ${mailbox} -> ${del.status}`);
		}
	}
}

main().catch((e) => {
	console.error("❌ FAIL:", e.message);
	process.exit(1);
});
