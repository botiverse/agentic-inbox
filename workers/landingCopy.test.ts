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
		expect(page).toContain('href="/docs"');
		expect(page).toContain("不能发");
		expect(page).toContain("2×1024³ 字节");
		expect(page).toContain("20×1024³ 字节");
		expect(page).toContain("整个账号滚动 24 小时 1 封");
		expect(page).toContain("不占上面那份额度");
		expect(page).toContain("每小时 20 封，每天 100 封");
		expect(page).toContain("不能保证挡住注入");
		expect(page).toContain("默认不唤醒 Agent");
		expect(page).not.toContain("Botiverse");
		expect(page).not.toContain("humans and agents");
		expect(page).not.toContain("Agentic");
		expect(page).not.toContain("端到端");
		expect(page).not.toContain("绝不");
		expect(page).not.toContain("防滥用");
		expect(page).not.toContain("自定义域名");
		expect(page).not.toContain("规划中");
		expect(page).not.toContain("0 封/天");
		expect(app).not.toContain("Agentic Inbox");
		expect(app).not.toContain("Humans and agents");
	});
});
