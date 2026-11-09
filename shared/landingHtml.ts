import type { Locale } from "./locale";
import { planCopy } from "./planCopy";

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Each language in its own name, for the language menu. */
const LANGUAGE_NAMES: Record<Locale, string> = { zh: "中文", en: "English" };
const LANGUAGE_LABEL: Record<Locale, string> = { zh: "语言", en: "Language" };

/** A count or a size ("1 个", "2×1024³ bytes") is set in the monospace face. */
const NUMERIC_VALUE = /^[0-9×³]+(?: (?:个|bytes|字节))?$/;

/*
 * raft.build's look, from @botiverse/raft-ui tokens: Space Grotesk and Space
 * Mono (public/fonts, OFL), ink borders, the attention pink for the one action.
 * As raft-design's Elevation says, controls and cards cast no shadow (hover and
 * press lay an ink overlay); only the envelope illustration has the hard 4px
 * sticker shadow. Below 760px the quota table becomes one block per row.
 */
const STYLE = `
@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/space-grotesk-latin-ext.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/space-grotesk-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/space-mono-400-latin.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/space-mono-700-latin.woff2) format("woff2")}
:root{color-scheme:light;--ink:oklch(.1813 .005 17.62);--cream:oklch(.986 .015 86.39);--paper:#fff;--yellow:oklch(.8829 .1623 91.9);--pink:oklch(.7999 .1308 354.26);--cyan:oklch(.783 .135 219.2);--muted:color-mix(in oklch,var(--ink) 72%,var(--cream));--sans:"Space Grotesk","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;--mono:"Space Mono",ui-monospace,"SF Mono",Menlo,monospace;--line:3px;--over:oklch(.1813 .005 17.62/.078);--over-sticker:oklch(.1813 .005 17.62/.1);--soft:color-mix(in oklch,var(--yellow) 28%,#fff);--float:0 0 0 1px oklch(.1813 .005 17.62/.12),0 1px 0 oklch(.1813 .005 17.62/.039),0 12px 32px -12px oklch(.1813 .005 17.62/.322)}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:400 17px/1.6 var(--sans)}
a{color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:20px 24px 72px}
.top{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;height:34px;padding:0 14px;border:2px solid var(--ink);border-radius:999px;background:var(--paper);color:var(--ink);font:700 14px/1 var(--sans);text-decoration:none}
.chip[aria-current]{background:var(--yellow)}
.chip.help{margin-left:0}.lang{position:relative}.lang summary{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px 0 14px;border:2px solid var(--ink);border-radius:999px;background:var(--paper);font:700 14px/1 var(--sans);cursor:pointer;list-style:none;user-select:none}.lang summary::-webkit-details-marker{display:none}.lang summary:hover,.lang[open] summary{background-image:linear-gradient(var(--over),var(--over))}.lang summary:focus-visible{outline:3px solid var(--ink);outline-offset:4px}.lang .chev{width:16px;height:16px}.lang[open] .chev{transform:rotate(180deg)}.lang-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:10;min-width:168px;margin:0;padding:4px;list-style:none;background:var(--paper);border-radius:10px;box-shadow:var(--float)}.lang-menu a{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;padding:0 10px;border-radius:6px;color:var(--ink);font:500 15px/1.2 var(--sans);text-decoration:none}.lang-menu a:hover,.lang-menu a:focus-visible{background:var(--soft);outline:none}.lang-menu a[aria-current]{font-weight:700}.lang-menu .check{width:16px;height:16px;flex:none}
.hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:40px;align-items:center;padding:56px 0 64px}
h1{margin:0 0 18px;font:700 clamp(54px,8.4vw,104px)/.95 var(--sans);letter-spacing:-.04em}
.lead{margin:0 0 32px;max-width:30em;font-size:20px;line-height:1.5}
.btn{display:inline-flex;align-items:center;gap:10px;padding:13px 26px;border:var(--line) solid var(--ink);border-radius:999px;background:var(--pink);color:var(--ink);font:700 18px/1.2 var(--sans);text-decoration:none;white-space:nowrap}
@media (hover:hover){.btn:hover{background-image:linear-gradient(var(--over-sticker),var(--over-sticker))}.chip:hover{background-image:linear-gradient(var(--over),var(--over))}}
.btn:active{background-image:linear-gradient(var(--over-sticker),var(--over-sticker))}
.chip:active{background-image:linear-gradient(var(--over),var(--over))}
.btn:focus-visible,.chip:focus-visible{outline:3px solid var(--ink);outline-offset:4px}
.art{position:relative;justify-self:center;width:min(380px,100%);aspect-ratio:19/14}
.envelope{position:absolute;inset:10% 4% 4% 0;transform:rotate(-4deg)}
.envelope svg{display:block;width:100%;height:100%;overflow:visible}
.stamp{position:absolute;top:0;right:0;width:30%;aspect-ratio:5/6;padding:9px;background:var(--yellow);transform:rotate(7deg);-webkit-mask:radial-gradient(circle 5px,#0000 96%,#000) -7px -7px/14px 14px round,linear-gradient(#000 0 0) 7px 7px/calc(100% - 14px) calc(100% - 14px) no-repeat;mask:radial-gradient(circle 5px,#0000 96%,#000) -7px -7px/14px 14px round,linear-gradient(#000 0 0) 7px 7px/calc(100% - 14px) calc(100% - 14px) no-repeat}
.stamp span{display:block;height:100%;border:var(--line) solid var(--ink);border-radius:6px;background:var(--cream) url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAC2UlEQVR42u3duxGCUBBAUXAITfilpBZgDVRNCxRgTMpAQgHYgaPRDu45DTxY39xZI8rHfJxFoG0cCsiqnZbQ829+AshLAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAgF+VXV2fReLvo2/jEHr+uu+pL2DfNIX7ZwMABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAEABAAQAAAAQAEABAAQAAAAQAEABAAQAAAAQAEALiAKvoBXs976Pm9O5Ba9vtnAwB/AQABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAL5WdnV9GgPYAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQA+Kh8zMcZ+QDbOIQOYN330PP7pkl9AbPPv50WGwAgAIAAAAIACAAgAIAAAAIACAAgAIAAAAIACAAgAIAAAAIACAAgACAARgACAAgAIACAAAACAAgAIACAAAACAAgAIACAAADXUGUfQPT34c3f/G0AgAAAAgAIACAAgAAAAgAIACAAgAAAAgAIACAAgAAAAgAIACAAgACAAAACAAgAIACAAAACAAgAIACAAAACAAgAIACAAACXUBlBrHZaUr//Ng4ugQ0AEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEABAAAABAAQAEAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQAEAAAAEABAAQABAAQAAAAQAEABAAQAAAAQAEAPgPb6aRJQHMbZ5RAAAAAElFTkSuQmCC) center/72% no-repeat;image-rendering:pixelated}
.mark{position:absolute;top:20%;right:20%;width:34%;transform:rotate(-8deg)}
.card{margin:0 0 36px;padding:32px clamp(20px,4vw,40px) 30px;border:var(--line) solid var(--ink);border-radius:22px;background:var(--paper);}
h2{display:inline-block;margin:0 0 20px;padding:2px 14px;border:var(--line) solid var(--ink);border-radius:10px;background:var(--yellow);font:700 22px/1.3 var(--sans);letter-spacing:-.01em;transform:rotate(-1.5deg)}
.incoming h2{background:var(--cyan)}
table{width:100%;border-collapse:collapse;text-align:left;font-size:16px}
thead th{padding:0 12px 12px 0;border-bottom:var(--line) solid var(--ink);font:700 12px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase}
tbody th,tbody td{padding:14px 12px 14px 0;border-bottom:2px dotted color-mix(in oklch,var(--ink) 35%,transparent);vertical-align:top}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
tbody th{width:34%;font-weight:700}
tbody td{width:33%}
.num{font-family:var(--mono)}
.notes{margin:20px 0 0;padding:0;list-style:none;color:var(--muted);font-size:15px;line-height:1.6}
.notes li{position:relative;margin:0 0 10px;padding-left:22px}
.notes li::before{content:"";position:absolute;left:2px;top:.6em;width:8px;height:8px;background:var(--ink)}
.incoming .notes{margin:0}
@media (max-width:760px){.chip,.lang summary{height:44px}.lang-menu a{min-height:44px}
.hero{grid-template-columns:1fr;gap:28px;padding:32px 0 44px}
.art{width:min(300px,86%);order:-1}
table,tbody,tr,th,td{display:block;width:auto}
thead{display:none}
tbody tr{padding:14px 0;border-bottom:2px dotted color-mix(in oklch,var(--ink) 35%,transparent)}
tbody tr:last-child{border-bottom:0}
tbody th,tbody td{padding:2px 0;border:0}
tbody th{width:auto;margin-bottom:6px}
tbody td{display:grid;grid-template-columns:3.6em minmax(0,1fr);gap:12px;width:auto}
tbody td::before{content:attr(data-plan);font:700 12px/1.9 var(--mono);letter-spacing:.08em;text-transform:uppercase}
}
@media (prefers-reduced-motion:reduce){.btn,.chip{transition:none}}
`;

