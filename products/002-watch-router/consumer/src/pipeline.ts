// 慢车道消费者管线(docs/03 C2-C4;移植自 kb-agent 的字幕优先做法):
//   字幕优先(yt-dlp --write-subs,拿到就零转写成本)
//   → 兜底 whisper(yt-dlp 下音频 → ffmpeg 压 32kbps 单声道 → Groq verbose_json 拿时间戳)
//   → editTranscript 一次调用出 T4 schema → quote 锚定 → 回程 complete。
//
// 失败语义:管线内的一切失败都走 reportComplete({error})——显式告诉用户,
// 不留给 SQS 重试烧钱;只有「回程本身失败」才向上抛,交给 SQS 重投。

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorKeyPoints } from "../../src/shared/anchor";
import { editTranscriptWithSource } from "../../src/shared/editor";
import type { TranscriptSegment } from "../../src/shared/editor";
import { buildNotes } from "../../src/shared/notes";
import { applyOwnerRoute } from "../../src/shared/ai";
import type { AiConfig, OwnerRoute } from "../../src/shared/ai";
import { reportComplete, reportProgress } from "./callbacks";
import type { CallbackConfig } from "./callbacks";

export interface TaskMessage {
	taskId: string;
	url: string;
	contentKey: string;
	platform: string;
	/** 提交任务的账号(老消息可能没有)。只用于站长专线路由,不做鉴权。 */
	email?: string;
	/** 订阅挑选时 RSS 给的标题;yt-dlp 对裸音频链接只能给一串 id 时用它。 */
	title?: string;
}

/** yt-dlp 对裸 mp3 链接给的「标题」是路径末段/UUID——不是标题,别写进结果。 */
function usableTitle(t: string | undefined, fallback?: string): string | undefined {
	if (t && !/^[0-9a-f-]{20,}$/i.test(t) && !/^[\w-]+\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(t)) return t;
	return fallback ?? t;
}

export interface PipelineConfig extends CallbackConfig {
	ai: AiConfig;
	/** 轻任务档(覆盖补漏用,docs/05 §2.2 第 6 条)。 */
	fastAi: AiConfig;
	/** 站长专线(主仓 backend/docs/01);null/未设 = 没配。 */
	ownerRoute?: OwnerRoute | null;
	groqApiKey?: string;
	/** 只对 YouTube 生效的住宅代理(docs/02 T9);不设 = 直连。 */
	proxyUrl?: string;
}

/** 跑外部命令,返回 stdout;非零退出抛错(stderr 截断进错误信息)。 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${cmd} 超时(${timeoutMs / 1000}s)`));
		}, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`${cmd} exit ${code}: ${err.slice(-400)}`));
		});
	});
}

// 走代理的平台:02 T9 原判断只有 YouTube,但 B站从 AWS IP 访问一律 412
// Precondition Failed(风控拦数据中心 IP 段,2026-08-26 云端实测)——假设被
// 推翻,B站同样全程走代理。流量账:音频 32kbps 下 1 小时视频约 14MB,
// 1GB 池约 70 小时视频,内测期充裕;播客/裸音频直链仍直连省流量。
const PROXIED_PLATFORMS = new Set(["youtube", "bilibili"]);

function ytdlpArgs(cfg: PipelineConfig, platform: string, extra: string[]): string[] {
	const proxy = PROXIED_PLATFORMS.has(platform) && cfg.proxyUrl ? ["--proxy", cfg.proxyUrl] : [];
	return [...proxy, "--no-warnings", ...extra];
}

/** VTT 时间戳 "00:01:23.456" → 秒。 */
function vttTime(s: string): number {
	const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
	if (!m) return 0;
	return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 解析 VTT → 按 ~20 秒窗合并的转写段。自动字幕的 cue 会滚动重复上一行,
 * 相邻去重后再合并,不然同一句话进模型三遍。
 */
export function parseVtt(vtt: string): TranscriptSegment[] {
	const cues: { start: number; text: string }[] = [];
	const blocks = vtt.split(/\r?\n\r?\n/);
	// YouTube 自动字幕的滚动形态:每个 cue 两行,第二行是新话、第一行是上一
	// cue 的第二行原样重复。按整 cue 比对(startsWith/endsWith)拦不住这种
	// 「半重复」,结果一句话进模型两遍、模型引用时自己去重、锚定就配不上了
	// (2026-08-28 Karpathy 实测 11/60 要点因此未锚定)。改为按行去重:一行
	// 只要和最近吐出的两行之一相同就丢。
	const recent: string[] = [];
	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		const timeIdx = lines.findIndex((l) => l.includes("-->"));
		if (timeIdx < 0) continue;
		const start = vttTime(lines[timeIdx].split("-->")[0]);
		const fresh: string[] = [];
		for (const raw of lines.slice(timeIdx + 1)) {
			const line = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
			if (!line || recent.includes(line)) continue;
			fresh.push(line);
			recent.push(line);
			if (recent.length > 2) recent.shift();
		}
		const text = fresh.join(" ");
		if (!text) continue;
		cues.push({ start, text });
	}
	// 合并进 ~20 秒窗
	const segments: TranscriptSegment[] = [];
	for (const cue of cues) {
		const last = segments[segments.length - 1];
		if (last && cue.start - last.start < 20) {
			last.text += " " + cue.text;
		} else {
			segments.push({ start: cue.start, text: cue.text });
		}
	}
	return segments;
}

