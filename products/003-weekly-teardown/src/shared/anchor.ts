// 多源锚定 + 判断层硬门(docs/02 决策 T4,docs/01 决策 6)。
//
// 这一层是 003 的地基:报告里每条结论都挂逐字引文和永久回链,而「带引用生成」
// 的引用本身也会幻觉——校验必须在模型之外做,纯字符串操作,一分钱 token 不花。
//
// 与 002 的关系:`normalizeForAnchor` 和 `MIN_NEEDLE_CHARS` 是从
// products/002-watch-router/src/shared/anchor.ts **一字不改**复制过来的
// (物理复制,不跨产品 import——这是本仓每个产品自包含的家法)。这两条已经在
// 002 线上验证过匹配口径是对的,别顺手"优化"。
//
// 相对 002 新增的两件事:
//   1. `anchorAcross` —— 002 只有一份转录稿当底本,003 有十几份材料
//      (HN 讨论 / changelog / README / 5 份源码正文),必须按来源分开比对;
//   2. 判断层硬门 —— 002 只有事实层,003 多了 takeaway 这一层判断句。

/** 锚定归一:比对前去空白/标点/符号 + 小写。 */
export function normalizeForAnchor(s: string): string {
	return s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** quote 归一后至少要剩这么多字符,太短的引文撞上原文纯属巧合,不算锚定。 */
const MIN_NEEDLE_CHARS = 4;

/** 命中处前后各截这么多个**原文字符**当上下文。 */
const CONTEXT_CHARS = 150;

/** 一份比对底本的身份。形如 "hn:38291043" | "raw:src/index.ts" | "readme" | "changelog"。 */
export type SourceId = string;

export interface AnchorHit {
	anchored: boolean;
	/** 命中处前后各 150 字的**原文**片段。零额外 token —— indexOf 已经拿到下标了。 */
	context?: string;
	/**
	 * 命中处在**原文**里的 [startChar, endChar) 区间(UTF-16 下标)。阶段 7 加的。
	 *
	 * 为什么值得多回两个数:节 2 的永久回链要写成 `blob/<sha>/<path>#L12-L28`,
	 * 而行号只能从「这段引文落在原文的哪个字节区间」算出来。这两个下标在下面
	 * 算 context 的那一步**已经算完了**(mapped.start / mapped.end),不回给调用方
	 * 的话,调用方就得在 report.ts 里再写一遍归一化 + indexOf ——那是第二份
	 * 匹配口径,而两份口径迟早会分叉:锚定说命中、行号算出来是另一段,
	 * 于是链接点开根本没有那句话,可这条证据带着 `anchored: true` 的硬凭证。
	 *
	 * 和 context 同生共死:`normalizeWithMap` 返回 null(逐字归一 ≠ 整串归一)时
	 * 两者都没有,**但 anchored 仍然为 true** —— 判定永远以整串归一为准,
	 * 那是与 002 一致的那条线。调用方拿不到下标时把回链降级成不带 #L 的
	 * `blob/<sha>/<path>`,不许猜一个行号。
	 */
	startChar?: number;
	endChar?: number;
}

// ---------------------------------------------------------------------------
// 事实层:多源锚定
// ---------------------------------------------------------------------------

/**
 * norm 与原文之间的下标映射。
 *
 * 为什么需要它:`indexOf` 是在**归一化后**的字符串上做的,而 `context` 要给人看,
 * 必须是**原文**的片段。归一化会删字(空白/标点/符号)也会改字(小写),下标于是
 * 整体左移,归一化串上的位置 i 直接拿去 `text.slice(i)` 会截到完全不相干的地方。
 *
 * 做法:归一化时逐**码点**走一遍原文,对每个码点单独调一次同一个
 * `normalizeForAnchor`,把它产出的每个字符都记下"我来自原文的 [start, end)"。
 * 于是 norm[i] ↔ 原文 [start[i], end[i]) 是精确对应的,不是估算。
 */
interface NormMap {
	norm: string;
	/** norm[i] 由原文 [start[i], end[i]) 这一个码点产生。 */
	start: number[];
	end: number[];
}

/**
 * 逐码点归一并记录下标映射。返回 null 表示"逐字归一 ≠ 整串归一",此时放弃 context。
 *
 * 为什么要有这个 null 分支:`toLowerCase()` 在极少数情况下是**上下文相关**的
 * (最典型的是希腊语词尾 Σ:整串归一得 ς,逐字归一得 σ),逐字拼出来的串就会与
 * `normalizeForAnchor(text)` 有一个字符的差。这种时候宁可不给 context,也不能
 * 让**锚定判定本身**跟着映射一起漂——判定必须永远以 `normalizeForAnchor` 的
 * 整串结果为准,这是与 002 口径一致的那条线。
 */
function normalizeWithMap(text: string): NormMap | null {
	const start: number[] = [];
	const end: number[] = [];
	let norm = "";
	let at = 0;
	// for...of 按码点迭代,代理对(emoji 等)不会被拆成两半
	for (const ch of text) {
		const next = at + ch.length;
		const piece = normalizeForAnchor(ch);
		// 一个码点小写后可能产出多个字符(如 U+0130 İ → "i̇"),每个都指回同一段原文
		for (let k = 0; k < piece.length; k++) {
			start.push(at);
			end.push(next);
		}
		norm += piece;
		at = next;
	}
	return norm === normalizeForAnchor(text) ? { norm, start, end } : null;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 把 context 的左边界夹到 [0, len] 并退到码点边界上。
 * ±150 这个偏移量是按 UTF-16 code unit 数的,有可能正好落在一个代理对中间,
 * 那样 slice 出来会是半个 emoji(渲染成 �)。落在中间就往外退一格,把整个码点包进来。
 */
function clampStart(s: string, i: number): number {
	const j = Math.max(0, Math.min(i, s.length));
	return j > 0 && isLowSurrogate(s.charCodeAt(j)) ? j - 1 : j;
}

/** 同 clampStart,右边界往外扩一格。 */
function clampEnd(s: string, i: number): number {
	const j = Math.max(0, Math.min(i, s.length));
	return j < s.length && isLowSurrogate(s.charCodeAt(j)) ? j + 1 : j;
}

/**
 * 只在 `claimedSource` 那一份材料里比对。**跨源命中判为失败,不判为成功。**
 *
 * 为什么不把十几份材料拼成一个大字符串(那才是直觉方案):模型声称引自 A 项目
 * `src/index.ts` 的一句话,可能在 B 项目的 README 里恰好出现(开源项目之间抄来
 * 抄去很常见,`MIT License` 这种更是到处都是),于是一条张冠李戴的引文拿到了
 * `anchored: true`——而它后面挂着的永久回链会指向 A 的行号,点开根本没有那句话。
 * **这比不锚定更糟,因为它带着一个看起来很硬的凭证。**
 *
 * `claimedSource` 不在 sources 里 → 判 false。不抛错(模型编了个来源名不该让整份
 * 报告挂掉),也**不去别处找**(去别处找就正好是上面那个失败模式)。
 */
export function anchorAcross(quote: string, sources: Map<SourceId, string>, claimedSource: SourceId): AnchorHit {
	const text = sources.get(claimedSource);
	if (text === undefined) return { anchored: false };

	const needle = normalizeForAnchor(quote);
	if (needle.length < MIN_NEEDLE_CHARS) return { anchored: false };

	const mapped = normalizeWithMap(text);
	// 判定用整串归一的结果;映射只用来算 context。两者分开,映射失效不影响判定。
	const hay = mapped ? mapped.norm : normalizeForAnchor(text);
	const at = hay.indexOf(needle);
	if (at < 0) return { anchored: false };
	if (!mapped) return { anchored: true };

	// 命中处在原文里的精确区间。context 是它往两边各扩 150 字之后的样子,
	// 两者同源:回链的行号和读者看到的上下文说的一定是同一段。
	const hitStart = mapped.start[at]!;
	const hitEnd = mapped.end[at + needle.length - 1]!;
	const from = clampStart(text, hitStart - CONTEXT_CHARS);
	const to = clampEnd(text, hitEnd + CONTEXT_CHARS);
	return { anchored: true, context: text.slice(from, to), startChar: hitStart, endChar: hitEnd };
}

/**
 * 事实层批量锚定:**只标记,不删除**(时间线节点、star 数这类)。
 *
 * 沿用 002 的家法——配不上的由前端灰显标注「未能在原文中定位」,判断权留给读者。
 * 判断层的做法与这里**相反**,见下面 gateTakeaways 的注释。
 */
export function anchorAll<T extends { quote: string; source: SourceId }>(
	items: readonly T[],
	sources: Map<SourceId, string>,
): (T & AnchorHit)[] {
	return items.map((item) => ({ ...item, ...anchorAcross(item.quote, sources, item.source) }));
}

// ---------------------------------------------------------------------------
// 判断层:硬门
// ---------------------------------------------------------------------------

// 分级要**有意反转** 002 的家法:
//
//   | 层                        | 002 的做法 | 003 的做法       |
//   |---------------------------|-----------|------------------|
//   | 事实层(时间线节点、star 数) | 灰显不删   | 沿用灰显不删       |
//   | 判断层(takeaway、发展史结论)| —         | **直接丢弃**      |
//
// 为什么反转:判断层是这个产品最想被人读的一层,**在最想被读的地方放软门就是
// 自欺**——读者会把灰色当排版,照读不误。
//
// 这段话原样写在这里,是因为半年后一定有人想「顺手统一一下」把硬门改回软门。
// 要改之前请先回去读 docs/01 决策 6 和 docs/02 决策 T4。
//
// 还有一句必须把话说破:**判断句在原文里不存在,所以它不可能被锚定**。任何
// 「我们的判断也有引用」都是假的。唯一诚实的做法是换校验对象——002 校验的是
// 「引文 ∈ 原文」,003 判断层校验的是「判断 ∈ 已锚定证据的闭包」。页面上要同时
// 写清:可校验的是**推理的地基,不是推理本身**。

export type EvidenceId = string;

export interface Evidence {
	id: EvidenceId;
	quote: string;
	source: SourceId;
	/** anchorAcross 的产出。 */
	anchored: boolean;
	/** 形如 github.com/{o}/{r}/blob/{sha}/{path}#L12-L28 —— 是 commit sha 不是分支名。 */
	permalink: string;
	context?: string;
}

export interface Takeaway {
	text: string;
	/** 非空,且每个 id 对应的证据必须 anchored === true。 */
	basedOn: EvidenceId[];
	/** 对应档案 caresAbout 的第几条,标不出来即丢弃。 */
	caresAboutIndex: number;
}

/** 丢弃理由的机器可读分类。页面按它分组统计,reason 只是显示文案(照 scan-rules 的家法)。 */
export type DropKind = "no-basis" | "unknown-evidence" | "unanchored-evidence" | "cares-about-out-of-range";

export interface Dropped<T> {
	item: T;
	kind: DropKind;
	/** 给人读的中文理由,带上具体是哪个 id / 哪个下标,不是一句笼统的「不合格」。 */
	reason: string;
}

export interface GateResult<T> {
	kept: T[];
	dropped: Dropped<T>[];
	/** 已锚定证据 / 全部证据。没有证据时为 0(不是 1——「零分之零」不该算满分)。 */
	anchoredRatio: number;
}

/**
 * 已锚定证据占全部证据的比例。落库进 anchored_ratio,页面显示,不藏。
 */
export function anchoredRatio(evidence: readonly Evidence[]): number {
	if (evidence.length === 0) return 0;
	return evidence.filter((e) => e.anchored).length / evidence.length;
}

/**
 * 确定性拼装阶段的判断层硬门:模型返回之后、落库之前跑,**纯代码,零模型**。
 *
 * 逐条过滤 takeaway,四条丢弃条件:
 *   1. basedOn 为空                     —— 没有地基的判断就是凭空;
 *   2. basedOn 里有 id 在证据表里找不到    —— 模型编了个证据 id;
 *   3. basedOn 里有证据 anchored === false —— 地基本身没锚上;
 *   4. caresAboutIndex 越界              —— 见下。
 *
 * 第 4 条不是形式主义:它是滤掉「这个项目用了 zod 做校验」这类**真但无用**的观察
 * 的唯一手段(产品方案风险 3)。挂不上档案里任何一条「我在意什么」的观察,对用户
 * 下周写什么代码毫无影响。
 *
 * 这道硬门还有一个免费的副作用——它会自动滤掉「要重视开发者体验」这类正确的
 * 废话,因为这种句子挂不上任何一段具体的原文。
 *
 * @param caresAboutCount 档案里 caresAbout 的条数,合法下标是 0..count-1
 */
export function gateTakeaways(
	takeaways: readonly Takeaway[],
	evidence: readonly Evidence[],
	caresAboutCount: number,
): GateResult<Takeaway> {
	const byId = new Map(evidence.map((e) => [e.id, e]));
	const kept: Takeaway[] = [];
	const dropped: Dropped<Takeaway>[] = [];

	for (const item of takeaways) {
		const drop = (kind: DropKind, reason: string) => dropped.push({ item, kind, reason });

		if (item.basedOn.length === 0) {
			drop("no-basis", "没有列出任何证据(basedOn 为空)");
			continue;
		}

		const unknown = item.basedOn.find((id) => !byId.has(id));
		if (unknown !== undefined) {
			drop("unknown-evidence", `引用了不存在的证据 ${unknown}`);
			continue;
		}

		// 上一步已经保证每个 id 都在 byId 里,这里的非空断言是安全的
		const unanchored = item.basedOn.find((id) => !byId.get(id)!.anchored);
		if (unanchored !== undefined) {
			drop("unanchored-evidence", `依据的证据 ${unanchored} 未能在原文中定位`);
			continue;
		}

		// 非整数(模型偶尔回 1.5 或 "2")一并按越界处理:它同样标不出是哪一条
		if (!Number.isInteger(item.caresAboutIndex) || item.caresAboutIndex < 0 || item.caresAboutIndex >= caresAboutCount) {
			drop("cares-about-out-of-range", `caresAboutIndex ${item.caresAboutIndex} 不在 0..${caresAboutCount - 1} 之内`);
			continue;
		}

		kept.push(item);
	}

	return { kept, dropped, anchoredRatio: anchoredRatio(evidence) };
}

/**
 * 给页面用的一句话统计。丢掉多少条要能被看见,不藏——这是硬门的对价:
 * 我们替读者删了东西,就得把删了多少、为什么删说清楚。
 */
export function describeGate<T>(result: GateResult<T>): string {
	const total = result.kept.length + result.dropped.length;
	return `模型给了 ${total} 条,${result.kept.length} 条挂得上已锚定的原文,${result.dropped.length} 条挂不上已丢弃`;
}
