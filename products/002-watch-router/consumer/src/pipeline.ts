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
import { editTranscript } from "../../src/shared/editor";
import type { TranscriptSegment } from "../../src/shared/editor";
import type { AiConfig } from "../../src/shared/ai";
import { reportComplete, reportProgress } from "./callbacks";
import type { CallbackConfig } from "./callbacks";

export interface TaskMessage {
	taskId: string;
	url: string;
	contentKey: string;
	platform: string;
}

export interface PipelineConfig extends CallbackConfig {
	ai: AiConfig;
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

function ytdlpArgs(cfg: PipelineConfig, platform: string, extra: string[]): string[] {
	const proxy = platform === "youtube" && cfg.proxyUrl ? ["--proxy", cfg.proxyUrl] : [];
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
	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		const timeIdx = lines.findIndex((l) => l.includes("-->"));
		if (timeIdx < 0) continue;
		const start = vttTime(lines[timeIdx].split("-->")[0]);
		const text = lines
			.slice(timeIdx + 1)
			.join(" ")
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		const prev = cues[cues.length - 1];
		if (prev && (text === prev.text || text.startsWith(prev.text) || prev.text.endsWith(text))) {
			// 滚动字幕重复:保留信息量更大的那条
			if (text.length > prev.text.length) prev.text = text;
			continue;
		}
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
			let result = await editTranscript(cfg.ai, {
				title: meta.title,
				segments,
				path,
				durationSec: meta.duration,
			});
			result = anchorKeyPoints(result, segments.map((s) => s.text).join("\n"));

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
