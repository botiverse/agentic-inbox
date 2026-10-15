import type { Context } from "hono";
import type { Env } from "../types";
import { attachmentObjectKeys, discardAttachmentObjects, type StoredAttachment } from "./attachments";
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
	rowKey?: string | null,
): Promise<StorageHold> {
	const stub = ownerStub(env, owner);
	if (plan) await stub.rememberPlan(plan);
	const effective = plan ?? (await stub.plan());
	const decision = await stub.reserveStorage(owner, bytes, storageLimitBytes(effective), deleteId || undefined, rowKey || undefined);
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
	session?: { owner?: string | null; plan?: SessionPlan | null; deleteId?: string | null; rowKey?: string | null },
): Promise<StorageHold> {
	const owner = await accountOwner(env, mailbox, session?.owner);
	return holdStorage(env, owner, bytes, session?.plan, session?.deleteId, session?.rowKey);
}

/** Keep the charge and the object keys when R2 cleanup cannot be confirmed.
 * `holdId` is retired with the record so a later cancel cannot credit those bytes too.
 * `deleteId` moves that prepared delete's refund, and the row's original create hold,
 * onto the orphan in one transaction. The sweep is the only subtract. */
export async function rememberOrphans(
	env: Env,
	owner: string,
	keys: string[],
	bytes: number,
	holdId?: string,
	deleteId?: string | null,
): Promise<void> {
	if (keys.length === 0 || bytes <= 0) return;
	await ownerStub(env, owner).retainOrphans(keys, bytes, holdId, deleteId || undefined);
}

type MeasurableMailbox = {
	measureEmailBytes?: (id: string) => Promise<number | null>;
};

/** Whether a createEmail whose reply was lost actually stored `id`. */
export type CreateWriteOutcome = "present" | "absent" | "unknown";

/** A thrown createEmail is not proof the row is missing.
 * A number means this id is stored. null means it is not stored now, which is
 * also true after another request deleted it and refunded the shared row charge.
 * A missing method or a thrown read is not absence: the reservation stays. */
export async function createWriteOutcome(
	stub: MeasurableMailbox | null | undefined,
	id: string,
): Promise<CreateWriteOutcome> {
	if (!id) return "unknown";
	const measure = stub?.measureEmailBytes;
	if (typeof measure !== "function") return "unknown";
	try {
		const bytes = await measure.call(stub, id);
		return bytes == null ? "absent" : "present";
	} catch {
		return "unknown";
	}
}

/** Commit when the row is present. On null, cancel only if this hold's row charge
 * was not already returned by its delete. A failed lookup leaves the reservation. */
export async function settleCreateHold(
	stub: MeasurableMailbox | null | undefined,
	id: string,
	hold: { release: () => Promise<void>; commit: () => Promise<void> } | null | undefined,
): Promise<CreateWriteOutcome> {
	const outcome = await createWriteOutcome(stub, id);
	if (outcome === "absent") await hold?.release();
	else if (outcome === "present") await hold?.commit();
	return outcome;
}

/** Same rule for a create that may already own attachment objects.
 * Objects are removed only after the row id is confirmed absent. A failed removal keeps the charge. */
export async function settleAttemptedCreate(
	env: Env,
	stub: MeasurableMailbox | null | undefined,
	rowId: string,
	hold: { owner: string; bytes: number; id: string; release: () => Promise<void>; commit: () => Promise<void> },
	attachments?: StoredAttachment[],
): Promise<CreateWriteOutcome> {
	const outcome = await createWriteOutcome(stub, rowId);
	if (outcome === "present") {
		await hold.commit();
		return outcome;
	}
	if (outcome === "unknown") return outcome;
	if (attachments && attachments.length > 0) {
		try {
			await discardAttachmentObjects(env.BUCKET, rowId, attachments);
		} catch (cleanupErr) {
			console.error("attachment cleanup failed:", (cleanupErr as Error).message);
			const keys = attachmentObjectKeys(rowId, attachments);
			if (keys.length > 0) {
				await rememberOrphans(env, hold.owner, keys, hold.bytes, hold.id).catch((err) => {
					console.error("orphan record failed:", (err as Error).message);
				});
			}
			return outcome;
		}
	}
	await hold.release();
	return outcome;
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
	rowKey?: string | null,
): Promise<StorageHold> {
	return holdMailboxBytes(c.env, mailbox, bytes, {
		owner: c.get("authOwner"),
		plan: c.get("authPlan"),
		deleteId,
		rowKey,
	});
}
