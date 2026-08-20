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

	// --- AI 实验室 / 研究博客(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Microsoft Research Blog", url: "https://www.microsoft.com/en-us/research/feed/", category: "blog", topics: ["ai", "research"], lang: "en" },
	{ name: "Google Research Blog", url: "https://research.google/blog/rss/", category: "blog", topics: ["ai", "research"], lang: "en" },
	{ name: "NVIDIA Developer Blog", url: "https://developer.nvidia.com/blog/feed", category: "blog", topics: ["ai", "gpu", "infra"], lang: "en" },
	{ name: "Apple Machine Learning Research", url: "https://machinelearning.apple.com/rss.xml", category: "blog", topics: ["ai", "research"], lang: "en" },
	{ name: "Amazon Science", url: "https://www.amazon.science/index.rss", category: "blog", topics: ["ai", "research"], lang: "en" },
	{ name: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/", category: "blog", topics: ["ai", "ml-engineering", "cloud"], lang: "en" },
	{ name: "Qwen Blog(通义千问)", url: "https://qwenlm.github.io/blog/index.xml", category: "blog", topics: ["ai", "llm", "open-source"], lang: "en" },
	{ name: "EleutherAI Blog", url: "https://blog.eleuther.ai/index.xml", category: "blog", topics: ["ai", "open-source", "interpretability"], lang: "en" },
	{ name: "MIT News · AI", url: "https://news.mit.edu/rss/topic/artificial-intelligence2", category: "news", topics: ["ai", "research"], lang: "en" },
	{ name: "Databricks Blog", url: "https://www.databricks.com/feed", category: "blog", topics: ["ai", "data", "infra"], lang: "en" },
	{ name: "Epoch AI (Gradient Updates)", url: "https://epochai.substack.com/feed", category: "blog", topics: ["ai", "compute", "trends"], lang: "en" },

	// --- LLM / Agent 工程(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Eugene Yan", url: "https://eugeneyan.com/rss/", category: "blog", topics: ["ai", "ml-engineering", "llm"], lang: "en" },
	{ name: "Lil'Log (Lilian Weng)", url: "https://lilianweng.github.io/index.xml", category: "blog", topics: ["ai", "agent", "research"], lang: "en" },
	{ name: "Hamel Husain", url: "https://hamel.dev/index.xml", category: "blog", topics: ["ai", "llm", "evals"], lang: "en" },
	{ name: "Answer.AI", url: "https://www.answer.ai/index.xml", category: "blog", topics: ["ai", "open-source"], lang: "en" },
	{ name: "LangChain Blog", url: "https://blog.langchain.com/rss.xml", category: "blog", topics: ["agent", "llm", "dev"], lang: "en" },
	{ name: "LlamaIndex Blog", url: "https://medium.com/feed/llamaindex-blog", category: "blog", topics: ["agent", "rag", "llm"], lang: "en" },
	{ name: "PyTorch Blog", url: "https://pytorch.org/blog/feed.xml", category: "blog", topics: ["ml", "dev"], lang: "en" },
	{ name: "The Gradient", url: "https://thegradient.pub/rss/", category: "blog", topics: ["ai", "essay"], lang: "en" },
	{ name: "Vicki Boykis", url: "https://vickiboykis.com/index.xml", category: "blog", topics: ["ml-engineering", "essay"], lang: "en" },
	{ name: "Philipp Schmid", url: "https://www.philschmid.de/rss", category: "blog", topics: ["llm", "ml-engineering"], lang: "en" },
	{ name: "Drew Breunig", url: "https://www.dbreunig.com/feed.xml", category: "blog", topics: ["ai", "agent", "context"], lang: "en" },
	{ name: "Jason Liu (jxnl)", url: "https://jxnl.co/feed_rss_created.xml", category: "blog", topics: ["llm", "rag"], lang: "en" },
	{ name: "The Sequence", url: "https://thesequence.substack.com/feed", category: "blog", topics: ["ai", "research", "newsletter"], lang: "en" },
	{ name: "Don't Worry About the Vase (Zvi)", url: "https://thezvi.substack.com/feed", category: "blog", topics: ["ai", "safety", "weekly"], lang: "en" },
	{ name: "AI News (smol.ai)", url: "https://news.smol.ai/rss.xml", category: "news", topics: ["ai", "llm", "daily"], lang: "en" },
	{ name: "Understanding AI (Timothy B. Lee)", url: "https://www.understandingai.org/feed", category: "blog", topics: ["ai", "policy"], lang: "en" },
	{ name: "SemiAnalysis", url: "https://semianalysis.com/feed/", category: "blog", topics: ["gpu", "compute", "business"], lang: "en" },
	{ name: "Chips and Cheese", url: "https://chipsandcheese.com/feed", category: "blog", topics: ["hardware", "gpu"], lang: "en" },
	{ name: "LessWrong", url: "https://www.lesswrong.com/feed.xml", category: "blog", topics: ["ai", "safety", "essay"], lang: "en" },
	{ name: "Alignment Forum", url: "https://www.alignmentforum.org/feed.xml", category: "paper", topics: ["ai", "safety", "research"], lang: "en" },

	// --- 开发 / 基础设施(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Vercel Blog", url: "https://vercel.com/atom", category: "blog", topics: ["dev", "frontend", "infra"], lang: "en" },
	{ name: "Fly.io Blog", url: "https://fly.io/blog/feed.xml", category: "blog", topics: ["infra", "dev"], lang: "en" },
	{ name: "Tailscale Blog", url: "https://tailscale.com/blog/index.xml", category: "blog", topics: ["infra", "network", "security"], lang: "en" },
	{ name: "Stripe Blog", url: "https://stripe.com/blog/feed.rss", category: "blog", topics: ["dev", "fintech", "engineering"], lang: "en" },
	{ name: "Meta Engineering", url: "https://engineering.fb.com/feed/", category: "blog", topics: ["infra", "engineering"], lang: "en" },
	{ name: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "blog", topics: ["dev", "rust"], lang: "en" },
	{ name: "Go Blog", url: "https://go.dev/blog/feed.atom", category: "blog", topics: ["dev", "go"], lang: "en" },
	{ name: "Slack Engineering", url: "https://slack.engineering/feed/", category: "blog", topics: ["infra", "engineering"], lang: "en" },
	{ name: "Dropbox Tech", url: "https://dropbox.tech/feed", category: "blog", topics: ["infra", "engineering"], lang: "en" },
	{ name: "Spotify Engineering", url: "https://engineering.atspotify.com/feed", category: "blog", topics: ["infra", "engineering", "ml-engineering"], lang: "en" },
	{ name: "Airbnb Engineering", url: "https://medium.com/feed/airbnb-engineering", category: "blog", topics: ["infra", "engineering"], lang: "en" },
	{ name: "Pinterest Engineering", url: "https://medium.com/feed/pinterest-engineering", category: "blog", topics: ["infra", "ml-engineering"], lang: "en" },
	{ name: "Supabase Blog", url: "https://supabase.com/rss.xml", category: "blog", topics: ["dev", "database", "open-source"], lang: "en" },
	{ name: "PlanetScale Blog", url: "https://planetscale.com/blog/rss.xml", category: "blog", topics: ["database", "infra"], lang: "en" },
	{ name: "Dan Luu", url: "https://danluu.com/atom.xml", category: "blog", topics: ["dev", "systems", "essay"], lang: "en" },
	{ name: "Xe Iaso", url: "https://xeiaso.net/blog.rss", category: "blog", topics: ["infra", "dev"], lang: "en" },
	{ name: "Register Spill (Thorsten Ball)", url: "https://registerspill.thorstenball.com/feed", category: "blog", topics: ["dev", "ai-coding", "essay"], lang: "en" },
	{ name: "Tidy First (Kent Beck)", url: "https://tidyfirst.substack.com/feed", category: "blog", topics: ["dev", "design"], lang: "en" },
	{ name: "Hillel Wayne", url: "https://buttondown.com/hillelwayne/rss", category: "blog", topics: ["dev", "formal-methods"], lang: "en" },
	{ name: "Marc Brooker", url: "https://brooker.co.za/blog/rss.xml", category: "blog", topics: ["distributed-systems", "aws"], lang: "en" },
	{ name: "Murat Demirbas", url: "https://muratbuffalo.blogspot.com/feeds/posts/default", category: "blog", topics: ["distributed-systems", "paper"], lang: "en" },
	{ name: "Mitchell Hashimoto", url: "https://mitchellh.com/feed.xml", category: "blog", topics: ["dev", "systems"], lang: "en" },
	{ name: "matklad", url: "https://matklad.github.io/feed.xml", category: "blog", topics: ["dev", "rust", "tools"], lang: "en" },
	{ name: "research!rsc (Russ Cox)", url: "https://research.swtch.com/feed.atom", category: "blog", topics: ["dev", "go", "cs"], lang: "en" },
	{ name: "antirez", url: "https://antirez.com/rss", category: "blog", topics: ["dev", "systems"], lang: "en" },
	{ name: "ByteByteGo", url: "https://blog.bytebytego.com/feed", category: "blog", topics: ["system-design", "dev"], lang: "en" },
	{ name: "The New Stack", url: "https://thenewstack.io/feed", category: "news", topics: ["infra", "cloud-native"], lang: "en" },
	{ name: "InfoQ (英文)", url: "https://feed.infoq.com/", category: "news", topics: ["dev", "engineering"], lang: "en" },
	{ name: "Lobsters", url: "https://lobste.rs/rss", category: "news", topics: ["dev", "tech", "aggregator"], lang: "en" },
	{ name: "Engineering Leadership", url: "https://newsletter.eng-leadership.com/feed", category: "blog", topics: ["engineering-org", "career"], lang: "en" },
	{ name: "Google Developers Blog", url: "https://developers.googleblog.com/feeds/posts/default", category: "blog", topics: ["dev", "ai"], lang: "en" },

	// --- 产品 / 创业 / VC(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Y Combinator Blog", url: "https://www.ycombinator.com/blog/rss", category: "blog", topics: ["startup", "vc"], lang: "en" },
	{ name: "SaaStr", url: "https://www.saastr.com/feed/", category: "blog", topics: ["saas", "sales", "startup"], lang: "en" },
	{ name: "Andrew Chen", url: "https://andrewchen.substack.com/feed", category: "blog", topics: ["growth", "vc"], lang: "en" },
	{ name: "Tomasz Tunguz", url: "https://tomtunguz.com/index.xml", category: "blog", topics: ["saas", "vc", "data"], lang: "en" },
	{ name: "Elad Gil", url: "https://eladgil.substack.com/feed", category: "blog", topics: ["startup", "ai", "vc"], lang: "en" },
	{ name: "Sam Altman", url: "https://blog.samaltman.com/posts.atom", category: "blog", topics: ["startup", "ai", "essay"], lang: "en" },
	{ name: "The Generalist", url: "https://www.generalist.com/feed", category: "blog", topics: ["business", "strategy"], lang: "en" },
	{ name: "Newcomer", url: "https://newcomer.co/feed", category: "news", topics: ["vc", "startup"], lang: "en" },
	{ name: "A Smart Bear (Jason Cohen)", url: "https://longform.asmartbear.com/index.xml", category: "blog", topics: ["startup", "product"], lang: "en" },
	{ name: "Steve Blank", url: "https://steveblank.com/feed/", category: "blog", topics: ["startup", "methodology"], lang: "en" },
	{ name: "Platformer (Casey Newton)", url: "https://www.platformer.news/rss/", category: "news", topics: ["tech", "policy", "platforms"], lang: "en" },
	{ name: "Exponential View (Azeem Azhar)", url: "https://www.exponentialview.co/feed", category: "blog", topics: ["tech", "trends", "macro"], lang: "en" },

	// --- 宏观 / 投资(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "FT Alphaville", url: "https://www.ft.com/alphaville?format=rss", category: "macro", topics: ["markets", "finance"], lang: "en" },
	{ name: "FRED Blog", url: "https://fredblog.stlouisfed.org/feed/", category: "macro", topics: ["macro", "data"], lang: "en" },
	{ name: "Liberty Street Economics", url: "https://libertystreeteconomics.newyorkfed.org/feed/", category: "macro", topics: ["macro", "fed"], lang: "en" },
	{ name: "Bank Underground", url: "https://bankunderground.co.uk/feed/", category: "macro", topics: ["macro", "central-bank"], lang: "en" },
	{ name: "Econbrowser", url: "https://econbrowser.com/feed", category: "macro", topics: ["macro", "economics"], lang: "en" },
	{ name: "Brad DeLong", url: "https://braddelong.substack.com/feed", category: "macro", topics: ["economics", "history"], lang: "en" },
	{ name: "Paul Krugman", url: "https://paulkrugman.substack.com/feed", category: "macro", topics: ["macro", "economics"], lang: "en" },
	{ name: "The Big Picture (Barry Ritholtz)", url: "https://ritholtz.com/feed/", category: "macro", topics: ["markets", "investing"], lang: "en" },
	{ name: "Apricitas Economics", url: "https://www.apricitas.io/feed", category: "macro", topics: ["macro", "data"], lang: "en" },
	{ name: "Kyla Scanlon", url: "https://kyla.substack.com/feed", category: "macro", topics: ["macro", "explainer"], lang: "en" },
	{ name: "Klement on Investing", url: "https://klementoninvesting.substack.com/feed", category: "macro", topics: ["investing", "research"], lang: "en" },
	{ name: "A Wealth of Common Sense", url: "https://awealthofcommonsense.com/feed/", category: "macro", topics: ["investing", "personal-finance"], lang: "en" },
	{ name: "The Economist · 金融经济", url: "https://www.economist.com/finance-and-economics/rss.xml", category: "macro", topics: ["macro", "finance"], lang: "en" },

	// --- 科学(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Ars Technica · Science", url: "https://feeds.arstechnica.com/arstechnica/science", category: "news", topics: ["science"], lang: "en" },
	{ name: "Nautilus", url: "https://nautil.us/feed/", category: "blog", topics: ["science", "essay"], lang: "en" },
	{ name: "Asimov Press", url: "https://www.asimov.press/feed", category: "blog", topics: ["biotech", "science"], lang: "en" },
	{ name: "Works in Progress", url: "https://www.worksinprogress.news/feed", category: "blog", topics: ["science", "progress"], lang: "en" },
	{ name: "Astral Codex Ten", url: "https://www.astralcodexten.com/feed", category: "blog", topics: ["science", "essay", "rationality"], lang: "en" },

	// --- 中文(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Solidot 奇客", url: "https://www.solidot.org/index.rss", category: "news", topics: ["tech", "china-tech"], lang: "zh" },
	{ name: "美团技术团队", url: "https://tech.meituan.com/feed/", category: "blog", topics: ["engineering", "china-tech"], lang: "zh" },
	{ name: "云风的 BLOG", url: "https://blog.codingnow.com/atom.xml", category: "blog", topics: ["dev", "systems"], lang: "zh" },
	{ name: "潮流周刊 (Tw93)", url: "https://weekly.tw93.fun/rss.xml", category: "blog", topics: ["frontend", "weekly", "tools"], lang: "zh" },
	{ name: "HelloGitHub", url: "https://hellogithub.com/rss", category: "blog", topics: ["open-source", "monthly"], lang: "zh" },
	{ name: "宝玉", url: "https://baoyu.io/feed.xml", category: "blog", topics: ["ai", "llm", "translation"], lang: "zh" },
	{ name: "DIYgod", url: "https://diygod.cc/feed", category: "blog", topics: ["indie-dev", "rss"], lang: "zh" },
	{ name: "一天世界 (李如一)", url: "https://blog.yitianshijie.net/feed/", category: "blog", topics: ["tech-culture", "essay"], lang: "zh" },
	{ name: "Randy Lu", url: "https://lutaonan.com/rss.xml", category: "blog", topics: ["indie-dev", "frontend"], lang: "zh" },
	{ name: "小众软件", url: "https://www.appinn.com/feed/", category: "news", topics: ["tools", "apps"], lang: "zh" },
	{ name: "catcoding (陈天)", url: "https://catcoding.me/atom.xml", category: "blog", topics: ["indie-dev", "ai-coding"], lang: "zh" },
	{ name: "Hacker News 中文 (Buzzing)", url: "https://hn.buzzing.cc/feed.xml", category: "news", topics: ["tech", "aggregator"], lang: "zh" },
	{ name: "Readhub", url: "https://readhub.cn/rss", category: "news", topics: ["tech", "china-tech", "aggregator"], lang: "zh" },
	{ name: "BestBlogs.dev 精选", url: "https://www.bestblogs.dev/zh/feeds/rss", category: "blog", topics: ["ai", "dev", "curated"], lang: "zh" },
	{ name: "归藏 AIGC Weekly", url: "https://quail.ink/op7418/feed/atom", category: "blog", topics: ["ai", "product", "weekly"], lang: "zh" },
	{ name: "月光博客", url: "https://www.williamlong.info/feed", category: "blog", topics: ["internet", "china-tech"], lang: "zh" },

	// --- 播客(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "Acquired", url: "https://feeds.transistor.fm/acquired", category: "podcast", topics: ["business", "history"], lang: "en" },
	{ name: "The Changelog", url: "https://changelog.com/podcast/feed", category: "podcast", topics: ["dev", "open-source"], lang: "en" },
	{ name: "Practical AI", url: "https://changelog.com/practicalai/feed", category: "podcast", topics: ["ai", "ml-engineering"], lang: "en" },
	{ name: "Hard Fork (NYT)", url: "https://feeds.simplecast.com/l2i9YnTd", category: "podcast", topics: ["tech", "news"], lang: "en" },
	{ name: "a16z Podcast", url: "https://feeds.simplecast.com/JGE3yC0V", category: "podcast", topics: ["tech", "vc"], lang: "en" },
	{ name: "ChinaTalk", url: "https://www.chinatalk.media/feed", category: "podcast", topics: ["china-tech", "policy"], lang: "en" },
	{ name: "Sharp Tech (Ben Thompson)", url: "https://sharptech.fm/feed/podcast", category: "podcast", topics: ["tech", "strategy"], lang: "en" },
	{ name: "No Priors", url: "https://feeds.megaphone.fm/nopriors", category: "podcast", topics: ["ai", "vc", "interview"], lang: "en" },
	{ name: "The Cognitive Revolution", url: "https://feeds.megaphone.fm/RINTP3108857801", category: "podcast", topics: ["ai", "interview"], lang: "en" },
	{ name: "Odd Lots (Bloomberg)", url: "https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8a94442e-5a74-4fa2-8b8d-ae27003a8d6b/982f5071-765c-403d-969d-ae27003a8d83/podcast.rss", category: "podcast", topics: ["macro", "markets"], lang: "en" },
	{ name: "Money Stuff (Matt Levine)", url: "https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/ee4336cb-155f-4488-90e0-b1400134e40e/77e6a3a7-290d-4a82-8164-b14001353ef2/podcast.rss", category: "podcast", topics: ["finance", "commentary"], lang: "en" },
	{ name: "The AI Daily Brief", url: "https://anchor.fm/s/f7cac464/podcast/rss", category: "podcast", topics: ["ai", "daily"], lang: "en" },
	{ name: "硅谷101", url: "https://feeds.fireside.fm/sv101/rss", category: "podcast", topics: ["tech", "china-tech"], lang: "zh" },
	{ name: "What's Next 科技早知道", url: "https://feeds.fireside.fm/guiguzaozhidao/rss", category: "podcast", topics: ["tech", "business"], lang: "zh" },
	{ name: "晚点聊 LateTalk", url: "https://feeds.fireside.fm/latetalk/rss", category: "podcast", topics: ["business", "china-tech", "interview"], lang: "zh" },

	// --- 论文 / 学术(2026-08-19 扩容,全部经 probeFeed 实抓验证) ---
	{ name: "HF Daily Papers", url: "https://papers.takara.ai/api/feed", category: "paper", topics: ["ai", "llm", "research"], lang: "en" },
	{ name: "arXiv cs.CV(每日)", url: "https://rss.arxiv.org/rss/cs.CV", category: "paper", topics: ["cv", "research"], lang: "en" },
	{ name: "arXiv stat.ML(每日)", url: "https://rss.arxiv.org/rss/stat.ML", category: "paper", topics: ["ml", "research"], lang: "en" },
	{ name: "ChinAI (Jeffrey Ding)", url: "https://chinai.substack.com/feed", category: "paper", topics: ["china-ai", "translation"], lang: "en" },
	{ name: "Last Week in AI", url: "https://lastweekin.ai/feed", category: "paper", topics: ["ai", "weekly"], lang: "en" },
	{ name: "ML Safety Newsletter", url: "https://newsletter.mlsafety.org/feed", category: "paper", topics: ["ai", "safety"], lang: "en" },
];

/** 目录的提示词形态:一行一个源,模型按主题/语言挑,URL 原样抄。 */
export function catalogPromptLines(): string {
	return CATALOG.map(
		(e) => `- ${e.name} | ${e.url} | 分类=${e.category} | 主题=${e.topics.join(",")} | ${e.lang}`,
	).join("\n");
}
