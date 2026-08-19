import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mailboxOf, mailboxKey } from "./mailboxRef";

describe("mailboxOf / mailboxKey", () => {
	it("resolves a +tag address to its mailbox", () => {
		expect(mailboxOf("artin+staging-smoke@mail.build")).toBe("artin@mail.build");
		expect(mailboxKey("artin+shop@mail.build")).toBe("mailboxes/artin@mail.build.json");
	});
	it("lower-cases and trims", () => {
		expect(mailboxOf("  Artin@Mail.Build ")).toBe("artin@mail.build");
	});
	it("leaves a plain address alone", () => {
		expect(mailboxKey("artin@mail.build")).toBe("mailboxes/artin@mail.build.json");
	});
});

// Structural guard, not a style check: the `+tag` rule was applied on the inbound
// path but missed on internal send, so agent-to-agent mail to `someone+tag@`
// 404'd while external mail to it delivered. Any NEW site that builds a mailbox
// key or names a Durable Object from an address by hand can silently reintroduce
// that split — so fail here instead of discovering it in production.
describe("address→mailbox resolution stays in ONE place", () => {
	const workersDir = join(import.meta.dirname, "..");

	function sourceFiles(dir: string, out: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules") continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) sourceFiles(full, out);
			else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
		}
		return out;
	}

	const ALLOWED = ["mailboxRef.ts", "keyRegistry.ts"]; // the module itself; keyRegistry builds doc URLs, not lookups

	it("no file builds a `mailboxes/<addr>.json` key outside mailboxRef", () => {
		const offenders = sourceFiles(workersDir)
			.filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
			.filter((f) => /mailboxes\/\$\{/.test(readFileSync(f, "utf8")))
			.map((f) => f.slice(workersDir.length + 1));
		expect(offenders, "use mailboxKey()/mailboxExists() from lib/mailboxRef").toEqual([]);
	});

	it("no file names a mailbox/agent Durable Object outside mailboxRef", () => {
		const offenders = sourceFiles(workersDir)
			.filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
			.filter((f) => /(MAILBOX|EMAIL_AGENT)\.idFromName/.test(readFileSync(f, "utf8")))
			.map((f) => f.slice(workersDir.length + 1));
		expect(offenders, "use mailboxStub()/emailAgentStub() from lib/mailboxRef").toEqual([]);
	});
});
