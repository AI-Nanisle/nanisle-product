// 值导入必须带 .ts:CLI(node --experimental-strip-types 直跑)不做无扩展名解析,
// 只有 type 导入才能省(运行时被剥掉)。Vite/esbuild/tsc 对两种写法都无感。
import { focusEntryToTracker } from "./pipeline-core.ts";
import type { Filters, FocusEntry, SourceConfig, Tracker } from "./pipeline-core";

/**
 * Seed configuration. The worker copies these into KV on first use; from
 * then on the web UI (配置 page) is the source of truth. The CLI pipeline
 * prefers sources.yaml when present and falls back to these.
 *
 * Fetching is honest: a descriptive User-Agent, no browser impersonation.
 * Notes:
 * - Anthropic has no official RSS; the Olshansk/rss-feeds mirror regenerates
 *   hourly (https://github.com/Olshansk/rss-feeds).
 * - BLS RSS 403s every non-browser client (impersonation doesn't help), so
 *   macro coverage comes from the Fed press feed + Calculated Risk.
 */
export const DEFAULT_SOURCES: SourceConfig[] = [
	// --- news ---
	{ key: "anthropic-news", name: "Anthropic News", url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml", category: "news" },
	{ key: "openai-news", name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "news" },
	{ key: "deepmind", name: "Google DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", category: "news" },
	// --- macro / economy ---
	{ key: "fed-press", name: "Federal Reserve Press", url: "https://www.federalreserve.gov/feeds/press_all.xml", category: "macro" },
	{ key: "calculated-risk", name: "Calculated Risk", url: "https://www.calculatedriskblog.com/feeds/posts/default?alt=rss", category: "macro" },
	// --- blogs / analysis ---
	{ key: "simonwillison", name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "blog" },
	{ key: "interconnects", name: "Interconnects (Nathan Lambert)", url: "https://www.interconnects.ai/feed", category: "blog" },
	{ key: "one-useful-thing", name: "One Useful Thing (Ethan Mollick)", url: "https://www.oneusefulthing.org/feed", category: "blog" },
	{ key: "import-ai", name: "Import AI (Jack Clark)", url: "https://importai.substack.com/feed", category: "blog" },
	{ key: "stratechery", name: "Stratechery (Ben Thompson)", url: "https://stratechery.com/feed/", category: "blog" },
	{ key: "ben-evans", name: "Benedict Evans", url: "https://www.ben-evans.com/benedictevans?format=rss", category: "blog" },
	{ key: "pragmatic-engineer", name: "The Pragmatic Engineer (Gergely Orosz)", url: "https://newsletter.pragmaticengineer.com/feed", category: "blog" },
	{ key: "ai-snake-oil", name: "AI Snake Oil (Narayanan & Kapoor)", url: "https://www.aisnakeoil.com/feed", category: "blog" },
	// --- podcasts whose feeds carry full text (no transcription needed) ---
	{ key: "latent-space", name: "Latent Space", url: "https://www.latent.space/feed", category: "podcast", lang: "en" },
	{ key: "dwarkesh", name: "Dwarkesh Podcast", url: "https://www.dwarkesh.com/feed", category: "podcast", lang: "en" },
	// --- papers ---
	{ key: "arxiv-cs-ai", name: "arXiv cs.AI (daily)", url: "https://rss.arxiv.org/rss/cs.AI", category: "paper", max_items: 25 },
];

export const DEFAULT_FILTERS: Filters = {
	// Entries older than this never enter the candidate pool. 30h > 24h so a
	// slightly late daily run still catches yesterday's late posts.
	max_age_hours: 30,
	// 类目窗口:news/macro 用上面的 30h;周更的博客/播客放宽到 7 天,论文 3 天。
	// 否则 Stratechery 这类周更源在日更窗口里几乎永远零贡献。重复入选由
	// dropSeenCandidates 按往期简报挡住(SEEN_WINDOW_DAYS 与这里的最大值对齐)。
	category_max_age_hours: { blog: 168, podcast: 168, paper: 72 },
	// Per-feed cap before any model sees anything (token-cost guard).
	max_items_per_feed: 10,
	// Title hits (case-insensitive) are dropped by rule, before the model.
	noise_keywords: [
		"webinar",
		"we're hiring",
		"hiring",
		"join us",
		"sponsor",
		"giveaway",
		"event recap",
		"招聘",
		"直播预告",
	],
};

/** Legacy v1 shape — only feeds DEFAULT_TRACKERS below (KV `config:focus` migration happens in worker/config.ts). */
const DEFAULT_FOCUS: FocusEntry[] = [
	{ name: "本周产品", detail: "正在做一个每日简报工具,关心信息聚合产品的留存设计、反馈回路、RSS 生态" },
	{ name: "长期投资", detail: "持有指数基金和一只保险控股股,关心利率、通胀数据和市场估值水平" },
	{ name: "内容创作", detail: "每周写 AI 实践类短文,需要有细节的一手案例,不要二手转述" },
];

/**
 * 演示用追踪器,只服务 CLI(`pipeline/generate.ts`)和 fork 后的零配置本地
 * 跑通。Web 端不再种任何追踪器:新用户进来是一张白纸,第一份定义由向导问
 * 出来(什么值得长期追踪是用户的事,不该由种子数据替他决定)。
 */
export const DEMO_TRACKERS: Tracker[] = [
	{
		key: "headlines",
		name: "今日大事",
		question: "当天真正重要的行业事件和宏观数据发布,不错过大事,但只要真正的大事",
		exclude: ["招聘", "webinar"],
		quota: 3,
	},
	{
		key: "learn",
		name: "教我新东西",
		question: "论文、深度播客、博主观点——允许和当下项目无关,但必须说得清『新在哪』",
		quota: 3,
	},
];

export const DEFAULT_TRACKERS: Tracker[] = [
	...DEMO_TRACKERS,
	...DEFAULT_FOCUS.map(focusEntryToTracker),
];
