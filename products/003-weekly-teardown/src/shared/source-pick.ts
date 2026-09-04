// 节 2 的文件挑选启发式(阶段 7,docs/01 决策 7 第 2 步)。**纯函数,零网络。**
//
// 这个文件里没有任何 import,也没有任何模型调用的可能——和 scan-rules.ts 同一条
// 家法,同一个理由:节 2 的每条 takeaway 都挂着一个永久回链,而**读哪几个文件
// 这件事必须是可复述的**。让模型挑文件的话,「为什么给我看这个文件」就只有一个
// 答案是「模型觉得该看」,而这个产品的全部立场是每一步都能被读者拿去核对。
//
// 挑选的口径写在下面每条规则旁边。规则会调,但有一条不许破:**打分只看路径和
// 大小,不看文件内容**——看内容就得先把整棵树的正文拉下来,而那正是这一步要
// 避免的(一个仓几千个文件,拉一遍要几分钟、几百次请求)。

/** 一个候选文件(github.ts 的 TreeEntry 的结构子集,故意不 import,保持零依赖)。 */
export interface PickInput {
	path: string;
	/** 字节数。0 = GitHub 没给(极少),按未知处理不排除。 */
	size: number;
}

export interface PickedFile {
	path: string;
	size: number;
	/** 打了多少分。落进报告里,读者能看见我们凭什么挑了它。 */
	score: number;
	/** 给人读的一句话理由。和 scan-rules 的 reason 同款:造理由的地方就是打分的地方。 */
	why: string;
	/**
	 * 命中了档案 `caresAbout` 的哪几条(下标)。空数组 = 没命中任何一条,
	 * 它是靠「入口文件」这类通用规则进来的。
	 */
	caresHits: number[];
}

/** 单个文件的字节上限(docs/01 决策 7:排除 >100KB 的)。 */
export const MAX_FILE_BYTES = 100 * 1024;

/** 最多挑几个文件(含 README)。 */
export const MAX_PICKED_FILES = 5;

/**
 * 路径里出现这些**目录段**就整条排除。docs/01 决策 7 点名了前三个,其余是同类。
 *
 * 为什么按「路径段」匹配而不是子串:`src/testing-library-helpers.ts` 里有 `test`,
 * 但它不是测试目录;而 `packages/core/test/x.ts` 是。子串匹配会把前者误杀,
 * 而节 2 只挑 5 个文件,误杀一个的代价是整份报告少一块。
 *
 * 排除测试和 vendor 的理由不是「它们不重要」,是**它们不是这个项目的判断**:
 * 测试是别人写的断言,vendor 是别人的代码。节 2 问的是「它源码里值得抄什么」,
 * 抄 vendor 目录里的第三方库等于什么都没学到。
 */
const EXCLUDED_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"spec",
	"specs",
	"e2e",
	"fixtures",
	"__fixtures__",
	"__mocks__",
	"vendor",
	"vendored",
	"third_party",
	"thirdparty",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".git",
	".github",
	"venv",
	".venv",
	"site-packages",
	"migrations",
	"locales",
	"i18n",
]);

/**
 * 这些后缀直接排除:二进制、锁文件、压缩产物。
 *
 * 锁文件(`package-lock.json` 那种)单独说一句:它是纯文本、也不大,但它是
 * **机器生成的**,里面一行都不是这个项目的人写的。让它占掉 5 个名额之一,
 * 换回来的必然是「这个项目锁了 1400 个依赖」这类真但无用的观察(docs/01 风险 3)。
 */
const EXCLUDED_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|mp4|mp3|wav|woff2?|ttf|otf|eot|zip|gz|tar|bz2|7z|rar|pdf|so|dll|dylib|exe|bin|wasm|class|jar|pyc|lock|snap|map|min\.js|min\.css)$/i;

