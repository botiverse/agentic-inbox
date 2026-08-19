import { defineConfig } from "vitest/config";

// Hermetic unit tests for worker logic (no Cloudflare bindings required).
// Full-stack integration tests (HTTP create + email() receive) against
// Miniflare bindings are tracked as a fast-follow via @cloudflare/vitest-pool-workers.
export default defineConfig({
	test: {
		// `shared/` is imported by BOTH the worker and the web UI, so its tests
		// must run too — the mailbox-identity rule lives there.
		include: ["workers/**/*.test.ts", "shared/**/*.test.ts"],
		environment: "node",
	},
});
