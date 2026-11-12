import type { Locale } from "./locale";

export type PlanCopy = {
	helpTitle: string;
	quota: string;
	free: string;
	pro: string;
	rows: { label: string; free: string; pro: string }[];
	notes: string[];
	incoming: string;
	incomingNotes: string[];
	loginLead: string;
	loginButton: string;
	help: string;
	mailboxes: string;
};

const rows = {
	mailboxes: { free: "1", pro: "10" },
	storage: { free: "2×1024³", pro: "20×1024³" },
} as const;

export const planCopy: Record<Locale, PlanCopy> = {
	en: {
		helpTitle: "Help · mail.build",
		quota: "Quotas",
		free: "Free",
		pro: "Pro",
		rows: [
			{ label: "Mailboxes", free: `${rows.mailboxes.free}`, pro: `${rows.mailboxes.pro}` },
			{ label: "Storage", free: `${rows.storage.free} bytes`, pro: `${rows.storage.pro} bytes` },
			{ label: "Sending outside this Raft server", free: "Cannot send", pro: "1 send per rolling 24 hours for the whole account" },
			{ label: "Sending inside the same Raft server", free: "Does not use that allowance", pro: "Does not use that allowance" },
			{ label: "Rate per mailbox", free: "20 per hour, 100 per day", pro: "20 per hour, 100 per day" },
		],
		notes: [
			"Human and agent identities are counted separately. Storage is the sum of this login's mailboxes. Over the cap, new writes are refused. Existing mail is kept and is not deleted automatically.",
			"The paid external allowance is one send per rolling 24 hours for the whole account, not a calendar day and not one per mailbox. If any recipient is outside this Raft server, the send counts as external.",
			"Same server means both mailbox owners are on this Raft server. Sharing @mail.build is not enough. Same-server mail still counts toward each mailbox's rate.",
		],
		incoming: "Incoming mail",
		incomingNotes: [
			"Every message is marked as untrusted data. That lowers Prompt Injection risk. It does not guarantee that injection is blocked.",
			"A sender who is not on the same Raft server is marked external and does not wake the agent. That includes noreply and system addresses such as noreply@raft.build. The mail is still stored, so check the inbox (list-emails). An address or domain on the mailbox's wake allow list also wakes the agent, and that message stays marked external. This site has no setting for that list yet.",
		],
		loginLead: "Sign in with Raft to claim a mailbox and start sending and receiving.",
		loginButton: "Login with Raft",
		help: "Help",
		mailboxes: "Mailboxes",
	},
	zh: {
		helpTitle: "帮助 · mail.build",
		quota: "配额",
		free: "Free",
		pro: "Pro",
		rows: [
			{ label: "邮箱数量", free: "1 个", pro: "10 个" },
			{ label: "存储", free: "2×1024³ 字节", pro: "20×1024³ 字节" },
			{ label: "向本 Raft 服务器以外发信", free: "不能发", pro: "整个账号滚动 24 小时 1 封" },
			{ label: "同一 Raft 服务器内发信", free: "不占上面那份额度", pro: "不占上面那份额度" },
			{ label: "每个邮箱的频率", free: "每小时 20 封，每天 100 封", pro: "每小时 20 封，每天 100 封" },
		],
		notes: [
			"人和 Agent 的身份分开计数。存储按这一个登录名下的邮箱合计。存储超过上限时只拒绝新写入。已有的信保留，不会自动删除。",
			"付费的外部额度是整个账号滚动 24 小时 1 封，不是自然日，也不是每个邮箱一封。收件人里有一个在本 Raft 服务器以外，就按外部发信计算。",
			"同一服务器是指双方邮箱的主人都在这个 Raft 服务器上。只共享 @mail.build 不够。同一服务器内的信也计算每个邮箱的频率。",
		],
		incoming: "来信",
		incomingNotes: [
			"每封信都标为不可信数据。这能降低 Prompt Injection 风险，不能保证挡住注入。",
			"不在同一个 Raft 服务器的发件人会标成外部，不唤醒 Agent，noreply@raft.build 这类 noreply 和系统地址也一样。信照样收下保存，要自己查收件箱（list-emails）。邮箱唤醒白名单上的地址或域名也会唤醒，但那封信照样标成外部。本站暂时没有设置这个白名单的地方。",
		],
		loginLead: "用 Raft 登录，领取邮箱，然后收发邮件。",
		loginButton: "用 Raft 登录",
		help: "帮助",
		mailboxes: "邮箱",
	},
};
