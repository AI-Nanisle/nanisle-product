// W6 · quote 锚定校验(docs/02 T4):模型每条要点必须附逐字引文,这里用
// 纯字符串操作验证它真的来自原文——「带引用生成」的引用本身也会幻觉,
// 校验必须在模型之外做,而且一分钱 token 不花。
//
// 匹配口径:去掉全部空白、标点、符号后小写比对子串。宽松处理的是模型
// 抄写时最常见的无害改动(标点全半角、空格、引号样式);内容性的改写
// (换词、增删字)仍会配不上——这正是要拦的东西。

/** 锚定归一:比对前去空白/标点/符号 + 小写。 */
export function normalizeForAnchor(s: string): string {
	return s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** quote 归一后至少要剩这么多字符,太短的引文撞上原文纯属巧合,不算锚定。 */
const MIN_NEEDLE_CHARS = 4;

/**
 * 对每条要点做锚定标记(anchored: true/false),不删除任何要点——
 * 配不上的要点由前端灰显标注「未能在原文中定位」,判断权留给读者。
 */
export function anchorKeyPoints<T extends { keyPoints: { quote: string; anchored?: boolean }[] }>(
	result: T,
	fullText: string,
): T {
	const hay = normalizeForAnchor(fullText);
	return {
		...result,
		keyPoints: result.keyPoints.map((kp) => {
			const needle = normalizeForAnchor(kp.quote);
			return { ...kp, anchored: needle.length >= MIN_NEEDLE_CHARS && hay.includes(needle) };
		}),
	};
}
