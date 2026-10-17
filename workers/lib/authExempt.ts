// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Paths that skip the login gate.
 *
 * The help page is public. It has no mailbox data. The document at `/docs`
 * loads `/favicon.ico`, `/favicon.svg`, and the Vite client files under
 * `/assets/`. Those files are the same for every visitor.
 *
 * `/`, mailbox pages, and `/api` stay behind login. Pass a WHATWG URL
 * pathname: `new URL(request.url).pathname` already resolves `..`.
 */
export function isAuthExemptPath(pathname: string): boolean {
	return (
		pathname.startsWith("/auth/raft/") ||
		pathname === "/auth/callback" ||
		pathname === "/.well-known/raft-agent-manifest.json" ||
		pathname === "/health" ||
		pathname === "/docs" ||
		pathname === "/favicon.ico" ||
		pathname === "/favicon.svg" ||
		pathname.startsWith("/assets/")
	);
}
