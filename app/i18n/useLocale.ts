import { useRouteLoaderData } from "react-router";
import { isLocale, type Locale } from "../../shared/locale";
import { uiCopy, type UiCopy } from "./ui";

export function useLocale(): Locale {
	const data = useRouteLoaderData("root") as { locale?: string } | undefined;
	return isLocale(data?.locale) ? data.locale : "en";
}

export function useUi(): UiCopy {
	return uiCopy[useLocale()];
}
