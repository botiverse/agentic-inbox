// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Product knobs read from Cloudflare Flagship.
 *
 * A flag overrides the code default only when evaluation reports TARGETING_MATCH
 * or SPLIT. A missing flag, a static default, or an evaluation error keeps the
 * value already shipping today.
 */
import type { FlagshipBinding } from "../types";
import { parseDomains } from "./allowlist";
import { serverIdFromOwner } from "./auth";

const OVERRIDE_REASONS = new Set(["TARGETING_MATCH", "SPLIT"]);

export type FlagContext = Record<string, string | number | boolean>;

export const DEFAULT_EXTERNAL_SEND_DOMAINS = "gmail.com,botiverse.dev,cat.ms,oranix.io,mercury.com";

export const DEFAULT_QUOTA_FREE = 1;
export const DEFAULT_QUOTA_PRO = 10;
export const DEFAULT_SEND_PER_HOUR = 20;
export const DEFAULT_SEND_PER_DAY = 100;

function usableCount(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n >= 0 ? n : fallback;
}

async function targetedNumber(
	flags: FlagshipBinding | undefined,
	key: string,
	fallback: number,
	context?: FlagContext,
): Promise<number> {
	if (!flags || typeof flags.getNumberDetails !== "function") return fallback;
	try {
		const details = await flags.getNumberDetails(key, fallback, context);
		if (!details.reason || !OVERRIDE_REASONS.has(details.reason)) return fallback;
		return usableCount(details.value, fallback);
	} catch (err) {
		console.warn(`[flagship] error evaluating ${key}:`, err);
		return fallback;
	}
}

async function targetedString(
	flags: FlagshipBinding | undefined,
	key: string,
	fallback: string,
	context?: FlagContext,
): Promise<string> {
	if (!flags || typeof flags.getStringDetails !== "function") return fallback;
	try {
		const details = await flags.getStringDetails(key, fallback, context);
		if (!details.reason || !OVERRIDE_REASONS.has(details.reason)) return fallback;
		return typeof details.value === "string" ? details.value : fallback;
	} catch (err) {
		console.warn(`[flagship] error evaluating ${key}:`, err);
		return fallback;
	}
}

/** Mailbox cap for this plan. Flag keys: mailbox-quota-free, mailbox-quota-pro. */
export async function mailboxQuotaLimit(
	flags: FlagshipBinding | undefined,
	plan: "free" | "pro",
	serverId: string | null,
): Promise<number> {
	const pro = plan === "pro";
	return targetedNumber(
		flags,
		pro ? "mailbox-quota-pro" : "mailbox-quota-free",
		pro ? DEFAULT_QUOTA_PRO : DEFAULT_QUOTA_FREE,
		serverId ? { serverId } : undefined,
	);
}

/** Send caps. Flag keys: send-limit-per-hour, send-limit-per-day. */
export async function sendRateLimits(
	flags: FlagshipBinding | undefined,
	context?: FlagContext,
): Promise<{ perHour: number; perDay: number }> {
	const [perHour, perDay] = await Promise.all([
		targetedNumber(flags, "send-limit-per-hour", DEFAULT_SEND_PER_HOUR, context),
		targetedNumber(flags, "send-limit-per-day", DEFAULT_SEND_PER_DAY, context),
	]);
	return { perHour, perDay };
}

/** Context a send or domain flag can target: this mailbox, and its server when known. */
export function flagContext(owner: string | undefined, mailboxId: string): FlagContext {
	const serverId = serverIdFromOwner(owner);
	return serverId ? { serverId, mailboxId } : { mailboxId };
}

/**
 * External domains we may send to. Flag key: external-send-domains
 * (comma-separated). A matched empty string means no external domains.
 */
export async function resolveExternalSendDomains(
	flags: FlagshipBinding | undefined,
	context?: FlagContext,
): Promise<string[]> {
	const raw = await targetedString(flags, "external-send-domains", DEFAULT_EXTERNAL_SEND_DOMAINS, context);
	return parseDomains(raw);
}
