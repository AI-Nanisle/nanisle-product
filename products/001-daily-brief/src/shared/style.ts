// 去 AI 味的确定性兜底。提示词里的 STYLE_RULES 是第一道防线,这里只做机器
// 能确定判断的部分:引号按 GB/T 15834-2011 归一(横排弯引号,先双后单;「」
// 是台港/日式与直排用法,简体读者读着就是翻译腔),CJK 邻接的半角标点全角化
// (参照 huacnlee/autocorrect 的 fullwidth 规则,但不引它 3MB 的 wasm),
// 破折号降级为逗号(多个去 AI 味规则集一致认定:真人中文写作里破折号基线
// 频率接近 0,是最可靠的 AI 腔信号)。
//
// 词表类问题(凸显/赋能/值得关注)不在这里硬删:机械删词会把句子改坏,
// 那是提示词的活。这里只数出来(countAiTells)进日志,给换模对照当指标。

const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff\\u3000-\\u303f";

const RE_HALF_DQUOTE = new RegExp(`"([^"\n]*[${CJK}][^"\n]*)"`, "g");
const RE_HALF_SQUOTE = new RegExp(`'([^'\n]*[${CJK}][^'\n]*)'`, "g");
const RE_DASH = new RegExp(`([${CJK}])\\s*[—–]{1,2}\\s*`, "g");
const RE_COMMA = new RegExp(`([${CJK}]),\\s*`, "g");
const RE_PERIOD = new RegExp(`([${CJK}])\\.(\\s+|$)`, "g");
const RE_COLON = new RegExp(`([${CJK}]):\\s*`, "g");
const RE_SEMI = new RegExp(`([${CJK}]);\\s*`, "g");
const RE_QMARK = new RegExp(`([${CJK}])\\?(\\s+|$)`, "g");
const RE_BANG = new RegExp(`([${CJK}])[!！]+`, "g");

/** 模型写的读者可见文本(whyClick/substance/take/tldr…)统一过一遍。 */
export function normalizeCnStyle(text: string): string {
	return (
		text
			// 直角引号 → 大陆弯引号
			.replace(/「/g, "“")
			.replace(/」/g, "”")
			.replace(/『/g, "‘")
			.replace(/』/g, "’")
			// 成对半角引号包住含中文的内容 → 弯双引号
			.replace(RE_HALF_DQUOTE, "“$1”")
			.replace(RE_HALF_SQUOTE, "“$1”")
			// 破折号(含 en dash)跟在中文后 → 逗号;纯英文/数字语境不动
			.replace(RE_DASH, "$1，")
			// CJK 邻接的半角标点全角化
			.replace(RE_COMMA, "$1，")
			.replace(RE_PERIOD, "$1。")
			.replace(RE_COLON, "$1：")
			.replace(RE_SEMI, "$1；")
			.replace(RE_QMARK, "$1？")
			// 中文后的感叹号降级为句号:简报语气里没有需要喊的话
			.replace(RE_BANG, "$1。")
			.replace(/，，+/g, "，")
			.replace(/。。+/g, "。")
	);
}

/**
 * AI 腔计数,规整**之前**调用。它不改文本,只给换模对照一个可比的数:
 * 同一天的候选,deepseek 和 claude 谁写出来的 AI 腔多,日志里直接见分晓。
 */
const AI_TELLS: RegExp[] = [
	/——|—/,
	/值得注意的是/,
	/值得关注/,
	/综上所述/,
	/不难发现/,
	/拭目以待/,
	/未来可期/,
	/不容小觑/,
	/凸显/,
	/赋能/,
	/或将/,
	/重磅/,
	/里程碑/,
	/革命性/,
	/深度剖析/,
	/「|」/,
	new RegExp(`"[^"\n]*[${CJK}][^"\n]*"`),
	new RegExp(`'[^'\n]*[${CJK}][^'\n]*'`),
];

export function countAiTells(text: string): number {
	let n = 0;
	for (const re of AI_TELLS) {
		const hits = text.match(new RegExp(re.source, "g"));
		n += hits?.length ?? 0;
	}
	return n;
}
