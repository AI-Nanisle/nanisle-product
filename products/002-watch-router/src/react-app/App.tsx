import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { buildNotesExport, exportFileName } from "../shared/export";
import type { ExportItem } from "../shared/export";
import type { WatchResult } from "../shared/schema";
import { SiteHeader } from "./SiteChrome";
import { apiPath } from "./paths";

// 收单 + 结果页 + 记录/想法(docs/03 F 线 + N 线)。视觉与主站/001 同一套
// 语言,隐喻是「剪辑台」。N 线哲学同 001:结果是内容(60 天缓存,过期可
// 重算),想法是读者的长期资产(DynamoDB,永不过期)。

interface Health {
	ok: boolean;
	provider: string;
	store: string;
	email: string | null;
	loginUrl: string;
	ssoConfigured: boolean;
}

interface Usage {
	used: number;
	limit: number;
}

interface NoteEntry {
	at: number;
	target: string;
	text: string;
	/** 写想法时所见结果的版本戳;与当前结果对不上的定点想法沉到「我的想法」。 */
	resultAt?: number;
}

interface NoteRecord {
	contentKey: string;
	url?: string;
	title?: string;
	entries: NoteEntry[];
}

interface HistoryItem {
	contentKey: string;
	url?: string;
	title?: string;
	at: number;
	/** 这条内容上记过几条想法(服务端一次 Query 带回)。0 的行不出现导出按钮。 */
	notes?: number;
}

/** 订阅模式(docs/05 §3):一条订阅 + 今天挑选结果。 */
interface SubItem {
	platform: "youtube" | "bilibili" | "podcast";
	id: string;
	title?: string;
	label: string;
	addedAt: number;
	lastPickedAt?: number;
}

interface SubsResponse {
	items: SubItem[];
	limit: number;
	emailPush: boolean;
	today: { picked: { title: string; channelTitle?: string } | null; reason: string; contentKey?: string } | null;
}

interface SubmitResponse {
	cached?: boolean;
	lane?: string;
	contentKey?: string;
	result?: WatchResult;
	resultAt?: number;
	paragraphs?: string[];
	url?: string;
	taskId?: string;
	error?: string;
	needPaste?: boolean;
	loginUrl?: string;
}

interface TaskResponse {
	status: "pending" | "running" | "done" | "failed";
	step?: string;
	path?: string;
	url?: string;
	contentKey?: string;
	result?: WatchResult;
	resultAt?: number;
	paragraphs?: string[];
	error?: string;
}

/** 快车道 SSE 事件(worker/index.ts 的 send 序列)。 */
interface FastEvent {
	type: "phase" | "delta" | "result" | "error" | "ping";
	phase?: string;
	chars?: number;
	/** phase=notes 的逐章进度。 */
	done?: number;
	total?: number;
	contentKey?: string;
	result?: WatchResult;
	resultAt?: number;
	paragraphs?: string[];
	url?: string;
	error?: string;
	needPaste?: boolean;
}

const STEPS = [
	["queued", "排队"],
	["downloading", "下载"],
	["transcribing", "转写"],
	["editing", "编辑"],
	["done", "完成"],
] as const;

/**
 * GET /api/inflight:「我现在有没有一单在跑」。两条车道都跑在服务端(慢车道是
 * SQS→Lambda,快车道是 Worker 的 waitUntil),关掉页面它们照跑;可进度以前只活在
 * 这个组件的 state 里,一刷新就失联。指针存服务端而不是 localStorage,是为了换
 * 设备也能接回——手机上提交、电脑上打开,看到的是同一单。
 */
interface InflightResponse {
	active: boolean;
	lane?: "fast" | "slow";
	taskId?: string;
	contentKey?: string;
	url?: string;
	step?: string;
	phase?: string;
	done?: number;
	total?: number;
	/** 快车道刚好在这一跳之前跑完:结果直接随响应回来。 */
	result?: WatchResult;
	resultAt?: number;
	paragraphs?: string[];
	failed?: boolean;
	error?: string;
}

/** 快车道状态行文案。SSE 推来的事件和接回时读的指针共用同一套措辞。 */
function fastPhaseLabel(phase?: string, done?: number, total?: number): string {
	if (phase === "extracting") return "抽取正文中";
	if (phase === "notes") return `逐章写详细笔记 · ${done ?? 0}/${total ?? "?"} 章`;
	return "编辑中(长文要一两分钟)";
}

function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** 沉底想法的原锚点标注:kp:2 → 「要点 3」(人读序号从 1 起)。 */
function targetLabel(t: string): string {
	if (t === "overview") return "导读";
	const m = /^(kp|ch):(\d+)$/.exec(t);
	if (m) return `${m[1] === "kp" ? "要点" : "分段"} ${Number(m[2]) + 1}`;
	return t;
}

function fmtDate(ms: number): string {
	return new Date(ms).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** 想法导出的时区:文件里印的时刻要和读者刚刚在页面上看到的一致。 */
function browserTimeZone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
	} catch {
		return undefined;
	}
}

/**
 * N 线 · 把一份 Markdown 下成文件。走 Blob + a[download],不经服务端也不碰剪贴板:
 * 剪贴板 API 在非 HTTPS 和一部分移动浏览器上直接没有,而下载到处都有。
 */
function downloadMarkdown(filename: string, markdown: string) {
	const href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = href;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// 立刻 revoke 会让部分浏览器来不及取数据,让出一帧再回收
	setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** F4 · 视频平台的带秒跳转链接;不认识的平台返回 null(只显示时间不跳)。 */
function jumpHref(url: string | undefined, startSec: number): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./, "");
		const t = Math.floor(startSec);
		if (host === "youtu.be" || host.endsWith("youtube.com")) {
			u.searchParams.set("t", `${t}s`);
			return u.toString();
		}
		if (host.endsWith("bilibili.com")) {
			u.searchParams.set("t", String(t));
			return u.toString();
		}
	} catch {
		// 非法 URL 就不给跳转
	}
	return null;
}

