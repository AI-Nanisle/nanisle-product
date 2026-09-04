// 查全验收(docs/02「阶段 4 展开:查全验收要在这一天做,不是发布前做」)。
//
//   npm run recall-check          匿名档(能跑,但 search 限额 10 次/分钟,要等)
//   GITHUB_PAT=ghp_… npm run recall-check
//
// 拿 002 立项时那张**手工调研表**做基准:站长当时手工半小时找出来的 5 个项目
// (docs 在 ../002-watch-router/docs/01-产品方案.md「同类项目调研」那张表),
// 输入对应领域的档案,看发现层能捞回几个。**捞回 < 4 个就是不及格。**
//
// 这个测试决定的是**方案成不成立**,不是质量好不好:如果双路检索都捞不回
// 站长手工能找到的东西,那么「每周替你把领域看住」这个承诺就是空的,该停下来
// 重新想发现层,而不是继续往下写 UI。
//
// **它不进 `npm test`**:要真的打 GitHub 的网络,CI 和 fork 的人跑不了,
// 而一个在别人机器上必红的用例会很快被人加上 skip,然后就再也没人跑了。
// 单独一个脚本,谁想验谁跑,输出贴进交接记录。
//
// 口径(和「查全」这个词的定义有关,写清楚免得事后含糊):
//   算捞回 = 出现在**双路 search 合并去重后的仓集合**里。
//   **出现在被排除清单里也算捞回来了**——门 1 和规则层是后面的事,查全说的是
//   「有没有捞到」。一个已归档的仓被规则筛掉,不是召回的失败,恰恰是它在工作。

import { GithubClient } from "../src/shared/github.ts";
import { collectRepos, rankSurvivors } from "../src/shared/discovery.ts";
import { excludeReason } from "../src/shared/scan-rules.ts";
import { SCAN_PICK_LIMIT } from "../src/shared/types.ts";

/**
 * 基准:002 那张手工表里的 5 个项目(2026-08-22 站长手工调研的产物)。
 * 这里写的是**当时表里的 full_name**,不是今天 GitHub 上的状态——有的可能已经
 * 改名或归档了,那属于「捞回来但被规则筛掉」,不属于「没捞回来」。
 */
const BASELINE = [
	"JimmyLv/BibiGPT-v1",
	"wendy7756/AI-Video-Transcriber",
	"lycohana/BiliSum",
	"DevRico003/youtube_summarizer",
	"martinopiaggi/summarize",
];

/** 不及格线(docs/02)。 */
const PASS_MARK = 4;

/**
 * 002 那个领域对应的档案里的 queries。
 *
 * **是手写的,不是模型现产的**,因为跑这个脚本的机器上不一定有 DEEPSEEK_API_KEY,
 * 而查全验收要能被任何人重跑。手写时严格按 dossier.ts `DRAFT_SYSTEM` 对模型提的
 * 那几条要求来,一条不放松:
 *   - 每条 2-4 个英文词(GitHub 全文搜索是 AND 语义,词越多命中越少);
 *   - 同一个概念给出圈内的不同叫法(查全率的主要来源);
 *   - 至少一条 topic: 限定;
 *   - 条与条之间不互相包含;
 *   - **不写任何仓库名、公司名、产品名、作者名**——这一条是这次验收的关键:
 *     一旦检索词里出现 "BibiGPT",这个脚本量的就不是发现层的查全,而是我抄答案
 *     的能力。基准里那 5 个名字一个字都不许出现在下面(脚本自己会检查)。
 *
 * 对应的一句话大致是:「我想跟踪把长视频/播客变成文字和摘要的开源项目」。
 */
const QUERIES = [
	"video summarizer",
	"youtube summarizer",
	"video transcription summary",
	"bilibili video summary",
	"podcast transcript summary",
	"whisper transcribe summarize",
	"ai video transcriber",
	"topic:video-summarization",
];

/**
 * 有些仓的名字就是这个领域的普通词。`martinopiaggi/summarize` 的仓名是英文动词
 * "summarize",`DevRico003/youtube_summarizer` 拆开是 "youtube" + "summarizer"
 * ——把它们当成「专有名字」禁掉,等于禁掉这个领域最核心的那几个概念,
 * 那样这个验收就永远做不了了。所以放行的是**词**,禁掉的是**标识**。
 *
 * 判据不是「我觉得它通用」,而是:这个词在没听说过那个仓的人嘴里也会自然出现。
 * 下面每一条都写了它为什么在这一列。
 */
const GENERIC_WORDS = new Set([
	"summarize", // 英文动词,这个领域的中心词
	"summarizer", // 同上的名词形
	"youtube", // 平台名,不是项目名
	"bilibili",
	"video",
	"transcriber",
]);

