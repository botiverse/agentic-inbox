import type { Context } from "hono";
import type { Env } from "../types";
import type { MailboxContext } from "./mailbox";
import { readMailboxSettings } from "./mailboxRef";
import { attachmentRecordBytes, storageLimitBytes, storedMailBytes, storedRowBytes, type StorageAdmission } from "./storageQuota";

export { attachmentRecordBytes, storedMailBytes, storedRowBytes, storageLimitBytes };

type SessionPlan = "free" | "pro";

export type StorageHold =
	| { ok: false; used: number; limit: number }
	| {
			ok: true;
			owner: string;
			bytes: number;
			id: string;
			release: () => Promise<void>;
			commit: () => Promise<void>;
	  };

function ownerStub(env: Env, owner: string) {
	return env.OWNER.get(env.OWNER.idFromName(owner));
}

/** The account that pays for a mailbox. Ownerless mailboxes get their own free cap. */
export async function accountOwner(env: Env, mailbox: string, explicit?: string | null): Promise<string> {
	if (explicit) return explicit;
	const settings = await readMailboxSettings<{ owner?: string }>(env, mailbox);
	return settings?.owner || `mailbox:${mailbox}`;
}

export async function holdStorage(
	env: Env,
	owner: string,
	bytes: number,
	plan?: SessionPlan | null,
	deleteId?: string | null,
): Promise<StorageHold> {
	const stub = ownerStub(env, owner);
	if (plan) await stub.rememberPlan(plan);
	const effective = plan ?? (await stub.plan());
	const decision = await stub.reserveStorage(owner, bytes, storageLimitBytes(effective), deleteId || undefined);
	if (!decision.ok) return { ok: false, used: decision.used, limit: decision.limit };
	const id = decision.id ?? "";
	let settled = false;
	return {
		ok: true,
		owner,
		bytes,
		id,
		release: async () => {
			if (settled || bytes <= 0 || !id) return;
			settled = true;
			await stub.cancelStorage(owner, id);
		},
		commit: async () => {
			if (settled || bytes <= 0 || !id) return;
			settled = true;
			await stub.commitStorage(owner, id);
		},
	};
}

/** Record a delete before the row is removed. Complete or abort that id exactly once.
 * `rowKey` is the row whose bytes a replacement may spend. Other writes cannot. */
export async function beginStorageDelete(
	env: Env,
	owner: string,
	bytes: number,
	rowKey?: string,
): Promise<string | null> {
	if (bytes <= 0) return null;
	const opened = await ownerStub(env, owner).openStorageDelete(owner, bytes, rowKey);
	return opened.id || null;
}

export async function finishStorageDelete(env: Env, owner: string, id: string | null): Promise<void> {
	if (!id) return;
	await ownerStub(env, owner).completeStorageDelete(owner, id);
}

export async function abortStorageDelete(env: Env, owner: string, id: string | null): Promise<void> {
	if (!id) return;
	await ownerStub(env, owner).abortStorageDelete(owner, id);
}

export async function holdMailboxBytes(
	env: Env,
	mailbox: string,
	bytes: number,
	session?: { owner?: string | null; plan?: SessionPlan | null; deleteId?: string | null },
): Promise<StorageHold> {
	const owner = await accountOwner(env, mailbox, session?.owner);
	return holdStorage(env, owner, bytes, session?.plan, session?.deleteId);
}

/** Keep the charge and the object keys when R2 cleanup cannot be confirmed.
 * `holdId` is retired with the record so a later cancel cannot credit those bytes too. */
export async function rememberOrphans(
	env: Env,
	owner: string,
	keys: string[],
	bytes: number,
	holdId?: string,
): Promise<void> {
	if (keys.length === 0 || bytes <= 0) return;
	await ownerStub(env, owner).retainOrphans(keys, bytes, holdId);
}

export function storageQuotaResponse(decision: Extract<StorageHold, { ok: false }> | StorageAdmission): Response {
	return Response.json(
		{
			code: "STORAGE_QUOTA_EXCEEDED",
			error: "Account storage quota exceeded. Delete mail to free space. Existing mail is kept.",
			used: decision.used,
			limit: decision.limit,
		},
		{ status: 413 },
	);
}

export async function chargeSessionWrite(
	c: Context<MailboxContext>,
	mailbox: string,
	bytes: number,
	deleteId?: string | null,
): Promise<StorageHold> {
	return holdMailboxBytes(c.env, mailbox, bytes, {
		owner: c.get("authOwner"),
		plan: c.get("authPlan"),
		deleteId,
	});
}
