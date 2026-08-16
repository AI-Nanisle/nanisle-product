import type { Brief } from "../shared/types";

/**
 * Served by GET /api/brief when KV holds no real brief yet, so a fresh clone
 * in mock mode demos the full UI with zero configuration. Links point to
 * real, stable pages (indexes and one classic paper) — never fabricated
 * articles. `sample: true` makes the UI label it and skip the stale banner.
 */
export const SAMPLE_BRIEF: Brief = {
	date: "2026-01-01",
	generatedAt: "2026-01-01T12:00:00Z",
	sample: true,
	sourceCount: 17,
	sections: [
		{
			key: "headlines",
			title: "今日大事",
			items: [
				{
					id: "sample-cpi",
					title: "示例 · 最新 CPI 数据发布",
					whyClick:
						"这是示例条目:真实运行时,这里会在 CPI/就业等数据发布日出现一条,标注实际值与预期的差距,值得点进去看分项。",
					url: "https://www.bls.gov/news.release/cpi.nr0.htm",
					source: "BLS News Releases",
					extras: [{ label: "数据出处 · BLS CPI 主页", url: "https://www.bls.gov/cpi/" }],
				},
				{
					id: "sample-anthropic",
					title: "示例 · 某 AI 实验室发布新模型",
					whyClick:
						"真实运行时,多家源报道同一次发布会被合并成一条,这里只告诉你「新在哪、和你有什么关系」,细节留给原文。",
					url: "https://www.anthropic.com/news",
					source: "Anthropic News",
					mergedFrom: [
						{ label: "OpenAI News 的相关报道", url: "https://openai.com/news/" },
					],
				},
			],
		},
		{
			key: "ammo",
			title: "项目弹药",
			items: [
				{
					id: "sample-ammo",
					title: "示例 · 一篇和你关注点直接相关的实践文章",
					whyClick:
						"进入这个分区的条目必须写明它和你 focus.yaml 里哪一条的关系——写不出来就不入选。这是示例,真实条目会具体到「这篇的 X 做法可以直接用在你的 Y 上」。",
					url: "https://simonwillison.net/",
					source: "Simon Willison",
					relatesTo: "本周产品:信息聚合产品的留存设计",
				},
			],
		},
		{
			key: "learn",
			title: "教我新东西",
			items: [
				{
					id: "sample-learn",
					title: "Attention Is All You Need(重读经典)",
					whyClick:
						"示例条目用一篇真实论文占位:Transformer 的原始论文,8 页,今天所有 LLM 的源头。真实运行时这里是当天 arXiv 新论文或深度播客。",
					url: "https://arxiv.org/abs/1706.03762",
					source: "arXiv cs.AI",
					discussionUrl: "https://hn.algolia.com/?query=Attention%20Is%20All%20You%20Need",
					caveat:
						"论文自己也承认:自注意力对超长序列的开销是平方级的——这个局限催生了后来十年的效率改进工作。",
				},
			],
		},
	],
	filteredOut: {
		scanned: 142,
		dropped: 138,
		summary: "示例:今天扫了 142 条,筛掉 138 条,主要是重复报道、发布会周边稿和与关注点无关的增量更新。",
		items: [
			{
				id: "sample-dropped-1",
				title: "示例 · 某框架 v3.2.1 补丁说明",
				url: "https://github.com/",
				source: "示例源",
				reason: "增量更新,无行为改变",
			},
			{
				id: "sample-dropped-2",
				title: "示例 · 一场线上活动的预告",
				url: "https://example.com/",
				source: "示例源",
				reason: "规则过滤:活动预告",
			},
		],
	},
};
