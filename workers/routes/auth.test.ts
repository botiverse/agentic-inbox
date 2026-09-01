import { describe, it, expect } from "vitest";
import { authApp } from "./auth";

const raftEnv = {
	DOMAINS: "mail.build",
	ALLOWED_SERVER_IDS: "95f993fa-2a68-4797-b8ae-7beb7d984ada,172dbfbf-3e86-4a85-9331-d4c3f5c1c558,65598229-cd0a-4e92-96f3-c33e7e2e4cc1",
	PRO_SERVER_IDS: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
	RAFT_OAUTH_CLIENT_KEY: "agentic-inbox",
	RAFT_OAUTH_CLIENT_SECRET: "s3cret",
	RAFT_SESSION_SECRET: "test-session-secret-32-chars-long-abc",
	RAFT_API_ORIGIN: "https://api.raft.build",
	RAFT_APP_ORIGIN: "https://app.raft.build",
} as never;

const validUserinfo = {
	sub: "5af46a83-44d3-4a87-aea2-e1ac2f67c9a3",
	type: "agent",
	server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
	client_id: "agentic-inbox",
	preferred_username: "Friday",
	name: "Friday",
};

describe("Route-level /auth/raft/login contracts", () => {
	it("agent flow ?flow=agent returns 204 No Content without setting CSRF cookie", async () => {
		const res = await authApp.request("/auth/raft/login?flow=agent", { method: "GET" }, raftEnv);
		expect(res.status).toBe(204);
		expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_login_state=;");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("browser flow sets login state cookie and redirects 302 to Raft setup page", async () => {
		const res = await authApp.request("/auth/raft/login", { method: "GET" }, raftEnv);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("https://app.raft.build/login-with-raft/setup");
		expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_login_state=");
	});
});

describe("Route-level /auth/raft/callback contracts & error diagnostics", () => {
	it("agent callback with code returns 204 on success", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/oauth/token")) {
				return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.endsWith("/api/oauth/userinfo")) {
				return new Response(JSON.stringify(validUserinfo), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		try {
			const res = await authApp.request("/auth/raft/callback?code=req-12345", { method: "GET" }, raftEnv);
			expect(res.status).toBe(204);
			expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_session=");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns structured 403 on unauthorized server with error, errorCode, and suggestedNextAction", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/oauth/token")) {
				return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.endsWith("/api/oauth/userinfo")) {
				return new Response(JSON.stringify({ ...validUserinfo, server_id: "unauthorized-server-999" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		try {
			const res = await authApp.request("/auth/raft/callback?code=req-unauth", { method: "GET" }, raftEnv);
			expect(res.status).toBe(403);
			const body = await res.json() as { error: string; errorCode: string; suggestedNextAction?: string; reason?: string };
			expect(body.errorCode).toBe("RAFT_SERVER_NOT_ALLOWED");
			expect(body.reason).toBe("server_not_allowed");
			expect(body.error).toContain("unauthorized-server-999");
			expect(body.suggestedNextAction).toContain("ALLOWED_SERVER_IDS");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_login_state=;");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns structured 400 on missing code without network calls", async () => {
		const res = await authApp.request("/auth/raft/callback", { method: "GET" }, raftEnv);
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string; errorCode: string; suggestedNextAction?: string };
		expect(body.errorCode).toBe("RAFT_MISSING_CODE");
		expect(body.suggestedNextAction).toBeDefined();
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("returns 400 on state mismatch for browser flow and clears login state", async () => {
		const res = await authApp.request(
			"/auth/raft/callback?code=auth-code-123&state=presented-mismatch",
			{
				method: "GET",
				headers: { Cookie: "agentic_inbox_login_state=cookie-expected-state" },
			},
			raftEnv,
		);
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string; errorCode: string };
		expect(body.errorCode).toBe("RAFT_STATE_MISMATCH");
		expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_login_state=;");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("returns generic fail-closed 500 on unexpected runtime errors without leaking stack/details", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("SECRET_INTERNAL_DB_PASSWORD_LEAK_FAIL_CLOSED_CHECK_AT_10.0.0.1");
		}) as typeof fetch;

		try {
			const res = await authApp.request("/auth/raft/callback?code=req-crash", { method: "GET" }, raftEnv);
			expect(res.status).toBe(500);
			const body = await res.json() as { error: string; errorCode: string };
			expect(body.error).toBe("Login could not be completed. Please try again or contact the workspace owner.");
			expect(body.errorCode).toBe("LOGIN_FAILED");
			expect(JSON.stringify(body)).not.toContain("SECRET_INTERNAL_DB_PASSWORD");
			expect(res.headers.get("Set-Cookie")).toContain("agentic_inbox_login_state=;");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