const ENVELOPE = `<svg viewBox="0 0 300 200" aria-hidden="true" focusable="false"><rect x="5" y="5" width="290" height="188" rx="12" fill="var(--ink)"/><rect x="2" y="2" width="290" height="188" rx="12" fill="var(--paper)" stroke="var(--ink)" stroke-width="3"/><path d="M6 8 147 112 288 8" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/><path d="M6 186 116 92M288 186 178 92" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round"/></svg>`;
const MARK = `<svg viewBox="0 0 120 60" aria-hidden="true" focusable="false"><circle cx="30" cy="30" r="24" fill="none" stroke="var(--ink)" stroke-width="2.5" opacity=".55"/><path d="M58 14q10-6 20 0t20 0 20 0M58 30q10-6 20 0t20 0 20 0M58 46q10-6 20 0t20 0 20 0" fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round" opacity=".55"/></svg>`;
const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg class="check" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Closes the language menu on a click outside it or on Escape. */
const MENU_SCRIPT = `addEventListener("click",function(e){document.querySelectorAll("details.lang[open]").forEach(function(d){if(!d.contains(e.target))d.open=false})});addEventListener("keydown",function(e){if(e.key==="Escape")document.querySelectorAll("details.lang[open]").forEach(function(d){d.open=false;d.querySelector("summary").focus()})})`;