/**
 * 字幕优先:逐语言尝试(zh 优先退 en),拿到第一份可用的就停。
 * 为什么不用通配 sub-langs 一把抓:通配会匹配十几条语言轨,每条都是一次
 * 下载请求,YouTube 对字幕接口限流很凶,任何一条 429 都会让整个 yt-dlp
 * 调用失败(实测)——逐语言尝试让单条失败只损失一次机会。
 */
async function fetchSubtitles(cfg: PipelineConfig, msg: TaskMessage, dir: string): Promise<TranscriptSegment[] | null> {
	const langGroups = ["zh-Hans,zh-CN,zh", "en,en-US,en-orig"];
	for (const [i, langs] of langGroups.entries()) {
		try {
			await run(
				"yt-dlp",
				ytdlpArgs(cfg, msg.platform, [
					"--skip-download",
					"--write-subs",
					"--write-auto-subs",
					"--sub-langs",
					langs,
					"--sub-format",
					"vtt",
					"-o",
					join(dir, `subs${i}.%(ext)s`),
					msg.url,
				]),
				120_000,
			);
		} catch (err) {
			console.log(`subtitles(${langs}) fetch failed: ${(err as Error).message.slice(-160)}`);
			continue;
		}
		const files = (await readdir(dir)).filter((f) => f.startsWith(`subs${i}`) && f.endsWith(".vtt"));
		if (files.length === 0) continue;
		const vtt = await readFile(join(dir, files[0]), "utf8");
		const segments = parseVtt(vtt);
		if (segments.length >= 3) return segments;
	}
	return null;
}

