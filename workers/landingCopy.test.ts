import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public page copy", () => {
	const root = join(import.meta.dirname, "..");
	const landing = readFileSync(join(root, "workers/app.ts"), "utf8");
	const app = [
		readFileSync(join(root, "app/root.tsx"), "utf8"),
		readFileSync(join(root, "app/routes/home.tsx"), "utf8"),
		readFileSync(join(root, "app/routes/login.tsx"), "utf8"),
	].join("\n");

	it("landing and app chrome use mail.build and do not say the product is closed", () => {
		const page = landing.slice(landing.indexOf("function landingHtml"), landing.indexOf("export { MailboxDO }"));
		expect(page).toContain("<title>mail.build</title>");
		expect(page).toContain("<h1>mail.build</h1>");
		expect(page).toContain("Login with Raft");
		expect(page).not.toContain("Botiverse");
		expect(page).not.toContain("humans and agents");
		expect(page).not.toContain("Agentic");
		expect(app).not.toContain("Agentic Inbox");
		expect(app).not.toContain("Humans and agents");
	});
});