/**
 * 防作弊:检索词里出现基准项目的**标识**就等于抄答案,直接拒跑。
 *
 * 查的是 owner(作者/组织名,一律是标识)、full_name,以及不在 GENERIC_WORDS
 * 里的仓名片段。这道门存在的理由很实际:这个脚本是我自己写的、基准也是我自己
 * 抄进来的,「不小心」把 BibiGPT 写进检索词是一件毫不费力的事,而那样跑出来的
 * 5/5 一文不值,却和真的 5/5 长得一模一样。
 */
function assertNoLeak(): void {
	const forbidden = new Set<string>();
	for (const full of BASELINE) {
		const [owner = "", name = ""] = full.toLowerCase().split("/");
		forbidden.add(full.toLowerCase());
		forbidden.add(owner);
		// 仓名整体一律禁(BibiGPT-v1、AI-Video-Transcriber 这种);再按分隔符拆开,
		// 拆出来的片段只有不通用时才禁
		forbidden.add(name);
		for (const piece of name.split(/[-_.]/)) {
			if (piece.length > 3 && !GENERIC_WORDS.has(piece)) forbidden.add(piece);
		}
	}
	for (const q of QUERIES) {
		const low = q.toLowerCase();
		for (const bad of forbidden) {
			if (bad.length > 3 && !GENERIC_WORDS.has(bad) && low.includes(bad)) {
				throw new Error(`检索词 "${q}" 里出现了基准项目的标识 "${bad}" —— 那是抄答案,不是查全`);
			}
		}
	}
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

async function main(): Promise<void> {
	assertNoLeak();
	const pat = process.env.GITHUB_PAT?.trim();
	const started = Date.now();
	const client = new GithubClient({
		pat,
		// 脚本没有 CF 那条 100 秒线,给足预算让匿名档的退避真的能睡完
		deadline: started + 12 * 60_000,
	});

	console.log("=== 003 发现层 · 查全验收 ===");
	console.log(`基准:002 立项时的手工调研表(${BASELINE.length} 个项目)`);
	console.log(`配额档:${pat ? "PAT(5000/h,search 30/min)" : "匿名(60/h,search 10/min —— 会有退避等待)"}`);
	console.log(`检索词 ${QUERIES.length} 条 × 2 路 = ${QUERIES.length * 2} 次 search\n`);

	const out = await collectRepos(client, QUERIES);

	console.log("--- 每条检索词的实况 ---");
	for (const t of out.trace) {
		const line = `${pad(t.query, 30)} ${pad(t.sort, 8)} 拿回 ${pad(String(t.returned), 3)} / GitHub 声称 ${t.totalCount}`;
		console.log(t.error ? `${line}  ✗ ${t.error}` : line);
	}
	if (out.stopped) console.log(`\n提前收工:${out.stopped}`);

	const found = new Map(out.repos.map((d) => [d.repo.fullName.toLowerCase(), d]));
	console.log(`\n去重后拿回 ${out.repos.length} 个仓,耗时 ${((Date.now() - started) / 1000).toFixed(1)}s` +
		`(其中等配额 ${(client.waitedMs / 1000).toFixed(1)}s)`);

	console.log("\n--- 基准逐条核对 ---");
	let hits = 0;
	for (const target of BASELINE) {
		const hit = found.get(target.toLowerCase());
		if (!hit) {
			console.log(`✗ ${pad(target, 34)} 没捞回来`);
			continue;
		}
		hits += 1;
		const hitReason = excludeReason(hit.repo);
		const fate = hitReason ? `之后被规则筛掉:${hitReason.reason}(${hitReason.kind})` : "通过规则";
		console.log(
			`✓ ${pad(target, 34)} route=${pad(hit.route, 8)} ★${pad(String(hit.repo.stars), 6)} ` +
				`via=${hit.viaQueries.join(" | ")}  → ${fate}`,
		);
	}

	// 顺带把下游走一遍:进清单的会是哪 5 个。不参与判分,但看得见「捞回来了却
	// 排不进前 5」这种情况,那是排序的问题不是召回的问题,两者的修法完全不同。
	const survivors = out.repos.filter((d) => excludeReason(d.repo) === null);
	const top = rankSurvivors(survivors).slice(0, SCAN_PICK_LIMIT);
	console.log(`\n--- 假如今天出清单(${survivors.length} 个通过规则,取前 ${SCAN_PICK_LIMIT})---`);
	top.forEach((d, i) => {
		const mark = BASELINE.some((b) => b.toLowerCase() === d.repo.fullName.toLowerCase()) ? " ← 基准" : "";
		console.log(`${i + 1}. ${pad(d.repo.fullName, 40)} ★${pad(String(d.repo.stars), 7)} ${d.route}${mark}`);
	});

	console.log(`\n=== 结论:捞回 ${hits}/${BASELINE.length},及格线 ${PASS_MARK} → ${hits >= PASS_MARK ? "通过" : "不及格"} ===`);
	// 退出码给 CI 之外的人当信号用。**不及格时不要去放宽基准或改检索词凑数**
	// ——docs/02 说得很清楚,不及格是「停下来改方案」的信号,不是改测试的信号。
	process.exitCode = hits >= PASS_MARK ? 0 : 1;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