interface Loaded {
	contentKey?: string;
	result: WatchResult;
	resultAt?: number;
	paragraphs?: string[];
	url?: string;
}

const PATH_LABEL: Record<string, string> = {
	subtitle: "官方字幕",
	whisper: "whisper 转写(时间戳与文字精度低一档)",
	article: "文章抽取",
	paste: "手动粘贴",
};

export default function App() {
	const [health, setHealth] = useState<Health | null>(null);
	const [usage, setUsage] = useState<Usage | null>(null);
	const [input, setInput] = useState("");
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [error, setError] = useState("");
	const [login, setLogin] = useState("");
	const [busy, setBusy] = useState(false);
	const [step, setStep] = useState<string | null>(null);
	const [fastStatus, setFastStatus] = useState<string | null>(null);
	const [showSource, setShowSource] = useState(false);
	// N 线状态
	const [view, setView] = useState<"main" | "history" | "subs">("main");
	const [history, setHistory] = useState<HistoryItem[] | null>(null);
	// 订阅模式状态
	const [subs, setSubs] = useState<SubsResponse | null>(null);
	const [subInput, setSubInput] = useState("");
	const [subBusy, setSubBusy] = useState(false);
	const [subMsg, setSubMsg] = useState("");
	const [note, setNote] = useState<NoteRecord | null>(null);
	/** 正在写想法的锚点(同一时刻只开一个输入框)。 */
	const [noteAt, setNoteAt] = useState<string | null>(null);
	const [noteText, setNoteText] = useState("");
	/** 记录页正在导出的那条(要跑一趟 /api/result 把结果与想法取回来);null = 没有在导。 */
	const [exportKey, setExportKey] = useState<string | null>(null);

	function refreshUsage() {
		fetch(apiPath("usage"))
			.then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
			.then((u) => u && setUsage(u))
			.catch(() => {});
	}

	useEffect(() => {
		// ?url= 预填:001 简报「深读 →」入口的承接端(docs/02 T7①)
		const params = new URLSearchParams(window.location.search);
		const preset = params.get("url");
		if (preset) setInput(preset);
		// ?open=<contentKey>:订阅邮件的回链(docs/05 §3.5),直接重开这条记录
		const open = params.get("open");
		if (open) void openRecord({ contentKey: open, at: 0 });
		// 刷新/重开页面:上一趟还没收场的那一单接着看,进度条不再凭空消失。
		// ?open= 是读者点邮件回链明确要看某一条,别让接回抢了那块地方
		if (!open) void resumeInflight();
		fetch(apiPath("health"))
			.then((r) => r.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setHealth(null));
		refreshUsage();
	}, []);

	/** 结果就位后拉这条内容的想法账(独立请求,失败只是没想法,不碍读)。 */
	function loadNote(contentKey: string) {
		fetch(apiPath(`note/${contentKey}`))
			.then((r) => (r.ok ? (r.json() as Promise<{ note: NoteRecord | null }>) : null))
			.then((d) => setNote(d?.note ?? null))
			.catch(() => setNote(null));
	}

	function present(l: Loaded) {
		setLoaded(l);
		setNote(null);
		setNoteAt(null);
		if (l.contentKey) loadNote(l.contentKey);
	}

	async function loadHistory() {
		setView("history");
		try {
			const res = await fetch(apiPath("history"));
			if (res.status === 401) {
				const d = (await res.json()) as { loginUrl?: string };
				setError("请先登录南屿账号。");
				if (d.loginUrl) setLogin(d.loginUrl);
				setView("main");
				return;
			}
			const d = (await res.json()) as { items: HistoryItem[] };
			setHistory(d.items);
		} catch {
			setHistory([]);
		}
	}

	// ---------- 订阅模式(docs/05 §3) ----------

	async function loadSubs() {
		setView("subs");
		setSubMsg("");
		try {
			const res = await fetch(apiPath("subs"));
			if (res.status === 401) {
				const d = (await res.json()) as { loginUrl?: string };
				setError("请先登录南屿账号。");
				if (d.loginUrl) setLogin(d.loginUrl);
				setView("main");
				return;
			}
			setSubs((await res.json()) as SubsResponse);
		} catch {
			setSubMsg("读取订阅失败,稍后再试。");
		}
	}

	async function addSub() {
		const input = subInput.trim();
		if (!input) return;
		setSubBusy(true);
		setSubMsg("");
		try {
			const res = await fetch(apiPath("subs"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input }),
			});
			const d = (await res.json()) as { ok?: boolean; sub?: SubItem; error?: string };
			if (d.ok && d.sub) {
				setSubs((s) => (s ? { ...s, items: [...s.items, d.sub!] } : s));
				setSubInput("");
			} else {
				setSubMsg(d.error ?? `添加失败(${res.status})`);
			}
		} catch {
			setSubMsg("网络错误,稍后再试。");
		} finally {
			setSubBusy(false);
		}
	}

	async function delSub(item: SubItem) {
		setSubs((s) => (s ? { ...s, items: s.items.filter((x) => !(x.platform === item.platform && x.id === item.id)) } : s));
		void fetch(apiPath("subs/delete"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: item.platform, id: item.id }),
		}).catch(() => {});
	}

	async function toggleEmailPush() {
		if (!subs) return;
		const next = !subs.emailPush;
		setSubs({ ...subs, emailPush: next });
		void fetch(apiPath("subs/prefs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ emailPush: next }),
		}).catch(() => {});
	}

	/** 立刻跑一轮「发现 → 挑一条」(本地/调试用;线上由每晚 cron 做)。 */
	async function runSubsNow() {
		setSubBusy(true);
		setSubMsg("");
		try {
			const res = await fetch(apiPath("subs/run"), { method: "POST" });
			const d = (await res.json()) as { ok?: boolean; outcome?: string; error?: string; sources?: Record<string, string> };
			if (!d.ok) setSubMsg(d.error ?? `失败(${res.status})`);
			else setSubMsg(`已跑完:${d.outcome}${d.sources ? " · " + Object.entries(d.sources).map(([k, v]) => `${k.split(":")[0]} ${v}`).join("、") : ""}`);
			await loadSubs();
		} catch {
			setSubMsg("网络错误,稍后再试。");
		} finally {
			setSubBusy(false);
		}
	}

	async function openRecord(item: HistoryItem) {
		setError("");
		try {
			// 必须编码:contentKey 可能来自 ?open= 查询参数,不编码的话 ../../ 能把这个
			// 请求拐到别的端点上去(比如一键登出)
			const res = await fetch(apiPath(`result/${encodeURIComponent(item.contentKey)}`));
			const d = (await res.json()) as SubmitResponse & { expired?: boolean; note?: NoteRecord };
			if (d.expired) {
				// 结果缓存过期(60 天):预填原链接引导重算,想法账还在
				setView("main");
				setInput(item.url ?? "");
				setLoaded(null);
				setError("这份结果的缓存已过期(60 天)。原链接已填好,点「替我看」重新生成——你的想法一直都在,重新生成后照常显示。");
				return;
			}
			if (d.result) {
				setView("main");
				setShowSource(false);
				setLoaded({ contentKey: d.contentKey, result: d.result, resultAt: d.resultAt, paragraphs: d.paragraphs, url: d.url });
				setNote(d.note ?? null);
				setNoteAt(null);
				window.scrollTo({ top: 0 });
			}
		} catch {
			setError("打开记录失败,稍后再试。");
		}
	}

	async function addNote(target: string) {
		const key = loaded?.contentKey;
		const text = noteText.trim();
		if (!key || !text) return;
		try {
			const res = await fetch(apiPath("note"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					contentKey: key,
					target,
					text,
					// 版本戳:重新生成后,定点想法靠它判断还挂不挂在原位
					...(typeof loaded?.resultAt === "number" ? { resultAt: loaded.resultAt } : {}),
				}),
			});
			const d = (await res.json()) as { ok?: boolean; entry?: NoteEntry; error?: string };
			if (d.ok && d.entry) {
				setNote((n) => ({
					contentKey: key,
					...(n ?? {}),
					entries: [...(n?.entries ?? []), d.entry!],
				}));
				setNoteText("");
				setNoteAt(null);
			} else if (d.error) {
				setError(d.error);
			}
		} catch {
			setError("想法没存上,稍后再试。");
		}
	}

	async function delNote(at: number) {
		const key = loaded?.contentKey;
		if (!key) return;
		setNote((n) => (n ? { ...n, entries: n.entries.filter((e) => e.at !== at) } : n));
		void fetch(apiPath("note/delete"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contentKey: key, at }),
		}).catch(() => {});
	}

	/**
	 * N 线 · 导出当前这条的想法 + 精简 context。结果和想法都已经在手上,所以整份
	 * Markdown 在浏览器里拼完就下下来,不跑服务端——记录页的批量导出才需要走后端
	 * (那些内容的结果不在手上),两边用的是同一个 buildNotesExport。
	 */
	function exportCurrent() {
		const key = loaded?.contentKey;
		if (!key || !note || note.entries.length === 0) return;
		const opts = { now: Date.now(), timeZone: browserTimeZone() };
		const items: ExportItem[] = [
			{
				contentKey: key,
				url: loaded?.url,
				title: loaded?.result.meta.title ?? note.title,
				entries: note.entries,
				result: loaded?.result,
				resultAt: loaded?.resultAt,
			},
		];
		downloadMarkdown(exportFileName(items, opts), buildNotesExport(items, opts));
	}

	/**
	 * N 线 · 记录页某一行的导出:不用先点开那条。结果、想法、版本戳都在现成的
	 * /api/result/:key 里(重开记录走的就是它),取回来交给同一个 buildNotesExport。
	 */
	async function exportRecord(item: HistoryItem) {
		setExportKey(item.contentKey);
		setError("");
		try {
			const res = await fetch(apiPath(`result/${encodeURIComponent(item.contentKey)}`));
			const d = (await res.json()) as SubmitResponse & { expired?: boolean; title?: string; note?: NoteRecord; error?: string };
			if (!res.ok) {
				setError(d.error ?? `导出失败(${res.status})`);
				return;
			}
			const entries = d.note?.entries ?? [];
			if (entries.length === 0) {
				setError("这条还没记过想法。");
				return;
			}
			const opts = { now: Date.now(), timeZone: browserTimeZone() };
			// 缓存过期(60 天)的照导:想法是长期资产,少的只是 context(export.ts 取舍 ③)
			const items: ExportItem[] = [
				{
					contentKey: item.contentKey,
					url: d.url ?? item.url,
					title: d.result?.meta.title ?? d.title ?? item.title,
					entries,
					result: d.result,
					resultAt: d.resultAt,
				},
			];
			downloadMarkdown(exportFileName(items, opts), buildNotesExport(items, opts));
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setExportKey(null);
		}
	}

	/** F2 · 快车道 SSE:phase → delta(字符数)→ result/error。 */
	async function readFastStream(res: Response) {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";
			for (const raw of events) {
				const line = raw.split("\n").find((l) => l.startsWith("data:"));
				if (!line) continue;
				let ev: FastEvent;
				try {
					ev = JSON.parse(line.slice(5).trim()) as FastEvent;
				} catch {
					continue;
				}
				if (ev.type === "phase") {
					setFastStatus(fastPhaseLabel(ev.phase, ev.done, ev.total));
				} else if (ev.type === "delta" && typeof ev.chars === "number") {
					setFastStatus(`编辑中 · 已生成 ${ev.chars} 字`);
				} else if (ev.type === "result" && ev.result) {
					present({ contentKey: ev.contentKey, result: ev.result, resultAt: ev.resultAt, paragraphs: ev.paragraphs, url: ev.url });
				} else if (ev.type === "error" && ev.error) {
					setError(ev.error + (ev.needPaste ? "(把正文粘进输入框再试)" : ""));
				}
			}
		}
	}

	/**
	 * F6 · 慢车道:轮询任务直到 done/failed;超时由服务端判定。
	 * resume=true 是刷新后接回旧任务:第一次立刻问(别让读者再对着空状态等 2.5 秒),
	 * 且任务已经不在时安静收场——过期/换账号不是读者这次操作造成的,不该弹错。
	 */
	async function pollTask(taskId: string, resume = false) {
		let wait = !resume;
		for (;;) {
			if (wait) await new Promise((r) => setTimeout(r, 2500));
			wait = true;
			const res = await fetch(apiPath(`task/${taskId}`));
			const data = (await res.json()) as TaskResponse;
			if (!res.ok) {
				// 接回时任务已经不在(24 小时 ttl 过期、换了账号)就安静收场:
				// 不是读者这次操作造成的,不该拿一条红字迎接他
				if (resume && res.status === 404) return;
				setError((data as { error?: string }).error ?? `轮询失败(${res.status})`);
				return;
			}
			setStep(data.step ?? data.status);
			if (data.status === "done" && data.result) {
				present({ contentKey: data.contentKey, result: data.result, resultAt: data.resultAt, paragraphs: data.paragraphs, url: data.url });
				return;
			}
			if (data.status === "failed") {
				setError(data.error ?? "处理失败。");
				return;
			}
		}
	}

	/** 接回慢车道:状态行照常走那条五步进度。 */
	async function resumeSlow(taskId: string, step?: string) {
		setBusy(true);
		setError("");
		setStep(step ?? "queued");
		try {
			await pollTask(taskId, true);
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setBusy(false);
			setStep(null);
			refreshUsage();
		}
	}

	/**
	 * 接回快车道。原来那条 SSE 随刷新一起断了,而且重连不了(写端在 Worker 的
	 * waitUntil 里,拿不回来),所以接回改成轮询 /api/inflight——同一份指针,换个读法。
	 */
	async function resumeFast(contentKey: string, first: InflightResponse) {
		setBusy(true);
		setError("");
		setFastStatus(fastPhaseLabel(first.phase, first.done, first.total));
		try {
			for (;;) {
				await new Promise((r) => setTimeout(r, 2500));
				const res = await fetch(apiPath("inflight"));
				if (!res.ok) return;
				const d = (await res.json()) as InflightResponse;
				if (d.result) {
					present({ contentKey: d.contentKey, result: d.result, resultAt: d.resultAt, paragraphs: d.paragraphs, url: d.url });
					return;
				}
				if (d.active) {
					setFastStatus(fastPhaseLabel(d.phase, d.done, d.total));
					continue;
				}
				if (d.failed && d.error) {
					setError(d.error);
					return;
				}
				// 指针已注销、这一跳却没带结果:收尾与轮询错身了几百毫秒。直接问结果
				// 本体——成了就照常呈现,确实没有才认定这一单断了
				const got = await fetch(apiPath(`result/${encodeURIComponent(contentKey)}`));
				if (got.ok) {
					const r = (await got.json()) as SubmitResponse & { note?: NoteRecord };
					if (r.result) {
						setLoaded({ contentKey: r.contentKey, result: r.result, resultAt: r.resultAt, paragraphs: r.paragraphs, url: r.url });
						setNote(r.note ?? null);
						setNoteAt(null);
						return;
					}
				}
				setError("上一单跑到一半断了,重新提交一次吧(别人算过的话命中缓存,不花额度)。");
				return;
			}
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setBusy(false);
			setFastStatus(null);
			refreshUsage();
		}
	}

	/** 打开页面先问一句:有没有还没收场的一单要接回。 */
	async function resumeInflight() {
		let d: InflightResponse;
		try {
			const res = await fetch(apiPath("inflight"));
			if (!res.ok) return; // 没登录 / 服务端出错,就当没有在跑的一单
			d = (await res.json()) as InflightResponse;
		} catch {
			return;
		}
		if (d.result) {
			// 刷新这一刻刚好跑完:直接呈现,进度条都不用走
			present({ contentKey: d.contentKey, result: d.result, resultAt: d.resultAt, paragraphs: d.paragraphs, url: d.url });
			return;
		}
		// 上一单是在页面关着的时候收场的:慢车道失败,或快车道跑到一半 Worker 被
		// 回收。服务端已经把指针清掉了,这一次响应是唯一一次把原因讲出来的机会——
		// 在这之前这两个字段谁都没读,失败就是一张白页(2026-09-04 事故)。
		if (d.failed) {
			setError(d.error ?? "上一单没能跑完。重新提交一次吧。");
			if (d.url) setInput((cur) => cur || d.url!);
			return;
		}
		if (!d.active) return;
		// 收单框回填原链接,让读者看见正在处理的是哪一条(?url= 预填优先)
		const back = d.url;
		if (back) setInput((cur) => cur || back);
		if (d.lane === "slow" && d.taskId) await resumeSlow(d.taskId, d.step);
		else if (d.lane === "fast" && d.contentKey) await resumeFast(d.contentKey, d);
	}

	/** regenUrl:对已生成的记录强制重算(跳过缓存,花一次额度;想法不动)。 */
	async function submit(opts?: { regenUrl?: string }) {
		setBusy(true);
		setError("");
		setLogin("");
		setLoaded(null);
		setNote(null);
		setStep(null);
		setFastStatus(null);
		setShowSource(false);
		try {
			const trimmed = opts?.regenUrl ?? input.trim();
			const isUrl = /^https?:\/\//i.test(trimmed);
			const res = await fetch(apiPath("submit"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					isUrl ? { url: trimmed, ...(opts?.regenUrl ? { force: true } : {}) } : { text: trimmed },
				),
			});
			if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
				await readFastStream(res);
			} else {
				const data = (await res.json()) as SubmitResponse;
				if (!res.ok) {
					setError(data.error ?? `请求失败(${res.status})`);
					if (res.status === 401 && data.loginUrl) setLogin(data.loginUrl);
				} else if (data.result) {
					present({ contentKey: data.contentKey, result: data.result, resultAt: data.resultAt, paragraphs: data.paragraphs, url: data.url });
				} else if (data.taskId) {
					setStep("queued");
					await pollTask(data.taskId);
				}
			}
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setBusy(false);
			setStep(null);
			setFastStatus(null);
			refreshUsage();
		}
	}

	/** F4 · 文章段落锚点:展开原文区后滚动到对应段并短暂点亮。 */
	function jumpToPara(n: number) {
		setShowSource(true);
		setTimeout(() => {
			const el = document.getElementById(`para-${n}`);
			if (!el) return;
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.classList.add("para-hit");
			setTimeout(() => el.classList.remove("para-hit"), 1600);
		}, 60);
	}

	const result = loaded?.result ?? null;
	const isText = result?.meta.path === "article" || result?.meta.path === "paste";
	const fmtPos = (n: number) => (isText ? `§${n}` : fmtTime(n));
	const lowAmount = result
		? result.chapters.filter((ch) => ch.value === "low").reduce((s, ch) => s + (ch.end - ch.start), 0)
		: 0;
	const lowLabel = isText ? `低价值 ${lowAmount} 段` : `低价值约 ${Math.round(lowAmount / 60)} 分钟`;
	const canJumpText = isText && (loaded?.paragraphs?.length ?? 0) > 0;
	const stepIdx = STEPS.findIndex(([k]) => k === step);
	const canNote = Boolean(loaded?.contentKey);
	// 额度写「还剩几条」不写「用了几比几」:读者关心的是前者(001 同款语义)
	const quotaLeft = usage ? Math.max(0, usage.limit - usage.used) : null;
	// 分区编号(001 同款):导读/详细笔记/术语表可能缺席,编号按实际出现的顺序补位
	const notes = result?.notes && result.notes.length > 0 ? result.notes : null;
	const terms = result?.terms && result.terms.length > 0 ? result.terms : null;
	const sections = [
		result?.overview ? "overview" : null,
		notes ? "notes" : null,
		terms ? "terms" : null,
		"keyPoints",
		notes ? null : "map",
		"mine",
	].filter((s): s is string => s !== null);
	const secNo = (key: string) => String(sections.indexOf(key) + 1).padStart(2, "0");
	const notesChars = notes ? notes.reduce((s, n) => s + n.body.reduce((t, p) => t + p.length, 0), 0) : 0;

	/**
	 * 下面两个是**渲染辅助函数,不是组件**——调用它们(`{pos(...)}`)而不是写成
	 * `<Pos />`。区别不是风格:定义在 App 体内的函数每次渲染都是一个新的函数引用,
	 * React 认它是「另一种组件类型」,于是每渲染一次就把它的整棵子树卸载重建。
	 * 想法输入框正好落在这棵子树里:每敲一个字 → setNoteText → App 重渲染 →
	 * textarea 的 DOM 节点被销毁重建,iOS 上待插入的那个字符会落进新节点再来一遍,
	 * 打出来就是「iihhssuuqq」(2026-08-31 站长在 iPhone 上报的)。顺带,一份 23 章
	 * 一万多字的笔记每敲一下就整棵重建,手机上光是这个也卡得不像话。
	 * 写成函数调用后它们返回的 JSX 直接内联进 App 自己的树里,没有组件边界,
	 * 按位置复用,textarea 从头到尾是同一个 DOM 节点。
	 */
	function pos(start: number, children: ReactNode): ReactNode {
		if (canJumpText) {
			return (
				<button type="button" className="pos-link" onClick={() => jumpToPara(start)}>
					{children}
				</button>
			);
		}
		const href = jumpHref(loaded?.url, start);
		if (href && !isText) {
			return (
				<a className="pos-link" href={href} target="_blank" rel="noreferrer">
					{children}
				</a>
			);
		}
		return <>{children}</>;
	}

	/** 定点想法是否属于当前这版结果;结果没带版本戳时(旧缓存/mock)不做甄别。 */
	const inCurrentVersion = (e: NoteEntry) => typeof loaded?.resultAt !== "number" || e.resultAt === loaded.resultAt;
	/** 版本对不上的定点想法:不挂原位(序号已指向别的内容),沉到「我的想法」。 */
	const orphanNotes = canNote ? (note?.entries ?? []).filter((e) => e.target !== "general" && !inCurrentVersion(e)) : [];

	/** N 线 · 一个锚点上的想法区:已有条目 + 「记一笔」入口。同上,是函数不是组件。 */
	function noteSpot(target: string, always?: boolean): ReactNode {
		if (!canNote) return null;
		const entries = (note?.entries ?? []).filter((e) => e.target === target && (target === "general" || inCurrentVersion(e)));
		const open = noteAt === target;
		if (!always && entries.length === 0 && !open) {
			return (
				<button type="button" className="note-add" onClick={() => { setNoteAt(target); setNoteText(""); }}>
					＋ 想法
				</button>
			);
		}
		return (
			<div className="note-spot">
				{entries.map((e) => (
					<div key={e.at} className="note-entry">
						<span className="note-meta">{fmtDate(e.at)}</span>
						{e.text}
						<button type="button" className="note-del" aria-label="删除这条想法" onClick={() => void delNote(e.at)}>
							×
						</button>
					</div>
				))}
				{open ? (
					<div className="note-form">
						<textarea
							autoFocus
							value={noteText}
							onChange={(e) => setNoteText(e.target.value)}
							placeholder="记下你此刻的想法…(只有你自己能看到)"
						/>
						<div className="note-form-row">
							<button type="button" className="btn-ink" disabled={!noteText.trim()} onClick={() => void addNote(target)}>
								存想法
							</button>
							<button type="button" className="note-cancel" onClick={() => setNoteAt(null)}>
								取消
							</button>
						</div>
					</div>
				) : (
					<button type="button" className="note-add" onClick={() => { setNoteAt(target); setNoteText(""); }}>
						＋ 想法
					</button>
				)}
			</div>
		);
	}

	return (
		<div>
			<SiteHeader />
			<main className="page">
				{/* 报头(001 简报页同款结构):小签行 → 特大题字 → 读数行 →
				    双细线 → 双线下的状态行。进度与额度都压在状态行里,不跟题字抢版面。 */}
				<header className="masthead rise">
					<div className="mast-top">
						<span className="mast-sig">
							<span className="dot dot-accent" />
							No.002 · 每周一个产品
							{health?.provider === "mock" && <span className="mock-chip">MOCK</span>}
						</span>
						<div className="view-seg">
							<button type="button" aria-pressed={view === "main"} onClick={() => setView("main")}>
								总结
							</button>
							<button type="button" aria-pressed={view === "history"} onClick={() => void loadHistory()}>
								记录
							</button>
							<button type="button" aria-pressed={view === "subs"} onClick={() => void loadSubs()}>
								订阅
							</button>
						</div>
					</div>
					<h1>长视频总结</h1>
					<div className="deck-line">
						{view === "history" ? (
							<>
								<span className="lead">记录 · 你处理过的每一条</span>
								<span>想法永久保存,结果缓存 60 天</span>
							</>
						) : view === "subs" ? (
							<>
								<span className="lead">订阅 · 每天替你看一条</span>
								<span>YouTube 频道 · B站 UP 主 · 播客,每晚挑一条新的写成详细笔记</span>
							</>
						) : (
							<>
								<span className="lead">视频 · 播客 · 文章</span>
								<span>值不值得看 · 讲了什么 · 在原片哪几分钟</span>
							</>
						)}
					</div>
					<div className="rule-double" />
					<div className="status-row">
						{busy && step ? (
							<span className="steps" aria-label="处理进度">
								<span className="mark">▸</span>{" "}
								{STEPS.map(([key, label], i) => (
									<span key={key}>
										{i > 0 && <span className="sep">→</span>}{" "}
										<span className={key === step || i < stepIdx ? "on" : ""}>{label}</span>
									</span>
								))}
								<span className="caret" />
							</span>
						) : busy ? (
							<span>
								<span className="mark">▸</span> {fastStatus ?? "接单,准备处理…"}
								<span className="caret" />
							</span>
						) : (
							<span>
								{view === "history"
									? "点任意一条,回看结果和你留下的想法"
									: view === "subs"
										? "每晚 8 点(美东)从你的订阅里挑一条 48 小时内的新内容,写好后发一封邮件叫你"
										: "丢一条链接进来,AI 先替你看完——你只看值得看的部分"}
							</span>
						)}
						<span className="right">
							{quotaLeft !== null && (
								<span className={`quota-pill${quotaLeft === 0 ? " out" : quotaLeft <= 2 ? " warn" : ""}`}>
									{quotaLeft === 0 ? "今日额度已用完" : `今日还可看 ${quotaLeft} 条`}
								</span>
							)}
						</span>
					</div>
				</header>

				{view === "subs" ? (
					<section className="rise" aria-label="我的订阅">
						<div className="console" style={{ marginTop: 24 }}>
							<textarea
								rows={2}
								placeholder="粘一个地址:YouTube 频道(youtube.com/@名字 或 /channel/UC…)、B站 UP 主空间(space.bilibili.com/数字)、播客 RSS"
								value={subInput}
								onChange={(e) => setSubInput(e.target.value)}
							/>
							<div className="console-row">
								<button type="button" className="btn-stamp" disabled={subBusy || subInput.trim().length === 0} onClick={() => void addSub()}>
									<span className="mark" aria-hidden="true">
										▸
									</span>
									{subBusy ? "处理中…" : "订阅"}
								</button>
								{subs && (
									<span className="meta-line" style={{ margin: 0 }}>
										{subs.items.length}/{subs.limit}
									</span>
								)}
							</div>
						</div>
						{subMsg && (
							<div className="error-box rise" role="status">
								{subMsg}
							</div>
						)}
						{subs === null ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								读取中…
							</p>
						) : subs.items.length === 0 ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								还没有订阅。粘一个频道地址试试——每天只挑一条,最多 {subs.limit} 个订阅。
							</p>
						) : (
							<ol className="history-list">
								{subs.items.map((s) => (
									<li key={`${s.platform}:${s.id}`}>
										<button type="button" onClick={() => void delSub(s)} title="点击取消订阅">
											<span className="h-title">
												<span className="sub-label">{s.label}</span>
												{s.title || s.id}
											</span>
											<span className="h-date">{s.lastPickedAt ? `上次挑中 ${fmtDate(s.lastPickedAt)}` : "还没挑过"} · 取消 ×</span>
										</button>
									</li>
								))}
							</ol>
						)}
						{subs && (
							<p className="meta-line rise rise-2">
								{subs.today
									? subs.today.picked
										? <>今天挑了:{subs.today.picked.channelTitle ? `${subs.today.picked.channelTitle} · ` : ""}《{subs.today.picked.title}》({subs.today.reason}){subs.today.contentKey && <> · <button type="button" className="regen" onClick={() => void openRecord({ contentKey: subs.today!.contentKey!, at: 0 })}>打开 →</button></>}</>
										: `今天没挑:${subs.today.reason}`
									: "今天还没跑"}
								{" · "}
								<label style={{ cursor: "pointer" }}>
									<input type="checkbox" checked={subs.emailPush} onChange={() => void toggleEmailPush()} /> 挑好后发邮件叫我
								</label>
								{subs.items.length > 0 && !subs.today && (
									<>
										{" · "}
										<button type="button" className="regen" disabled={subBusy} onClick={() => void runSubsNow()} title="不等今晚,现在就从订阅里挑一条">
											现在就挑一条 ↻
										</button>
									</>
								)}
							</p>
						)}
						{error && (
							<div className="error-box rise" role="alert">
								{error}
								{login && (
									<>
										{" "}
										<a href={login}>去登录 →</a>
									</>
								)}
							</div>
						)}
					</section>
				) : view === "history" ? (
					<section className="rise">
						{history === null ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								读取中…
							</p>
						) : history.length === 0 ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								还没有记录——回去丢一条链接试试。
							</p>
						) : (
							<ol className="history-list">
								{history.map((h) => (
									<li key={h.contentKey}>
										<button type="button" className="h-open" onClick={() => void openRecord(h)}>
											<span className="h-title">{h.title || h.url || h.contentKey}</span>
											<span className="h-date">{fmtDate(h.at)}</span>
										</button>
										{/* 导出这一条的想法。没记过想法的行不出现——省得给一个按下去是空文件的按钮 */}
										{(h.notes ?? 0) > 0 && (
											<button
												type="button"
												className="export-btn h-export"
												disabled={exportKey !== null}
												title={`下载这条记录的 ${h.notes} 条想法,连同它们当时挂着的上下文`}
												onClick={() => void exportRecord(h)}
											>
												{exportKey === h.contentKey ? "正在取…" : ".md ↓"}
											</button>
										)}
									</li>
								))}
							</ol>
						)}
						{error && (
							<div className="error-box rise" role="alert">
								{error}
							</div>
						)}
					</section>
				) : (
					<>
						<section className="console rise rise-1" aria-label="收单">
							<textarea
								placeholder="粘贴链接(B站 / YouTube / 播客 / 文章),或直接把正文贴进来…"
								value={input}
								onChange={(e) => setInput(e.target.value)}
							/>
							<div className="console-row">
								{/* 页面上唯一的行动号召:与 001「试生成一期」同一枚版记章 */}
								<button type="button" className="btn-stamp" disabled={busy || input.trim().length === 0} onClick={() => void submit()}>
									<span className="mark" aria-hidden="true">
										▸
									</span>
									{busy ? "看着呢…" : "替我看"}
								</button>
								{/* 进度在页首状态行(001 同款):这里只留这一枚章 */}
							</div>
						</section>

						{error && (
							<div className="error-box rise" role="alert">
								{error}
								{login && (
									<>
										{" "}
										<a href={login}>去登录 →</a>
									</>
								)}
							</div>
						)}

						{result && (
							<section className="result">
								{result.meta.title && <h2 className="content-title rise">{result.meta.title}</h2>}

								<div className={`verdict rise rise-1 worth-${result.verdict.worth}`}>
									<span className="verdict-word">
										{result.verdict.worth === "yes" ? "值得看" : result.verdict.worth === "no" ? "可以跳过" : "部分值得"}
									</span>
									<p className="verdict-reason">{result.verdict.reason}</p>
								</div>

								{result.overview && (
									<section className="sec-card rise rise-2">
										<div className="sec-head">
											<span className="sec-no">{secNo("overview")}</span>
											<h2>导读</h2>
										</div>
										<div className="sec-body">
											<p className="ov-summary">{result.overview.summary}</p>
											<p className="ov-row">
												<span className="ov-label">有意思的是</span>
												{result.overview.interesting}
											</p>
											<p className="ov-row">
												<span className="ov-label ov-counter">反着想</span>
												{result.overview.counter}
											</p>
											{noteSpot("overview")}
										</div>
									</section>
								)}

								{notes && (
									<section className="sec-card rise rise-3" aria-label="详细笔记">
										<div className="sec-head">
											<span className="sec-no">{secNo("notes")}</span>
											<h2>详细笔记</h2>
											<span className="sec-count">
												{notes.filter((n) => n.body.length > 0).length} 章 · 约 {notesChars} 字
												{typeof result.meta.coverageGaps === "number" && result.meta.coverageGaps > 0 && ` · 补漏 ${result.meta.coverageGaps} 处`}
											</span>
										</div>
										<div className="sec-body">
											{notes.map((n) => {
												const ch = result.chapters[n.chapter];
												if (!ch) return null;
												const low = ch.value === "low";
												return (
													<article key={n.chapter} className={`note-ch${low ? " low" : ""}`}>
														<header className="note-ch-head">
															<span className="tc">
																{pos(
																	ch.start,
																	<>
																		{fmtPos(ch.start)}–{fmtPos(ch.end)}
																	</>,
																)}
															</span>
															<h3 className="note-title">
																{low ? ch.gist : n.title}
																{low && <span className="note-low-chip">低价值,略过</span>}
																{ch.tracked && <span className="tracked-chip">与你的追踪相关 · {ch.tracked}</span>}
															</h3>
														</header>
														{n.failed && <p className="note-failed">这一章的详写没成功——要点仍在,正文可点「重新生成」再试。</p>}
														{n.body.map((p, i) => (
															<p key={i} className="note-p">
																{p}
															</p>
														))}
														{n.points.length > 0 && (
															<ul className="kp-list note-pts">
																{n.points.map((kp, i) => (
																	<li key={i} className="kp">
																		<div className="kp-point">{kp.point}</div>
																		<div className="kp-quote">
																			「{kp.quote}」
																			{typeof kp.start === "number" && (
																				<>
																					{" · "}
																					{pos(kp.start, fmtPos(kp.start))}
																				</>
																			)}
																			{kp.anchored === false && (
																				<span className="anchor-chip" title="这句引文没能在本章原文里对上,引用前自己核一眼">
																					未锚定
																				</span>
																			)}
																		</div>
																	</li>
																))}
															</ul>
														)}
														{n.filled && <p className="note-filled">· 覆盖检查发现这一段原本没有要点,已补上</p>}
														{!low && noteSpot(`ch:${n.chapter}`)}
													</article>
												);
											})}
										</div>
									</section>
								)}

								{terms && (
									<section className="sec-card rise rise-3">
										<div className="sec-head">
											<span className="sec-no">{secNo("terms")}</span>
											<h2>术语表</h2>
											<span className="sec-count">{terms.length} 条</span>
										</div>
										<div className="sec-body">
											<dl className="terms">
												{terms.map((t, i) => (
													<div key={i} className="term">
														<dt>{t.term}</dt>
														<dd>{t.definition}</dd>
													</div>
												))}
											</dl>
										</div>
									</section>
								)}

								<section className="sec-card rise rise-3">
									<div className="sec-head">
										<span className="sec-no">{secNo("keyPoints")}</span>
										<h2>总体要点</h2>
										<span className="sec-count">{result.keyPoints.length} 条</span>
									</div>
									<div className="sec-body">
									<ul className="kp-list">
										{result.keyPoints.map((kp, i) => (
											<li key={i} className="kp">
												<div className="kp-point">{kp.point}</div>
												<div className="kp-quote">
													「{kp.quote}」
													{typeof kp.start === "number" && (
														<>
															{" · "}
															{pos(kp.start, fmtPos(kp.start))}
														</>
													)}
													{kp.anchored === false && (
															<span
																className="anchor-chip"
																title="这句引文没能在原文/转写稿里对上——观点仍是从内容里提的,但出处待核,引用前自己核一眼"
															>
																未锚定
															</span>
														)}
												</div>
												{noteSpot(`kp:${i}`)}
											</li>
										))}
									</ul>
									</div>
								</section>

								{!notes && (
								<section className="sec-card rise rise-4">
									<div className="sec-head">
										<span className="sec-no">{secNo("map")}</span>
										<h2>分段地图</h2>
										<span className="sec-count">
											{result.chapters.length} 段{lowAmount > 0 && ` · ${lowLabel}`}
										</span>
									</div>
									<div className="sec-body">
									<ol className="map">
										{result.chapters.map((ch, i) => (
											<li key={i} className={ch.value === "low" ? "low" : ""}>
												<span className="tc">
													{pos(
														ch.start,
														<>
															{fmtPos(ch.start)}–{fmtPos(ch.end)}
														</>,
													)}
												</span>
												<span className="gist">
													{ch.gist}
													{ch.tracked && <span className="tracked-chip">与你的追踪相关 · {ch.tracked}</span>}
													{noteSpot(`ch:${i}`)}
												</span>
											</li>
										))}
									</ol>
									</div>
								</section>
								)}

								<p className="meta-line rise rise-4">
									提取路径:{PATH_LABEL[result.meta.path] ?? result.meta.path}
									{result.meta.truncated && " · 内容过长已截断处理"}
									{!notes && !isText && " · 这份结果没有详细笔记(旧版),重新生成可得"}
									{loaded?.url && !isText && (
										<>
											{" · "}
											<a href={loaded.url} target="_blank" rel="noreferrer">
												打开原片 →
											</a>
										</>
									)}
									{/* 重新生成:001 简报页同款的一行灰字,不是第二枚章(一页只有一枚)。
									    只对有链接的内容开放——粘贴正文没有可回源的原文。 */}
									{loaded?.url && loaded.contentKey && !busy && (
										<>
											{" · "}
											<button
												type="button"
												className="regen"
												title="重算这条,花一次今日额度;你的想法不会丢"
												onClick={() => void submit({ regenUrl: loaded.url })}
											>
												重新生成 ↻
											</button>
										</>
									)}
								</p>

								{canNote && (
									<section className="sec-card rise rise-4">
										<div className="sec-head">
											<span className="sec-no">{secNo("mine")}</span>
											<h2>我的想法</h2>
											{/* 导出:自己的想法自己拿得走。没记过就不出现,别给一个按下去是空文件的按钮 */}
											{(note?.entries.length ?? 0) > 0 && (
												<button
													type="button"
													className="export-btn"
													title="下载一份 Markdown:你的想法 + 它当时挂着的那段上下文(判决、导读、对应的要点与引文)"
													onClick={exportCurrent}
												>
													导出 .md ↓
												</button>
											)}
										</div>
										<div className="sec-body">
											{/* 版本对不上的定点想法沉到这里:标注原锚点,内容一字不动 */}
											{orphanNotes.map((e) => (
												<div key={e.at} className="note-entry">
													<span className="note-meta">
														{fmtDate(e.at)} · 记于上一版结果 · 原挂在「{targetLabel(e.target)}」
													</span>
													{e.text}
													<button type="button" className="note-del" aria-label="删除这条想法" onClick={() => void delNote(e.at)}>
														×
													</button>
												</div>
											))}
											{noteSpot("general", true)}
										</div>
									</section>
								)}

								{canJumpText && (
									<div className="rise rise-4">
										<button type="button" className="source-toggle" onClick={() => setShowSource(!showSource)}>
											{showSource ? "收起原文" : "展开原文(点要点或分段的段号可直接定位)"}
										</button>
										{showSource && (
											<div className="source">
												{loaded!.paragraphs!.map((p, i) => (
													<p key={i} id={`para-${i + 1}`}>
														<span className="pn">§{i + 1}</span>
														{p}
													</p>
												))}
											</div>
										)}
									</div>
								)}

								{/* 终点戳(001「今日到此为止」同款):这一条到此读完 */}
								<footer className="endnote rise rise-4">
									<div className="end-stamp">
										替你
										<br />
										看完
									</div>
									<p className="endnote-meta">nanisle 每周一个产品 · 002 长视频总结</p>
								</footer>
							</section>
						)}
					</>
				)}

				<footer className="site-footer">
					An island of <a href="https://nanisle.com">nanisle.com</a> · open source ·{" "}
					<a href="https://github.com/AI-Nanisle/nanisle-product">fork me</a>
				</footer>
			</main>
		</div>
	);
}
