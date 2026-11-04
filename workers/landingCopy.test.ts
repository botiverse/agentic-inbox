import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLandingHtml } from "../shared/landingHtml";

const forbidden = ["Botiverse", "humans and agents", "Agentic", "端到端", "绝不", "防滥用", "自定义域名", "规划中", "0 封/天"];

describe("public page copy", () => {
	const root = join(import.meta.dirname, "..");
	const app = [
		readFileSync(join(root, "app/root.tsx"), "utf8"),
		readFileSync(join(root, "app/routes/home.tsx"), "utf8"),
		readFileSync(join(root, "app/routes/login.tsx"), "utf8"),
	].join("\n");

	it("renders the signed-out home page in Chinese and English", () => {
		const zh = renderLandingHtml("zh", "/auth/raft/login?next=%2F");
		const en = renderLandingHtml("en", "/auth/raft/login?next=%2F");
		expect(zh).toContain('lang="zh"');
		expect(zh).toContain("不能发");
		expect(zh).toContain("2×1024³ 字节");
		expect(zh).toContain("20×1024³ 字节");
		expect(zh).toContain("整个账号滚动 24 小时 1 封");
		expect(zh).toContain("1 个");
		expect(zh).toContain("10 个");
		expect(zh).toContain('href="/docs"');
		expect(zh).toContain('href="?lang=en"');
		expect(en).toContain('lang="en"');
		expect(en).toContain("Cannot send");
		expect(en).toContain("1 send per rolling 24 hours for the whole account");
		expect(en).toContain("Login with Raft");
		expect(en).toContain('href="?lang=zh"');
		for (const page of [zh, en]) {
			expect(page).toContain("<title>mail.build</title>");
			for (const phrase of forbidden) expect(page).not.toContain(phrase);
		}
		expect(app).not.toContain("Agentic Inbox");
		expect(app).not.toContain("Humans and agents");
	});
});
