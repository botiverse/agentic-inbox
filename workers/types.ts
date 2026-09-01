export interface FlagshipEvaluationDetails<T> {
	flagKey: string;
	value: T;
	variant?: string;
	reason?: string; // "TARGETING_MATCH" | "DEFAULT" | "DISABLED" | "SPLIT"
	errorCode?: string;
	errorMessage?: string;
}

export interface FlagshipBinding {
	getBooleanValue(flagKey: string, defaultValue: boolean, context?: Record<string, string | number | boolean>): Promise<boolean>;
	getStringValue(flagKey: string, defaultValue: string, context?: Record<string, string | number | boolean>): Promise<string>;
	getNumberValue?(flagKey: string, defaultValue: number, context?: Record<string, string | number | boolean>): Promise<number>;
	getObjectValue?<T>(flagKey: string, defaultValue: T, context?: Record<string, string | number | boolean>): Promise<T>;
	getBooleanDetails?(flagKey: string, defaultValue: boolean, context?: Record<string, string | number | boolean>): Promise<FlagshipEvaluationDetails<boolean>>;
	getStringDetails?(flagKey: string, defaultValue: string, context?: Record<string, string | number | boolean>): Promise<FlagshipEvaluationDetails<string>>;
}

export interface Env extends Cloudflare.Env {
	API_KEY?: string;
	RAFT_OAUTH_CLIENT_SECRET?: string;
	RAFT_SESSION_SECRET?: string;
	FLAGS?: FlagshipBinding;
}
