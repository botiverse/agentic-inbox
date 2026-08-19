// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Build-time constants injected by Vite `define` (see vite.config.ts). `typeof`
// guards keep this safe if a build path ever skips the define (never throws —
// `typeof` on an unresolved identifier yields "undefined").
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA: string =
	typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "unknown";
export const BUILD_TIME: string =
	typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "unknown";
