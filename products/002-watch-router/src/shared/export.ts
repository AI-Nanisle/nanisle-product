// N 线 · 想法导出(2026-09-01 站长需求):把「我写的」连同它当时挂着的那段
// context 打成一份 Markdown 下载走,拿去喂给别的模型(站长自己是拿它写小红书
// 文案)。三条设计取舍写在这里,改之前先看:
//
//   ① **只带精简 context**:标题/原链接/判决/导读,再加每条想法**锚定的那一条**
//      要点或那一段的标题,仅此而已。为什么不把全篇详细笔记(一小时视频 4~8 千
//      字)也塞进去:想法才是这份文件的主角,AI 产出一多就把它淹了,下游模型写
//      出来的东西会变成复述内容,而不是「我的观点」。
//   ② **版本对不上的想法不挂 context**:序号是对着某一版结果记的,重新生成后
//      kp:2 指向的已经是另一条要点。宁可只标一句「记于上一版结果」,也绝不安一
//      段错的原文上去——和结果页 orphanNotes 同一条纪律。
//   ③ **结果缓存过期(60 天)照样导**:想法是长期资产,context 是易耗品。缺
//      context 的条目老实写一句「结果缓存已过期」,而不是整条不导。
//
// 纯函数:不碰 fetch / DOM / 环境变量,时间也只认传进来的 now 和时区。所以前端
// (当前这条,数据本来就在手上)和 Worker(记录页批量,数据要现读)用的是同一份
// 实现,单测直接喂结构体。

import type { WatchResult } from "./schema";

/** 与 store.ts 的 NoteEntry 结构兼容;这里另立一份是为了不让前端为一个类型 import 整个 store。 */
export interface ExportNoteEntry {
	at: number;
	target: string;
	text: string;
	resultAt?: number;
}

export interface ExportItem {
	contentKey: string;
	url?: string;
	title?: string;
	entries: ExportNoteEntry[];
	/** 结果缓存还在才有;没有就只导想法本身(取舍 ③)。 */
	result?: WatchResult | null;
	/** 结果缓存的版本戳(cachedAt);想法的 resultAt 与它相等才敢挂 context(取舍 ②)。 */
	resultAt?: number;
}

export interface ExportOpts {
	/** 导出时刻(ms)。 */
	now: number;
	/** IANA 时区名。给了就按它印时间,非法或不给就按 UTC——纯函数不去猜环境。 */
	timeZone?: string;
}

const PATH_LABEL: Record<string, string> = {
	subtitle: "官方字幕",
	whisper: "whisper 转写",
	article: "文章抽取",
	paste: "手动粘贴",
};

const WORTH_LABEL: Record<string, string> = { yes: "值得看", no: "可以跳过", partial: "部分值得" };

interface Stamp {
	y: string;
	m: string;
	d: string;
	hh: string;
	mm: string;
}

function stampParts(ms: number, timeZone?: string): Stamp {
	const opts: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	};
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", timeZone ? { ...opts, timeZone } : opts).formatToParts(new Date(ms));
	} catch {
		// 非法时区(客户端可以传任意字符串)不该把整份导出搞崩,退回 UTC
		parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).formatToParts(new Date(ms));
	}
	const p: Record<string, string> = {};
	for (const x of parts) p[x.type] = x.value;
	// hour12:false 在部分实现里把 0 点印成 24
	const hh = p.hour === "24" ? "00" : (p.hour ?? "00");
	return { y: p.year ?? "", m: p.month ?? "", d: p.day ?? "", hh, mm: p.minute ?? "00" };
}

/** 2026-09-01 14:33 */
function fmtStamp(ms: number, timeZone?: string): string {
	const s = stampParts(ms, timeZone);
	return `${s.y}-${s.m}-${s.d} ${s.hh}:${s.mm}`;
}

/** 秒 → 5:12(与结果页 fmtTime 同款)。 */
function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** 位置:视频/播客是秒,文章是段号(与结果页 fmtPos 同款)。 */
function fmtPos(result: WatchResult, n: number): string {
	const isText = result.meta.path === "article" || result.meta.path === "paste";
	return isText ? `§${n}` : fmtTime(n);
}

/** kp:2 → 「要点 3」(人读序号从 1 起,与结果页 targetLabel 同款)。 */
function targetLabel(target: string): string {
	if (target === "overview") return "导读";
	if (target === "general") return "整体";
	const m = /^(kp|ch):(\d+)$/.exec(target);
	if (m) return `${m[1] === "kp" ? "要点" : "分段"} ${Number(m[2]) + 1}`;
	return target;
}

/** 定点想法是否属于手上这版结果;结果没带版本戳(旧缓存/mock)时不做甄别。 */
function inCurrentVersion(item: ExportItem, e: ExportNoteEntry): boolean {
	return typeof item.resultAt !== "number" || e.resultAt === item.resultAt;
}

interface EntryContext {
	label: string;
	/** 引用块的行(已带 "> " 前缀);空 = 没有可挂的 context。 */
	lines: string[];
	/** 记于另一版结果,或那条要点/分段已经不在了:序号指不准,只留标注。 */
	stale?: boolean;
}

