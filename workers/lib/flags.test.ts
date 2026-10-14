import { describe, it, expect } from "vitest";
import type { FlagshipBinding } from "../types";
import {
	mailboxQuotaLimit,
	sendRateLimits,
	resolveExternalSendDomains,
	flagContext,
} from "./flags";

function flags(partial: Partial<FlagshipBinding>): FlagshipBinding {
	return partial as FlagshipBinding;
}

describe("flagship product knobs", () => {
	it("keeps today's defaults when Flagship is absent or not a targeting match", async () => {
		expect(await mailboxQuotaLimit(undefined, "free", "s1")).toBe(1);
		expect(await mailboxQuotaLimit(undefined, "pro", "s1")).toBe(10);
		expect(await sendRateLimits(undefined)).toEqual({ perHour: 20, perDay: 100 });
		expect(await resolveExternalSendDomains(undefined, "Gmail.com, cat.ms")).toEqual(["gmail.com", "cat.ms"]);

		const staticDefault = flags({
			getNumberDetails: async (_key, fallback) => ({ flagKey: _key, value: 999, reason: "DEFAULT" }),
			getStringDetails: async (_key, fallback) => ({ flagKey: _key, value: "other.com", reason: "STATIC" }),
		});
		expect(await mailboxQuotaLimit(staticDefault, "pro", "s1")).toBe(10);
		expect(await resolveExternalSendDomains(staticDefault, "gmail.com")).toEqual(["gmail.com"]);
	});

	it("uses a number only on TARGETING_MATCH or SPLIT, and rejects a negative", async () => {
		const matched = flags({
			getNumberDetails: async (key) => ({
				flagKey: key,
				value: key === "mailbox-quota-pro" ? 4 : key === "send-limit-per-hour" ? 3.9 : -1,
				reason: key === "send-limit-per-day" ? "SPLIT" : "TARGETING_MATCH",
			}),
		});
		expect(await mailboxQuotaLimit(matched, "pro", "s1")).toBe(4);
		expect(await mailboxQuotaLimit(matched, "free", "s1")).toBe(1);
		expect(await sendRateLimits(matched, { serverId: "s1" })).toEqual({ perHour: 3, perDay: 100 });
	});

	it("replaces the external-domain list only when the string flag matches", async () => {
		const matched = flags({
			getStringDetails: async (key) => ({ flagKey: key, value: "Example.com, ", reason: "TARGETING_MATCH" }),
		});
		expect(await resolveExternalSendDomains(matched, "gmail.com")).toEqual(["example.com"]);

		const empty = flags({
			getStringDetails: async (key) => ({ flagKey: key, value: "", reason: "TARGETING_MATCH" }),
		});
		expect(await resolveExternalSendDomains(empty, "gmail.com")).toEqual([]);
	});

	it("falls back when evaluation throws", async () => {
		const broken = flags({
			getNumberDetails: async () => {
				throw new Error("flagship down");
			},
			getStringDetails: async () => {
				throw new Error("flagship down");
			},
		});
		expect(await mailboxQuotaLimit(broken, "pro", null)).toBe(10);
		expect(await resolveExternalSendDomains(broken, "cat.ms")).toEqual(["cat.ms"]);
	});

	it("puts serverId on the context only when the owner id has one", () => {
		expect(flagContext("raft:s1:agent:a", "a@mail.build")).toEqual({
			serverId: "s1",
			mailboxId: "a@mail.build",
		});
		expect(flagContext(undefined, "a@mail.build")).toEqual({ mailboxId: "a@mail.build" });
	});
});
