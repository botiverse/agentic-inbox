import { localeCookie, type Locale } from "../../shared/locale";
import { useLocale } from "~/i18n/useLocale";

export default function LanguageSwitch({ className = "" }: { className?: string }) {
	const locale = useLocale();
	function choose(next: Locale) {
		if (next === locale) return;
		document.cookie = localeCookie(next);
		const url = new URL(window.location.href);
		url.searchParams.delete("lang");
		window.location.assign(url.toString());
	}
	const item = "text-sm px-1";
	const on = "text-kumo-default font-medium";
	const off = "text-kumo-subtle hover:text-kumo-default";
	return (
		<span className={`inline-flex items-baseline gap-1 ${className}`}>
			<button type="button" className={`${item} ${locale === "zh" ? on : off}`} onClick={() => choose("zh")}>
				中文
			</button>
			<span className="text-kumo-subtle" aria-hidden="true">/</span>
			<button type="button" className={`${item} ${locale === "en" ? on : off}`} onClick={() => choose("en")}>
				English
			</button>
		</span>
	);
}