function entryContext(item: ExportItem, e: ExportNoteEntry): EntryContext {
	const label = targetLabel(e.target);
	const result = item.result;
	// general 挂在整条内容上;overview 的正文已经整段印在上面的「这条内容讲了什么」里。
	// 两者都没有额外 context 要摘——再重复一遍只会让下游模型多读一次同样的话
	if (e.target === "general" || e.target === "overview" || !result) return { label, lines: [] };
	if (!inCurrentVersion(item, e)) return { label, lines: [], stale: true };

	const m = /^(kp|ch):(\d+)$/.exec(e.target);
	if (!m) return { label, lines: [] };
	const i = Number(m[2]);

	if (m[1] === "kp") {
		const kp = result.keyPoints[i];
		if (!kp) return { label, lines: [], stale: true };
		const at = typeof kp.start === "number" ? ` · ${fmtPos(result, kp.start)}` : "";
		const doubt = kp.anchored === false ? "(未锚定:这句引文没能在原文里对上,引用前自己核一眼)" : "";
		return { label, lines: [`> 要点:${kp.point}`, `> 引文「${kp.quote}」${at}${doubt}`] };
	}

	const ch = result.chapters[i];
	if (!ch) return { label, lines: [], stale: true };
	const title = result.notes?.find((n) => n.chapter === i)?.title || ch.gist;
	return { label, lines: [`> 第 ${i + 1} 段 ${fmtPos(result, ch.start)}–${fmtPos(result, ch.end)}:${title}`] };
}

/** 文件里给这条内容署的名。 */
function displayTitle(item: ExportItem): string {
	return item.title || item.url || "未命名内容";
}

/** 一条内容的正文块。level = 内容标题的标题级别;单条导出时标题已经是 H1,传 null。 */
function contentBlock(item: ExportItem, level: number | null, index: number, opts: ExportOpts): string[] {
	const out: string[] = [];
	const result = item.result;
	// 粘贴进来的正文既没有标题也没有链接,contentKey 是一串哈希——印出来只会让人
	// 一头雾水,不如老实说没有标题
	const title = displayTitle(item);
	const h = (n: number) => "#".repeat(n);
	const secLevel = level === null ? 2 : level + 1;

	if (level !== null) out.push(`${h(level)} ${index + 1}. ${title}`, "");

	const meta: string[] = [];
	if (item.url) meta.push(`原文:${item.url}`);
	if (result) {
		meta.push(`提取路径:${PATH_LABEL[result.meta.path] ?? result.meta.path}`);
		meta.push(`判决:${WORTH_LABEL[result.verdict.worth] ?? result.verdict.worth} —— ${result.verdict.reason}`);
	} else {
		meta.push("结果缓存已过期(结果只留 60 天),下面只剩想法本身");
	}
	for (const line of meta) out.push(`> ${line}`);
	out.push("");

	if (result?.overview) {
		out.push(`${h(secLevel)} 这条内容讲了什么`, "");
		out.push(result.overview.summary, "");
		out.push(`**有意思的是** ${result.overview.interesting}`, "");
		out.push(`**反着想** ${result.overview.counter}`, "");
	}

	// 想法按写下的先后排:它们是一条思路走下来的,时间序比锚点序更像「我当时在想什么」
	const entries = [...item.entries].sort((a, b) => a.at - b.at);
	out.push(`${h(secLevel)} 我的想法(${entries.length} 条)`, "");
	entries.forEach((e, i) => {
		const ctx = entryContext(item, e);
		const where = ctx.stale ? `挂在「${ctx.label}」· 记于上一版结果,序号已对不上` : `挂在「${ctx.label}」`;
		out.push(`${h(secLevel + 1)} ${i + 1} · ${fmtStamp(e.at, opts.timeZone)} · ${where}`, "");
		if (ctx.lines.length > 0) {
			out.push("当时看的是:");
			out.push(...ctx.lines);
			out.push("");
		}
		out.push("我写的:");
		out.push(e.text, "");
	});
	return out;
}

/**
 * 想法 + context → 一份 Markdown。没有任何想法时也返回一份完整文件(里面说明没有),
 * 不抛错——按钮按下去总得有东西下下来。
 */
export function buildNotesExport(items: ExportItem[], opts: ExportOpts): string {
	const withNotes = items.filter((it) => it.entries.length > 0);
	const total = withNotes.reduce((s, it) => s + it.entries.length, 0);
	const single = withNotes.length === 1;
	const out: string[] = [];

	const name = single ? displayTitle(withNotes[0]) : "";
	out.push(single ? `# 想法导出 · ${name}` : `# 想法导出 · ${withNotes.length} 条内容 · ${total} 条想法`, "");
	out.push(`> nanisle 002 长视频总结 · 导出于 ${fmtStamp(opts.now, opts.timeZone)}`, "");

	if (withNotes.length === 0) {
		out.push("(还没有记过想法。)", "");
	} else if (single) {
		out.push(...contentBlock(withNotes[0], null, 0, opts));
	} else {
		withNotes.forEach((it, i) => {
			if (i > 0) out.push("---", "");
			out.push(...contentBlock(it, 2, i, opts));
		});
	}

	out.push("---", "");
	out.push("「我写的」是我自己敲的字;判决、导读、要点与引文由 AI 从原内容里提取,引文为原文逐字摘录。");
	return `${out.join("\n").trimEnd()}\n`;
}

/** 文件名里不能出现的字符 + 长度封顶(浏览器的 download 属性给什么就存什么)。 */
function safeName(s: string): string {
	return s
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\p{Cc}/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
}

export function exportFileName(items: ExportItem[], opts: ExportOpts): string {
	const withNotes = items.filter((it) => it.entries.length > 0);
	const s = stampParts(opts.now, opts.timeZone);
	// 文件名只用真标题:没有标题时宁可叫「全部」,也不要一串 URL 或哈希
	const one = withNotes.length === 1 ? safeName(withNotes[0].title ?? "") : "";
	return `想法-${one || "全部"}-${s.y}${s.m}${s.d}.md`;
}
