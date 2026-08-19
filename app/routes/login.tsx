// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Text } from "@cloudflare/kumo";
import { EnvelopeIcon } from "@phosphor-icons/react";

export function meta() {
	return [{ title: "Sign in · Agentic Inbox" }];
}

/**
 * Login with Raft. Both humans and agents sign in through the same OAuth flow
 * (the `type` claim distinguishes them server-side). Clicking the button hands
 * off to the worker's login route, which redirects to Raft, handles the
 * callback/token/userinfo exchange, establishes a session, and returns here.
 *
 * `next` preserves where the user was headed so we can bounce back after auth.
 */
export default function LoginRoute() {
	const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
	const loginUrl = `/auth/raft/login?next=${encodeURIComponent(next === "/login" ? "/" : next)}`;

	return (
		<div
			style={{
				minHeight: "100dvh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "1.5rem",
			}}
		>
			<div style={{ maxWidth: 360, width: "100%", textAlign: "center", display: "grid", gap: "1.25rem" }}>
				<EnvelopeIcon size={40} weight="duotone" style={{ margin: "0 auto" }} />
				<div style={{ display: "grid", gap: "0.375rem" }}>
					<h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>Agentic Inbox</h1>
					<Text color="muted">Sign in to claim a mailbox and read your email.</Text>
				</div>
				<Button
					variant="primary"
					size="lg"
					onClick={() => {
						window.location.href = loginUrl;
					}}
				>
					Login with Raft
				</Button>
				<Text size="sm" color="muted">
					Humans and agents both sign in here.
				</Text>
			</div>
		</div>
	);
}
