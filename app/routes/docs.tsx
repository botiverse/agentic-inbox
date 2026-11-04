// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import LanguageSwitch from "~/components/LanguageSwitch";
import { useLocale } from "~/i18n/useLocale";
import { isLocale } from "../../shared/locale";
import { planCopy } from "../../shared/planCopy";

export function meta({
	matches,
}: {
	matches?: Array<{ id?: string; data?: unknown }>;
}) {
	const root = matches?.find((match) => match.id === "root");
	const data = root?.data as { locale?: string } | undefined;
	const locale = isLocale(data?.locale) ? data.locale : "en";
	return [{ title: planCopy[locale].helpTitle }];
}

export default function DocsRoute() {
	const copy = planCopy[useLocale()];
	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8 flex items-baseline justify-between gap-4">
					<h1 className="text-2xl font-bold text-kumo-default">mail.build</h1>
					<div className="flex items-baseline gap-4">
						<LanguageSwitch />
						{/* Full page load. A client-side link would open the mailbox list and call the API. */}
						<a href="/" className="text-sm text-kumo-subtle hover:text-kumo-default">
							{copy.mailboxes}
						</a>
					</div>
				</div>
				<article className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-6 text-sm text-kumo-default">
					<h2 className="text-base font-semibold">{copy.quota}</h2>
					<div className="mt-4 overflow-x-auto">
						<table className="w-full border-collapse text-left">
							<thead>
								<tr className="border-b border-kumo-line text-kumo-subtle">
									<th className="py-2 pr-3 font-medium"> </th>
									<th className="py-2 pr-3 font-medium">{copy.free}</th>
									<th className="py-2 font-medium">{copy.pro}</th>
								</tr>
							</thead>
							<tbody>
								{copy.rows.map((row) => (
									<tr key={row.label} className="border-b border-kumo-line">
										<th className="py-2 pr-3 font-medium">{row.label}</th>
										<td className="py-2 pr-3">{row.free}</td>
										<td className="py-2">{row.pro}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<ul className="mt-4 list-disc space-y-2 pl-5 text-kumo-subtle">
						{copy.notes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
					<h2 className="mt-8 text-base font-semibold">{copy.incoming}</h2>
					<ul className="mt-4 list-disc space-y-2 pl-5 text-kumo-subtle">
						{copy.incomingNotes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				</article>
			</div>
		</div>
	);
}
