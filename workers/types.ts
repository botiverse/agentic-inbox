export type FlagshipBinding = Flagship;

export interface Env extends Cloudflare.Env {
	API_KEY?: string;
	RAFT_OAUTH_CLIENT_SECRET?: string;
	RAFT_SESSION_SECRET?: string;
	/** "1"/"true" enables inbound → Agent Inbox notify. Default off: code in ≠ delivery on. */
	AGENT_INBOX_NOTIFY_ENABLED?: string;
}