function languageMenu(locale: Locale): string {
	const items = (Object.keys(LANGUAGE_NAMES) as Locale[])
		.map((code) => {
			const current = code === locale;
			return `<li><a href="?lang=${code}" lang="${code}" hreflang="${code}"${current ? ' aria-current="true"' : ""}>${LANGUAGE_NAMES[code]}${current ? CHECK : ""}</a></li>`;
		})
		.join("");
	return `<details class="lang"><summary aria-label="${LANGUAGE_LABEL[locale]}：${LANGUAGE_NAMES[locale]}" title="${LANGUAGE_LABEL[locale]}"><span>${LANGUAGE_NAMES[locale]}</span>${CHEVRON}</summary><ul class="lang-menu">${items}</ul></details>`;
}

/** Signed-out home page. Self-contained, so it does not load the app bundle. */
export function renderLandingHtml(locale: Locale, loginHref: string): string {
	const copy = planCopy[locale];
	const cell = (plan: string, value: string) =>
		`<td data-plan="${plan}"${NUMERIC_VALUE.test(value) ? ' class="num"' : ""}>${value}</td>`;
	const rows = copy.rows
		.map((row) => `<tr><th>${row.label}</th>${cell(copy.free, row.free)}${cell(copy.pro, row.pro)}</tr>`)
		.join("");
	const notes = copy.notes.map((note) => `<li>${note}</li>`).join("");
	const incoming = copy.incomingNotes.map((note) => `<li>${note}</li>`).join("");
	return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mail.build</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preload" href="/fonts/space-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin><style>${STYLE}</style></head><body><div class="wrap">
<nav class="top">${languageMenu(locale)}<a class="chip help" href="/docs">${copy.help}</a></nav>
<header class="hero"><div><h1>mail.build</h1><p class="lead">${copy.loginLead}</p><a class="btn" href="${escapeAttr(loginHref)}">${copy.loginButton} <span aria-hidden="true">&rarr;</span></a></div><div class="art" aria-hidden="true"><div class="envelope">${ENVELOPE}</div><div class="mark">${MARK}</div><div class="stamp"><span></span></div></div></header>
<main>
<section class="card"><h2>${copy.quota}</h2>
<table><thead><tr><th></th><th>${copy.free}</th><th>${copy.pro}</th></tr></thead><tbody>${rows}</tbody></table>
<ul class="notes">${notes}</ul></section>
<section class="card incoming"><h2>${copy.incoming}</h2>
<ul class="notes">${incoming}</ul></section>
</main>
</div><script>${MENU_SCRIPT}</script></body></html>`;
}
