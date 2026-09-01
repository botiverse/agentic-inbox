export type FlagshipBinding = {
	getBooleanValue(flagKey: string, defaultValue: boolean, context?: Record<string, string | number | boolean>): Promise<boolean>;
	getStringValue(flagKey: string, defaultValue: string, context?: Record<string, string | number | boolean>): Promise<string>;
	getNumberValue?(flagKey: string, defaultValue: number, context?: Record<string, string | number | boolean>): Promise<number>;
	getObjectValue?<T>(flagKey: string, defaultValue: T, context?: Record<string, string | number | boolean>): Promise<T>;
};

export interface Env extends Cloudflare.Env {
	API_KEY?: string;
	RAFT_OAUTH_CLIENT_SECRET?: string;
	RAFT_SESSION_SECRET?: string;
	FLAGS?: FlagshipBinding;
}
