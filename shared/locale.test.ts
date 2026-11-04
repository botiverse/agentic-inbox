import { describe, expect, it } from "vitest";
import { localeFromRequest } from "./locale";

function request(url: string, headers?: HeadersInit): Request {
	return new Request(url, { headers });
}

describe("localeFromRequest", () => {
	it("prefers lang in the query, then the cookie, then Accept-Language", () => {
		expect(localeFromRequest(request("https://mail.build/?lang=zh"))).toBe("zh");
		expect(
			localeFromRequest(
				request("https://mail.build/", { cookie: "mb_lang=zh", "accept-language": "en" }),
			),
		).toBe("zh");
		expect(
			localeFromRequest(request("https://mail.build/", { "accept-language": "zh-CN,en;q=0.8" })),
		).toBe("zh");
		expect(localeFromRequest(request("https://mail.build/"))).toBe("en");
	});

	it("ignores an unknown lang value", () => {
		expect(localeFromRequest(request("https://mail.build/?lang=fr"))).toBe("en");
	});
});
