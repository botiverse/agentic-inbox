import { defineConfig } from "vitest/config";

// Hermetic unit tests for worker logic (no Cloudflare bindings required).
// Full-stack integration tests (HTTP create + email() receive) against
// Miniflare bindings are tracked as a fast-follow via @cloudflare/vitest-pool-workers.
export default defineConfig({
	test: {
		include: ["workers/**/*.test.ts"],
		environment: "node",
	},
});
