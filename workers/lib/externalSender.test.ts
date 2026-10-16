// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { senderAddress, stampExternalSenders } from "./externalSender";

const mailbox = "postel@mail.build";
const same = "raft:s1:agent:postel";
const human = "raft:s1:human:artin";
const other = "raft:s2:agent:eve";

function bucket(byMailbox: Record<string, unknown>) {
	const gets: string[] = [];
	const env = {
		BUCKET: {
			get: async (key: string) => {
				gets.push(key);
				const id = key.replace("mailboxes/", "").replace(".json", "");
				const settings = byMailbox[id];
				if (settings === "throw") throw new Error("r2 down");
				return settings == null ? null : { json: async () => settings };
			},
		},
	};
	return { env: env as unknown as Pick<Env, "BUCKET">, gets };
}

describe("senderAddress", () => {
	it("keeps a bare address and unwraps a display name", () => {
		expect(senderAddress(" Artin@mail.build ")).toBe("artin@mail.build");
		expect(senderAddress('Artin <Artin+Shop@mail.build>')).toBe("artin+shop@mail.build");
		expect(senderAddress("")).toBe("");
		expect(senderAddress("not an address")).toBe("");
	});
});

describe("stampExternalSenders", () => {
	it("is false only when both owners share a Raft server", async () => {
		const { env } = bucket({
			[mailbox]: { owner: same, inboxNotifyAllow: ["gmail.com"] },
			"artin@mail.build": { owner: human },
		});
		const [row] = await stampExternalSenders(env, mailbox, [
			{ from: "Artin <artin@mail.build>", untrusted: true },
		]);
		expect(row.external_sender).toBe(false);
		expect(row.untrusted).toBe(true);
	});

	it("stays external for another server, a missing mailbox, and an allow-listed address", async () => {
		const { env } = bucket({
			[mailbox]: { owner: same, inboxNotifyAllow: ["gmail.com", "pager.test"] },
			"eve@mail.build": { owner: other },
		});
		const rows = await stampExternalSenders(env, mailbox, [
			{ sender: "eve@mail.build" },
			{ sender: "nobody@mail.build" },
			{ from: "alerts@gmail.com" },
			{ from: "" },
		]);
		expect(rows.map((r) => r.external_sender)).toEqual([true, true, true, true]);
	});

	it("resolves +tag and display form through one sender read", async () => {
		const { env, gets } = bucket({
			[mailbox]: { owner: same },
			"artin@mail.build": { owner: human },
		});
		const rows = await stampExternalSenders(env, `Postel+ci@mail.build`, [
			{ sender: "Artin <Artin+Shop@mail.build>" },
			{ from: "artin@mail.build" },
		]);
		expect(rows.map((r) => r.external_sender)).toEqual([false, false]);
		expect(gets.filter((k) => k === "mailboxes/artin@mail.build.json")).toHaveLength(1);
		expect(gets.filter((k) => k === "mailboxes/postel@mail.build.json")).toHaveLength(1);
	});

	it("fails closed when a settings read throws", async () => {
		const { env } = bucket({
			[mailbox]: "throw",
			"artin@mail.build": { owner: human },
		});
		const [row] = await stampExternalSenders(env, mailbox, [{ from: "artin@mail.build" }]);
		expect(row.external_sender).toBe(true);

		const senderDown = bucket({
			[mailbox]: { owner: same },
			"artin@mail.build": "throw",
		});
		const [hidden] = await stampExternalSenders(senderDown.env, mailbox, [{ from: "artin@mail.build" }]);
		expect(hidden.external_sender).toBe(true);
	});

	it("does not read settings for an empty list", async () => {
		const { env, gets } = bucket({ [mailbox]: { owner: same } });
		expect(await stampExternalSenders(env, mailbox, [])).toEqual([]);
		expect(gets).toEqual([]);
	});

	it("treats an unparsable owner as external", async () => {
		const { env } = bucket({
			[mailbox]: { owner: "local:admin" },
			"artin@mail.build": { owner: human },
		});
		const [row] = await stampExternalSenders(env, mailbox, [{ sender: "artin@mail.build" }]);
		expect(row.external_sender).toBe(true);
	});
});