/** 锁文件按名字排(它们的后缀是正常的 .json / .yaml)。 */
const LOCK_FILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|cargo\.lock|gemfile\.lock|composer\.lock|go\.sum)$/i;

/** 认得出是「源码或说明」的后缀。认不出的扣分而不是排除——新语言层出不穷。 */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|ex|exs|erl|clj|lua|sh|sql|vue|svelte|md|rst|toml|yaml|yml)$/i;

/** 入口文件的裸名(不含后缀)。 */
const ENTRY_STEMS = new Set(["index", "main", "app", "cli", "server", "core", "mod", "lib", "__init__", "run", "worker"]);

/** 太小的文件:一个 re-export 或者一行常量,读了什么也学不到。 */
const TINY_BYTES = 200;

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

function baseName(path: string): string {
	return segments(path).at(-1) ?? path;
}

function stem(name: string): string {
	const i = name.indexOf(".");
	return (i > 0 ? name.slice(0, i) : name).toLowerCase();
}

/**
 * 硬排除。返回非 null = 这个文件根本不进打分,字符串是理由(只进日志/调试)。
 */
export function excludeFile(f: PickInput): string | null {
	const segs = segments(f.path);
	const name = baseName(f.path);
	for (const seg of segs.slice(0, -1)) {
		if (EXCLUDED_SEGMENTS.has(seg.toLowerCase())) return `在 ${seg}/ 目录下`;
	}
	// 文件名本身像测试(`foo.test.ts` / `test_foo.py` / `foo_spec.rb`)。
	// **比对整个文件名,不是 stem**:stem 取的是第一个点之前那一段,
	// 而 `a.test.ts` 的第一个点之前是 `a` —— 用 stem 的话最常见的那种
	// 测试文件名恰好一个都拦不住。`testing-helpers.ts` 仍然不误杀:
	// 「test」后面要跟一个分隔符或结尾才算。
	if (/(^|[._-])(test|tests|spec)([._-]|$)/i.test(name)) return "文件名看起来是测试";
	if (LOCK_FILES.test(name)) return "锁文件(机器生成的)";
	if (EXCLUDED_EXT.test(name)) return "二进制或构建产物";
	if (f.size > MAX_FILE_BYTES) return `超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB`;
	return null;
}

/**
 * 把档案的 `caresAbout` 拆成能和**路径**比对的词。
 *
 * **诚实地说清楚这一步的局限**:路径几乎总是英文,而档案是用户用中文写的
 * (「我在意字幕优先」),所以中文条目在这里命中率接近零 —— 这不是 bug,
 * 是这个启发式的边界。它命中的是那些用户顺手写进档案的英文技术词
 * (`whisper`、`RAG`、`streaming`),而那恰恰是最有指向性的一批。
 *
 * 命中不了也不会让节 2 失效:那时候文件靠「README + 入口文件 + 层级浅」这几条
 * 通用规则挑,产出的 takeaway 照样要过 `caresAboutIndex` 那道硬门 —— 挑文件
 * 时没对上,不等于写结论时可以不对上。
 */
export function caresTokens(caresAbout: readonly string[]): string[][] {
	return caresAbout.map((item) =>
		(item.toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)),
	);
}

/** 命中了也说明不了什么的词。命中它们等于没命中。 */
const STOP_WORDS = new Set([
	"the","and","for","with","that","this","from","into","how","use","using","its","not","但是","支持",
	"code","file","files","data","user","users","project","open","source","github","api","app","web","new","get","set","all","any",
]);

export interface PickOptions {
	/** 档案的 caresAbout,用来给路径加分。 */
	caresAbout: readonly string[];
	/** 已经单独拿到手的 README 路径:它必进,而且不能被再挑一次。 */
	readmePath?: string | null;
	/** 最多挑几个(含 README)。 */
	limit?: number;
}

