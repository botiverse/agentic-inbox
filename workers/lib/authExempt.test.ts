import { describe, expect, it } from "vitest";
import { isAuthExemptPath } from "./authExempt";

function pathOf(url: string): string {
	return new URL(url).pathname;
}

describe("auth exemptions", () => {
	it("lets an anonymous visitor open the help page and the files it loads", () => {
		expect(isAuthExemptPath(pathOf("https://mail.build/docs"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/docs?from=home"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/favicon.ico"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/favicon.svg"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/assets/root-abc.css"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/assets/entry.client-abc.js"))).toBe(true);
	});

	it("keeps mailbox pages and the API behind login", () => {
		expect(isAuthExemptPath(pathOf("https://mail.build/"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/login"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/docs/"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/docs/extra"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/docs-private"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/mailbox/box"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/api/v1/mailboxes"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/assets"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/assets/../api/v1/mailboxes"))).toBe(false);
		expect(isAuthExemptPath(pathOf("https://mail.build/assets/%2e%2e/api/v1/mailboxes"))).toBe(false);
	});

	it("still exempts login, the agent manifest, and health", () => {
		expect(isAuthExemptPath(pathOf("https://mail.build/auth/raft/login"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/auth/callback"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/.well-known/raft-agent-manifest.json"))).toBe(true);
		expect(isAuthExemptPath(pathOf("https://mail.build/health"))).toBe(true);
	});
});
