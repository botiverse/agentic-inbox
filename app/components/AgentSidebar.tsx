// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { useUi } from "~/i18n/useLocale";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState(false);
	const ui = useUi();

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError(true);
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{ui.loadAgentFailed}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">{ui.loadingAgent}</span>
			</div>
		);
	}
	return <AgentChat />;
}

export default function AgentSidebar() {
	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 min-h-0 overflow-hidden">
				<LazyAgentPanel />
			</div>
		</div>
	);
}
