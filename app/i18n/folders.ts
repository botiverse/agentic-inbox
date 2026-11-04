import type { UiCopy } from "./ui";

/** System folder ids only. A name the user typed stays as stored. */
export function systemFolderLabel(
	ui: UiCopy,
	id: string | null | undefined,
): string | undefined {
	switch ((id ?? "").toLowerCase()) {
		case "inbox":
			return ui.inbox;
		case "sent":
			return ui.sent;
		case "draft":
		case "drafts":
			return ui.drafts;
		case "archive":
			return ui.archive;
		case "trash":
			return ui.trash;
		case "spam":
			return ui.spam;
		default:
			return undefined;
	}
}
