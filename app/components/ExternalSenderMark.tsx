// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useUi } from "~/i18n/useLocale";

/** Visible label for `external_sender`. The API decides; this does not guess. */
export default function ExternalSenderMark({ external }: { external?: boolean }) {
	const ui = useUi();
	if (!external) return null;
	return (
		<span
			className="shrink-0 text-xs font-medium text-kumo-subtle"
			title={ui.externalSenderTitle}
		>
			{ui.externalSender}
		</span>
	);
}
