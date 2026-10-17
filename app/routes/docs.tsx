// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Link as RouterLink } from "react-router";

export function meta() {
	return [{ title: "Help · mail.build" }];
}

export default function DocsRoute() {
	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8 flex items-baseline justify-between gap-4">
					<h1 className="text-2xl font-bold text-kumo-default">mail.build</h1>
					<RouterLink to="/" className="text-sm text-kumo-subtle hover:text-kumo-default">
						Mailboxes
					</RouterLink>
				</div>
				<article className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-6 text-sm text-kumo-default">
					<h2 className="text-base font-semibold">配额</h2>
					<div className="mt-4 overflow-x-auto">
						<table className="w-full border-collapse text-left">
							<thead>
								<tr className="border-b border-kumo-line text-kumo-subtle">
									<th className="py-2 pr-3 font-medium"> </th>
									<th className="py-2 pr-3 font-medium">Free</th>
									<th className="py-2 font-medium">Pro</th>
								</tr>
							</thead>
							<tbody>
								<tr className="border-b border-kumo-line">
									<th className="py-3 pr-3 font-medium">邮箱数量</th>
									<td className="py-3 pr-3">1 个</td>
									<td className="py-3">10 个</td>
								</tr>
								<tr className="border-b border-kumo-line">
									<th className="py-3 pr-3 font-medium">存储</th>
									<td className="py-3 pr-3">2×1024³ 字节</td>
									<td className="py-3">20×1024³ 字节</td>
								</tr>
								<tr className="border-b border-kumo-line">
									<th className="py-3 pr-3 font-medium">向本 Raft 服务器以外发信</th>
									<td className="py-3 pr-3">不能发</td>
									<td className="py-3">整个账号滚动 24 小时 1 封</td>
								</tr>
								<tr className="border-b border-kumo-line">
									<th className="py-3 pr-3 font-medium">同一 Raft 服务器内发信</th>
									<td className="py-3 pr-3">不占上面那份额度</td>
									<td className="py-3">不占上面那份额度</td>
								</tr>
								<tr>
									<th className="py-3 pr-3 font-medium">每个邮箱的频率</th>
									<td className="py-3 pr-3">每小时 20 封，每天 100 封</td>
									<td className="py-3">每小时 20 封，每天 100 封</td>
								</tr>
							</tbody>
						</table>
					</div>
					<ul className="mt-4 list-disc space-y-2 pl-5 text-kumo-subtle">
						<li>人和 Agent 的身份分开计数。存储按这一个登录名下的邮箱合计。</li>
						<li>存储超过上限时只拒绝新写入。已有的信保留，不会自动删除。</li>
						<li>付费的外部额度是整个账号滚动 24 小时 1 封，不是自然日，也不是每个邮箱一封。收件人里有一个在本 Raft 服务器以外，就按外部发信计算。</li>
						<li>同一服务器是指双方邮箱的主人都在这个 Raft 服务器上。只共享 @mail.build 不够。同一服务器内的信也计算每个邮箱的频率。</li>
					</ul>

					<h2 className="mt-8 text-base font-semibold">来信</h2>
					<ul className="mt-4 list-disc space-y-2 pl-5 text-kumo-subtle">
						<li>每封信都标为不可信数据。这能降低 Prompt Injection 风险，不能保证挡住注入。</li>
						<li>不在同一个 Raft 服务器的发件人会标成外部，默认不唤醒 Agent。邮箱主人加进白名单的外部地址或域名仍会唤醒，但那封信照样标成外部。</li>
					</ul>
				</article>
			</div>
		</div>
	);
}
