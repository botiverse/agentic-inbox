// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Visible label for `external_sender`. The API decides; this does not guess. */
export default function ExternalSenderMark({ external }: { external?: boolean }) {
	if (!external) return null;
	return (
		<span
			className="shrink-0 text-xs font-medium text-kumo-subtle"
			title="Not on this mailbox's Raft server"
		>
			External sender
		</span>
	);
}
