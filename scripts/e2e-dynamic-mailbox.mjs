#!/usr/bin/env node
// Layer B — live end-to-end smoke test for dynamic mailbox support.
//
// Proves the goal against the DEPLOYED worker, via REAL external delivery:
//   1. Create a brand-new mailbox under a configured domain (no redeploy).
//   2. Send a real email to it from an external sender (mails.dev) →
//      CF Email Routing catch-all → receiveEmail → R2/DO.
//   3. Poll the inbox until the message arrives → proves the dynamic gate +
//      catch-all routing + DOMAINS config all work together.
//   4. Clean up the throwaway mailbox.
//
// This same script is the new QA onboarding-mailbox pattern: an ephemeral,
// unique mailbox per run with no literal pre-allocation.
//
// Why mails.dev (not the worker's own send API): Cloudflare's `send_email`
// binding only delivers to *verified* destination addresses, so the worker
// cannot self-send to an arbitrary dynamic alias. mails.dev is an external
// HTTP email sender, which faithfully exercises the real inbound path.
// Note: mails.dev has a monthly send quota (100/mo on the current plan) — keep
// E2E runs occasional, not per-commit.
//
// Usage:
//   AGENTIC_INBOX_TOKEN=sk_aibx_... MAILS_DEV_API_KEY=mk_... npm run e2e
// Optional env:
//   AGENTIC_INBOX_URL   (default https://agentic-inbox.botiverse.workers.dev)
//   MAILS_DEV_SEND_URL  (default https://api.mails.dev/v1/send)
//   E2E_DOMAIN          (default mail.build)
//   E2E_NAMESPACE       (default postel-e2e)
//   E2E_TIMEOUT_MS      (default 120000)
//   E2E_POLL_MS         (default 5000)

const BASE = (process.env.AGENTIC_INBOX_URL || "https://agentic-inbox.botiverse.workers.dev").replace(/\/$/, "");
const TOKEN = process.env.AGENTIC_INBOX_TOKEN;
const MAILS_KEY = process.env.MAILS_DEV_API_KEY;
const MAILS_SEND_URL = process.env.MAILS_DEV_SEND_URL || "https://api.mails.dev/v1/send";
const DOMAIN = process.env.E2E_DOMAIN || "mail.build";
const NS = process.env.E2E_NAMESPACE || "postel-e2e";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120000);
const POLL_MS = Number(process.env.E2E_POLL_MS || 5000);

if (!TOKEN) {
	console.error("FATAL: AGENTIC_INBOX_TOKEN is required (the agentic-inbox API key).");
	process.exit(2);
}
if (!MAILS_KEY) {
	console.error("FATAL: MAILS_DEV_API_KEY is required (external sender for the inbound probe).");
	process.exit(2);
}

const log = (...a) => console.log(`[e2e ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
	return { status: res.status, body: json };
}

async function sendViaMailsDev(to, subject, text) {
	const res = await fetch(MAILS_SEND_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${MAILS_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ to, subject, text }),
	});
	const text2 = await res.text();
	let json;
	try { json = JSON.parse(text2); } catch { json = text2; }
	if (!res.ok) throw new Error(`mails.dev send failed ${res.status}: ${text2}`);
	return json;
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
		const cfg = await api("GET", "/api/v1/config");
		if (cfg.status !== 200) throw new Error(`/config expected 200, got ${cfg.status}: ${JSON.stringify(cfg.body)}`);
		log("auth + connectivity OK; configured domains:", cfg.body?.domains);

		// 1. dynamic create (no redeploy) — must succeed even though not in EMAIL_ADDRESSES
		const create = await api("POST", "/api/v1/mailboxes", { email: mailbox, name: `E2E ${stamp}` });
		if (create.status !== 201) throw new Error(`create expected 201, got ${create.status}: ${JSON.stringify(create.body)}`);
		created = true;
		log("created dynamic mailbox:", mailbox);

		// 2. real external send via mails.dev → CF Email Routing catch-all → receiveEmail
		const sent = await sendViaMailsDev(mailbox, subject, `End-to-end delivery probe ${token}.`);
		log(`mails.dev accepted send (id=${sent.id}, provider=${sent.provider}, monthly_remaining=${sent.monthly_remaining}); waiting for inbound...`);

		// 3. poll inbox for the probe
		const deadline = Date.now() + TIMEOUT_MS;
		let found = false;
		while (Date.now() < deadline) {
			await sleep(POLL_MS);
			const inbox = await api("GET", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails?folder=inbox`);
			const emails = Array.isArray(inbox.body) ? inbox.body : inbox.body?.emails || [];
			if (emails.some((e) => (e.subject || "").includes(token))) {
				found = true;
				log(`PROBE RECEIVED in inbox after ~${Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000)}s`);
				break;
			}
			log(`...not yet (${emails.length} in inbox), ${Math.round((deadline - Date.now()) / 1000)}s left`);
		}
		if (!found) throw new Error(`probe email never arrived within ${TIMEOUT_MS}ms — dynamic delivery FAILED`);

		log("✅ PASS: dynamic mailbox created and received a real external email end-to-end (no redeploy).");
	} finally {
		if (created) {
			const del = await api("DELETE", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}`);
			log(`cleanup DELETE ${mailbox} -> ${del.status}`);
		}
	}
}

main().catch((e) => {
	console.error("❌ FAIL:", e.message);
	process.exit(1);
});
