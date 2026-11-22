// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createRaftHostAutoSignIn, type RaftHostAutoSignIn } from "@botiverse/raft-sdk/app";
import { openSession } from "./session";
import { isAuthExemptPath } from "./authExempt";

/** The browser Login-with-Raft entry; the landing page CTA points here too. */
export const RAFT_LOGIN_PATH = "/auth/raft/login";

/** Env pieces this module reads (a subset of the worker Env). */
export interface RaftHostSignInEnv {
	RAFT_SESSION_SECRET?: string;
}

/**
 * Opening Mail from a Raft App entry (Desktop, iOS, Android) sends
 * `Raft-Host` on the page load. A visitor with no session then goes straight
 * to Login with Raft instead of the landing page; Raft approves silently once
 * they have agreed before (#proj-workspace:#354). Without the header nothing
 * changes. Public paths (help page, assets, auth routes) never redirect.
 *
 * The SDK owns the loop guards: one try per 10 minutes (guard cookie), no
 * redirect on `?error=` or an OAuth callback, and `Vary: Raft-Host` on pages.
 *
 * Mail has no logout route today. One added later must also send
 * `raftHostAutoSignIn(env).logoutCookie()` next to `clearSessionCookie`, or a
 * Raft-Host visitor who signs out is signed straight back in.
 */
export function raftHostAutoSignIn(env: RaftHostSignInEnv): RaftHostAutoSignIn {
	const secret = env.RAFT_SESSION_SECRET;
	return createRaftHostAutoSignIn({
		loginUrl: ({ url }) => `${RAFT_LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`,
		isAuthenticated: async (request) => Boolean(secret) && (await openSession(request as Request, secret as string)) !== null,
		shouldHandle: ({ url }) => !isAuthExemptPath(url.pathname),
	});
}

/**
 * Wrap the worker `fetch`. Only active when Login with Raft is configured
 * (mail.build) and not in local dev (the auth gate is off there too); the
 * legacy Cloudflare Access deployment is left as it was.
 */
export function withRaftHostAutoSignIn<E extends RaftHostSignInEnv, Rest extends unknown[]>(
	isConfigured: (env: E) => boolean,
	fetch: (request: Request, env: E, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, env: E, ...rest: Rest) => Promise<Response> {
	return async (request, env, ...rest) => {
		if (!isConfigured(env)) return fetch(request, env, ...rest);
		return raftHostAutoSignIn(env).handle((req: Request) => fetch(req, env, ...rest))(request);
	};
}
