// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Empty } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { data, useNavigate } from "react-router";
import LanguageSwitch from "~/components/LanguageSwitch";
import { useUi } from "~/i18n/useLocale";

// The splat route matches, so the document would otherwise be HTTP 200.
export function loader() {
	return data(null, { status: 404 });
}

export default function NotFoundRoute() {
	const navigate = useNavigate();
	const ui = useUi();

	return (
		<div className="flex min-h-screen flex-col items-center justify-center gap-4">
			<LanguageSwitch />
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={ui.notFoundTitle}
				description={ui.notFoundDescription}
				contents={
					<Button variant="primary" size="sm" onClick={() => navigate("/")}>
						{ui.goHome}
					</Button>
				}
			/>
		</div>
	);
}