/** whisper 兜底:下音频 → 压 32kbps 单声道 → Groq verbose_json(带分段时间戳)。 */
async function transcribeWithWhisper(
	cfg: PipelineConfig,
	msg: TaskMessage,
	dir: string,
): Promise<TranscriptSegment[]> {
	if (!cfg.groqApiKey) throw new Error("这条内容没有字幕,而 whisper 转写未配置(GROQ_API_KEY)");
	const raw = join(dir, "audio.m4a");
	await run(
		"yt-dlp",
		ytdlpArgs(cfg, msg.platform, ["-f", "bestaudio/best", "-x", "--audio-format", "m4a", "-o", raw, msg.url]),
		600_000,
	);
	const mp3 = join(dir, "audio.mp3");
	// 32kbps 单声道:一小时约 14MB,压进 Groq 的上传上限(docs/02 T5)
	await run("ffmpeg", ["-i", raw, "-vn", "-ac", "1", "-b:a", "32k", "-y", mp3], 300_000);
	const size = (await stat(mp3)).size;
	console.log(`audio ready: ${Math.round(size / 1024 / 1024)}MB`);

	const form = new FormData();
	form.append("file", new Blob([await readFile(mp3)]), "audio.mp3");
	form.append("model", "whisper-large-v3");
	form.append("response_format", "verbose_json");
	const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
		method: "POST",
		headers: { authorization: `Bearer ${cfg.groqApiKey}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { segments?: { start: number; text: string }[] };
	const segments = (data.segments ?? [])
		.map((s) => ({ start: Math.round(s.start), text: s.text.trim() }))
		.filter((s) => s.text.length > 0);
	if (segments.length === 0) throw new Error("whisper 返回了空转写");
	return segments;
}

/** 元数据(时长/标题)。失败不致命,返回空。 */
async function fetchMeta(cfg: PipelineConfig, msg: TaskMessage): Promise<{ duration?: number; title?: string }> {
	try {
		const out = await run(
			"yt-dlp",
			ytdlpArgs(cfg, msg.platform, ["--skip-download", "--print", "%(duration)s\t%(title)s", msg.url]),
			60_000,
		);
		const [d, ...t] = out.trim().split("\t");
		return { duration: Number(d) || undefined, title: t.join("\t") || undefined };
	} catch {
		return {};
	}
}

/** 结果页原文区用的转写段落:每段 "[mm:ss] 文本"。总量封顶防 KV 值超限。 */
function transcriptParagraphs(segments: TranscriptSegment[]): string[] {
	const out: string[] = [];
	let total = 0;
	for (const s of segments) {
		const m = Math.floor(s.start / 60);
		const sec = String(Math.floor(s.start % 60)).padStart(2, "0");
		const line = `[${m}:${sec}] ${s.text}`;
		total += line.length;
		if (total > 400_000) break;
		out.push(line);
	}
	return out;
}

/** 一条任务从领到交的全过程。回程失败之外的一切错误都被吞进 complete({error})。 */
export async function processTask(msg: TaskMessage, cfg: PipelineConfig): Promise<void> {
	console.log(`task ${msg.taskId}: ${msg.platform} ${msg.url}`);
	const first = await reportProgress(cfg, msg.taskId, "downloading");
	if (first.alreadyDone) {
		console.log(`task ${msg.taskId} already done, skip(重投的旧消息)`);
		return;
	}

	// /tmp 在 warm Lambda 间不清空,每任务独立目录 + finally 清理(docs/03 C2)
	const dir = await mkdtemp(join(tmpdir(), "watch-"));
	try {
		let segments: TranscriptSegment[];
		let path: "subtitle" | "whisper";
		try {
			const meta = await fetchMeta(cfg, msg);
			const subs = await fetchSubtitles(cfg, msg, dir);
			if (subs) {
				segments = subs;
				path = "subtitle";
			} else {
				await reportProgress(cfg, msg.taskId, "transcribing", "whisper");
				segments = await transcribeWithWhisper(cfg, msg, dir);
				path = "whisper";
			}

			await reportProgress(cfg, msg.taskId, "editing", path);
			// 站长专线:按提交账号决定这条任务的编辑走哪套 provider(带 fallback)
			const ai = applyOwnerRoute(msg.email, cfg.ai, cfg.ownerRoute ?? null);
			const fastAi = applyOwnerRoute(msg.email, cfg.fastAi, cfg.ownerRoute ?? null, "fast");
			// ① 大纲(判决/导读/要点/分段/术语表)
			const edited = await editTranscriptWithSource(ai, {
				title: usableTitle(meta.title, msg.title),
				segments,
				path,
				durationSec: meta.duration,
			});
			let result = anchorKeyPoints(edited.result, segments.map((s) => s.text).join("\n"));
			// ② 逐章详写 + 覆盖补漏(docs/05 §2.2)。每章完成报一次进度:Worker 侧
			// 的超时按「10 分钟无进展」判,长视频十几章的详写靠这个心跳活着
			result = await buildNotes(ai, fastAi, {
				kind: "transcript",
				source: edited.source,
				result,
				segments: edited.segments,
				durationSec: edited.durationSec,
				onChapter: async (done, total) => {
					console.log(`notes ${done}/${total}`);
					await reportProgress(cfg, msg.taskId, "editing", path).catch(() => {});
				},
			});

			await reportComplete(cfg, msg.taskId, {
				result,
				path,
				paragraphs: transcriptParagraphs(segments),
			});
			console.log(`task ${msg.taskId} done: path=${path} segments=${segments.length}`);
		} catch (err) {
			const message = (err as Error).message.slice(0, 300);
			console.error(`task ${msg.taskId} failed: ${message}`);
			await reportComplete(cfg, msg.taskId, { error: message });
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
