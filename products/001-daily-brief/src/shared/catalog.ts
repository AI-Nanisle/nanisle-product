// B13 · 精选 feed 目录(docs/02-技术方案.md §7.3 第 2 层)。整份进找源提示词,
// 模型优先从这里挑——从目录里挑不存在编造。TS 模块而非 yaml:Worker 运行时
// 读不了文件,而这份数据本来就要进代码打包。
//
// 收录标准:知名、长期维护、feed 格式稳定的源。首版按知名度人工挑选;每个
// 候选在展示给用户前都会被 probeFeed 真实试抓,所以目录里烂掉一条的代价只是
// 少一个候选,不会把死链带到用户面前。定期全量巡检是主仓 infra/ 的 D7 脚本
// (catalog-probe.ps1)的活。

import type { SourceConfig } from "./pipeline-core";

export interface CatalogEntry {
	name: string;
	url: string;
	category: SourceConfig["category"];
	/** 主题标签,进找源提示词帮模型按主题挑。 */
	topics: string[];
	lang: "en" | "zh";
}

export const CATALOG: CatalogEntry[] = [
	// --- AI 实验室与官方动态 ---
	{ name: "Anthropic News", url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml", category: "news", topics: ["ai", "llm"], lang: "en" },
	{ name: "OpenAI News", url: "https://openai.com/news/rss.xml", category: "news", topics: ["ai", "llm"], lang: "en" },
	{ name: "Google DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", category: "news", topics: ["ai", "research"], lang: "en" },
	{ name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/", category: "news", topics: ["ai"], lang: "en" },
	{ name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", category: "blog", topics: ["ai", "open-source", "ml-engineering"], lang: "en" },
	{ name: "Berkeley AI Research (BAIR)", url: "https://bair.berkeley.edu/blog/feed.xml", category: "blog", topics: ["ai", "research"], lang: "en" },

	// --- 科技新闻 ---
	{ name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "news", topics: ["startup", "tech", "vc"], lang: "en" },
	{ name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "news", topics: ["tech", "consumer"], lang: "en" },
	{ name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "news", topics: ["tech", "science"], lang: "en" },
	{ name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "news", topics: ["tech", "ai", "science"], lang: "en" },
	{ name: "IEEE Spectrum", url: "https://spectrum.ieee.org/feeds/feed.rss", category: "news", topics: ["hardware", "engineering", "science"], lang: "en" },
	{ name: "Techmeme", url: "https://www.techmeme.com/feed.xml", category: "news", topics: ["tech", "aggregator"], lang: "en" },
	{ name: "Hacker News Frontpage (≥100 分)", url: "https://hnrss.org/frontpage?points=100", category: "news", topics: ["tech", "dev", "startup"], lang: "en" },

	// --- 工程与开发者博客 ---
	{ name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "blog", topics: ["ai", "dev", "llm"], lang: "en" },
	{ name: "GitHub Blog", url: "https://github.blog/feed/", category: "blog", topics: ["dev", "open-source"], lang: "en" },
	{ name: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "blog", topics: ["infra", "dev", "security"], lang: "en" },
	{ name: "AWS News Blog", url: "https://aws.amazon.com/blogs/aws/feed/", category: "blog", topics: ["infra", "cloud"], lang: "en" },
	{ name: "Netflix TechBlog", url: "https://netflixtechblog.com/feed", category: "blog", topics: ["infra", "engineering"], lang: "en" },
	{ name: "Julia Evans", url: "https://jvns.ca/atom.xml", category: "blog", topics: ["dev", "debugging"], lang: "en" },
	{ name: "Martin Fowler", url: "https://martinfowler.com/feed.atom", category: "blog", topics: ["dev", "architecture"], lang: "en" },
	{ name: "The Pragmatic Engineer", url: "https://newsletter.pragmaticengineer.com/feed", category: "blog", topics: ["dev", "engineering-org", "career"], lang: "en" },
	{ name: "Overreacted (Dan Abramov)", url: "https://overreacted.io/rss.xml", category: "blog", topics: ["dev", "frontend"], lang: "en" },

	// --- AI 分析与评论 ---
	{ name: "Interconnects (Nathan Lambert)", url: "https://www.interconnects.ai/feed", category: "blog", topics: ["ai", "llm", "research"], lang: "en" },
	{ name: "One Useful Thing (Ethan Mollick)", url: "https://www.oneusefulthing.org/feed", category: "blog", topics: ["ai", "productivity"], lang: "en" },
	{ name: "Import AI (Jack Clark)", url: "https://importai.substack.com/feed", category: "blog", topics: ["ai", "policy"], lang: "en" },
	{ name: "AI Snake Oil", url: "https://www.aisnakeoil.com/feed", category: "blog", topics: ["ai", "policy", "critique"], lang: "en" },
	{ name: "Sebastian Raschka", url: "https://magazine.sebastianraschka.com/feed", category: "blog", topics: ["ai", "ml-engineering", "research"], lang: "en" },
	{ name: "Chip Huyen", url: "https://huyenchip.com/feed.xml", category: "blog", topics: ["ai", "ml-engineering"], lang: "en" },

	// --- 商业与创业 ---
	{ name: "Stratechery (Ben Thompson)", url: "https://stratechery.com/feed/", category: "blog", topics: ["business", "strategy", "tech"], lang: "en" },
	{ name: "Benedict Evans", url: "https://www.ben-evans.com/benedictevans?format=rss", category: "blog", topics: ["business", "strategy"], lang: "en" },
	{ name: "Paul Graham Essays", url: "http://www.aaronsw.com/2002/feeds/pgessays.rss", category: "blog", topics: ["startup", "essay"], lang: "en" },
	{ name: "Lenny's Newsletter", url: "https://www.lennysnewsletter.com/feed", category: "blog", topics: ["product", "growth"], lang: "en" },
	{ name: "Not Boring (Packy McCormick)", url: "https://www.notboring.co/feed", category: "blog", topics: ["business", "strategy"], lang: "en" },
	// a16z 已删:官网 feed 404,无可用替代(2026-08-16 D7 巡检)

	// --- 宏观与经济 ---
	{ name: "Federal Reserve Press", url: "https://www.federalreserve.gov/feeds/press_all.xml", category: "macro", topics: ["macro", "rates"], lang: "en" },
	{ name: "Calculated Risk", url: "https://www.calculatedriskblog.com/feeds/posts/default?alt=rss", category: "macro", topics: ["macro", "housing", "economy"], lang: "en" },
	{ name: "Marginal Revolution", url: "https://marginalrevolution.com/feed", category: "macro", topics: ["economics", "essay"], lang: "en" },
	{ name: "Noahpinion (Noah Smith)", url: "https://www.noahpinion.blog/feed", category: "macro", topics: ["economics", "policy"], lang: "en" },

	// --- 安全 ---
	{ name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", category: "blog", topics: ["security"], lang: "en" },
	{ name: "Schneier on Security", url: "https://www.schneier.com/feed/atom/", category: "blog", topics: ["security", "policy"], lang: "en" },

	// --- 科学 ---
	{ name: "Quanta Magazine", url: "https://www.quantamagazine.org/feed/", category: "news", topics: ["science", "math", "physics"], lang: "en" },

	// --- 中文 ---
	// 36氪/虎嗅/机器之心 已删:RSS 均已死(404/超时/返回非 feed,2026-08-16 D7 巡检);
	// 量子位、InfoQ 中文为实抓验证过的替代
	{ name: "少数派", url: "https://sspai.com/feed", category: "blog", topics: ["tools", "productivity", "consumer"], lang: "zh" },
	{ name: "爱范儿", url: "https://www.ifanr.com/feed", category: "news", topics: ["consumer", "china-tech"], lang: "zh" },
	{ name: "极客公园", url: "https://www.geekpark.net/rss", category: "news", topics: ["china-tech", "product"], lang: "zh" },
	{ name: "量子位", url: "https://www.qbitai.com/feed", category: "news", topics: ["ai", "china-tech"], lang: "zh" },
	{ name: "InfoQ 中文", url: "https://www.infoq.cn/feed", category: "news", topics: ["dev", "engineering", "china-tech"], lang: "zh" },
	{ name: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml", category: "blog", topics: ["dev", "weekly"], lang: "zh" },

	// --- 播客(feed 带全文/摘要,无需转录) ---
	{ name: "Latent Space", url: "https://www.latent.space/feed", category: "podcast", topics: ["ai", "engineering"], lang: "en" },
	{ name: "Dwarkesh Podcast", url: "https://www.dwarkesh.com/feed", category: "podcast", topics: ["ai", "interview"], lang: "en" },
	{ name: "Lex Fridman Podcast", url: "https://lexfridman.com/feed/podcast/", category: "podcast", topics: ["ai", "interview", "science"], lang: "en" },

	// --- 论文 ---
	{ name: "arXiv cs.AI(每日)", url: "https://rss.arxiv.org/rss/cs.AI", category: "paper", topics: ["ai", "research"], lang: "en" },
	{ name: "arXiv cs.CL(每日)", url: "https://rss.arxiv.org/rss/cs.CL", category: "paper", topics: ["nlp", "llm", "research"], lang: "en" },
	{ name: "arXiv cs.LG(每日)", url: "https://rss.arxiv.org/rss/cs.LG", category: "paper", topics: ["ml", "research"], lang: "en" },
];

/** 目录的提示词形态:一行一个源,模型按主题/语言挑,URL 原样抄。 */
export function catalogPromptLines(): string {
	return CATALOG.map(
		(e) => `- ${e.name} | ${e.url} | 分类=${e.category} | 主题=${e.topics.join(",")} | ${e.lang}`,
	).join("\n");
}
