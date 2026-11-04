import type { Locale } from "./locale";
import { planCopy } from "./planCopy";

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Signed-out home page. Self-contained, so it does not load the app bundle. */
export function renderLandingHtml(locale: Locale, loginHref: string): string {
	const copy = planCopy[locale];
	const rows = copy.rows
		.map(
			(row) =>
				`<tr><th>${row.label}</th><td>${row.free}</td><td>${row.pro}</td></tr>`,
		)
		.join("");
	const notes = copy.notes.map((note) => `<li>${note}</li>`).join("");
	const incoming = copy.incomingNotes.map((note) => `<li>${note}</li>`).join("");
	return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mail.build</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#fafafa;color:#111}
.wrap{min-height:100vh;display:flex;justify-content:center;padding:48px 24px}
.card{max-width:720px;width:100%}
.login{text-align:center}
h1{font-size:34px;line-height:1.15;margin:0 0 14px;font-weight:700}
.lead{font-size:16px;line-height:1.55;color:#444;margin:0 0 28px}
.btn{display:inline-flex;align-items:center;gap:8px;background:#111;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px}
.btn:hover{background:#000}
.langs{margin-top:16px;font-size:14px}
.langs a,.help{color:#111}
.langs a{margin:0 6px}
.help{display:inline-block;margin-top:8px;font-size:14px}
h2{font-size:16px;margin:36px 0 12px}
table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}
th,td{padding:10px 12px 10px 0;border-bottom:1px solid #e6e6e6;vertical-align:top}
th{font-weight:600}
.notes{margin:16px 0 0;padding-left:18px;color:#444;font-size:14px;line-height:1.55}
.notes li{margin:0 0 8px}
</style></head><body><div class="wrap"><div class="card"><div class="login"><h1>mail.build</h1><p class="lead">${copy.loginLead}</p><a class="btn" href="${escapeAttr(loginHref)}">${copy.loginButton} &rarr;</a><div class="langs"><a href="?lang=zh">中文</a><a href="?lang=en">English</a></div><div><a class="help" href="/docs">${copy.help}</a></div></div>
<h2>${copy.quota}</h2>
<table><thead><tr><th></th><th>${copy.free}</th><th>${copy.pro}</th></tr></thead><tbody>${rows}</tbody></table>
<ul class="notes">${notes}</ul>
<h2>${copy.incoming}</h2>
<ul class="notes">${incoming}</ul>
</div></div></body></html>`;
}
