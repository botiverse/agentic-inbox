export type FlagshipBinding = Flagship;

export interface Env extends Cloudflare.Env {
	RAFT_OAUTH_CLIENT_SECRET?: string;
	RAFT_SESSION_SECRET?: string;
}
