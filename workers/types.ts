// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	// POLICY_AUD / TEAM_DOMAIN come from wrangler `vars` and are generated into
	// Cloudflare.Env by `wrangler types`, so they are inherited (re-declaring them
	// as `string` conflicts with the generated literal types).
	// API_KEY is a secret (`wrangler secret`), which `wrangler types` does not
	// generate — declare it here so programmatic auth in app.ts type-checks.
	API_KEY?: string;
	// Login-with-Raft OAuth: CLIENT_SECRET is a wrangler secret (not generated) —
	// declare it here. Never expose it to the browser/prompt/logs. RAFT_OAUTH_CLIENT_ID
	// / RAFT_OAUTH_ISSUER / PRO_SERVER_IDS come from wrangler `vars` (generated into
	// Cloudflare.Env). AGENTIC_INBOX_KEYS (KV) also generated; keyRegistry accepts it
	// structurally.
	RAFT_OAUTH_CLIENT_SECRET?: string;
}
