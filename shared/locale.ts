export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "mb_lang";

export function isLocale(value: string | null | undefined): value is Locale {
	return value === "en" || value === "zh";
}

/** First matching language tag. Chinese wins over a later English tag. */
export function localeFromAcceptLanguage(header: string | null): Locale {
	if (!header) return "en";
	for (const part of header.split(",")) {
		const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
		if (tag.startsWith("zh")) return "zh";
		if (tag.startsWith("en")) return "en";
	}
	return "en";
}

/** Query `lang` wins, then the cookie, then Accept-Language. */
export function localeFromRequest(request: Request): Locale {
	const url = new URL(request.url);
	const query = url.searchParams.get("lang");
	if (isLocale(query)) return query;
	const cookie = request.headers.get("cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(en|zh)(?:;|$)`));
	if (match && isLocale(match[1])) return match[1];
	return localeFromAcceptLanguage(request.headers.get("accept-language"));
}

export function localeCookie(locale: Locale): string {
	return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