/**
 * 打分 + 排序 + 取前 N。**规则的先后顺序就是下面这几段的顺序**,写成一串加减分
 * 而不是 if/else 链,是为了让「为什么它排在前面」能一句话说清(`why` 字段)。
 *
 * 一、硬排除(excludeFile):测试 / vendor / 构建产物 / 锁文件 / >100KB。
 * 二、加分,从重到轻:
 *      +60  仓根的入口文件(`index.*` / `main.*` / `app.*` …)
 *      +45  `src/` 下的入口文件 —— docs/01 点名的 `src/index.*`
 *      +40  路径命中档案 caresAbout 的一条(每条 +40,可叠加)
 *      +20  在 `src/` / `lib/` / `app/` / `internal/` 下
 *      +15  是入口文件的裸名但不在上面两个位置(比如 `packages/x/index.ts`)
 *      +10  认得出的源码/文档后缀
 *      +12/9/6/3  层级越浅越高(depth 1-4);更深不加分
 * 三、扣分:
 *      -25  认不出的后缀(可能是配置或数据)
 *      -30  小于 200 字节(一个 re-export 学不到东西)
 * 四、排序:分数降序;**同分按路径字典序升序**。同分不许靠 Array.sort 的
 *     稳定性去决定,那等于让顺序取决于 GitHub 返回树的顺序,而报告的可复现性
 *     (同一个 commit 复用旧报告)建立在「同样的输入挑出同样的文件」上。
 *
 * README 不参与打分:它由调用方通过 `GET /repos/{o}/{r}/readme` 单独拿(名字
 * 有十几种写法,猜不得),在这里只用 `readmePath` 把它从候选里剔掉,免得同一个
 * 文件占两个名额。
 */
export function pickFiles(entries: readonly PickInput[], opts: PickOptions): PickedFile[] {
	const limit = Math.max(0, opts.limit ?? MAX_PICKED_FILES);
	const tokens = caresTokens(opts.caresAbout);
	const readme = opts.readmePath?.toLowerCase();
	const scored: PickedFile[] = [];

	for (const f of entries) {
		if (readme && f.path.toLowerCase() === readme) continue;
		if (excludeFile(f)) continue;

		const segs = segments(f.path);
		const depth = segs.length;
		const name = baseName(f.path);
		const st = stem(name);
		const lowerPath = f.path.toLowerCase();
		const reasons: string[] = [];
		let score = 0;

		if (depth === 1 && ENTRY_STEMS.has(st)) {
			score += 60;
			reasons.push("仓根的入口文件");
		} else if (depth === 2 && ENTRY_STEMS.has(st) && /^(src|lib|app|internal|pkg|cmd)$/i.test(segs[0]!)) {
			score += 45;
			reasons.push(`${segs[0]}/ 下的入口文件`);
		} else if (ENTRY_STEMS.has(st)) {
			score += 15;
			reasons.push("入口文件的名字");
		}

		const caresHits: number[] = [];
		tokens.forEach((words, i) => {
			if (words.some((w) => lowerPath.includes(w))) caresHits.push(i);
		});
		if (caresHits.length > 0) {
			score += 40 * caresHits.length;
			reasons.push(`路径命中你在意的第 ${caresHits.map((i) => i + 1).join("、")} 条`);
		}

		if (depth > 1 && /^(src|lib|app|internal|pkg|cmd)$/i.test(segs[0]!)) {
			score += 20;
			reasons.push(`在 ${segs[0]}/ 下`);
		}

		if (SOURCE_EXT.test(name)) score += 10;
		else {
			score -= 25;
			reasons.push("后缀认不出来");
		}

		score += Math.max(0, 15 - depth * 3);

		if (f.size > 0 && f.size < TINY_BYTES) {
			score -= 30;
			reasons.push("文件很小");
		}

		scored.push({
			path: f.path,
			size: f.size,
			score,
			why: reasons.length > 0 ? reasons.join(",") : "按层级和后缀挑的",
			caresHits,
		});
	}

	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return scored.slice(0, limit);
}
