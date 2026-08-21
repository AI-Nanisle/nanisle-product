// S2/S5/S6 的单元测试。跑法:
//   node --experimental-strip-types --test src/shared/weekly.test.ts
//
// 这套机制会**自动改用户的定义**,所以护栏必须有测试兜着,不能只靠「逻辑上
// 不会走到那儿」:
//   · 没有指标依据的提案不许存在(S3)
//   · 用户手写的原话和亲手改过的理解句永远不被覆盖(S5)
//   · 定义只加不减 = 慢性死亡,到顶必须替换(S6)

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief } from "./types";
import type { Tracker } from "./pipeline-core";
import { fnv1a } from "./pipeline-core.ts";
import type { UserConfig } from "./store";
import type { Proposal } from "./weekly.ts";
import {
	MAX_PROPOSALS_PER_WEEK,
	applyProposal,
	capList,
	computeWeeklyMetrics,
	isCooled,
	isoWeek,
	makeProposals,
	makeSourceAddProposal,
	preserveImmutable,
	queryFeedDomains,
} from "./weekly.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function tracker(over: Partial<Tracker> = {}): Tracker {
	return { key: "t1", name: "定义一", quota: 2, ...over };
}

function config(over: Partial<UserConfig> = {}): UserConfig {
	return {
		trackers: [tracker()],
		sources: [{ key: "s1", name: "某源", url: "https://a.example/feed", category: "blog" }],
		updatedAt: NOW.toISOString(),
		...over,
	};
}

function brief(date: string, items: { id: string; source: string; publishedAt?: string }[], dropped = 0): Brief {
	return {
		date,
		generatedAt: `${date}T11:00:00.000Z`,
		sections: [
			{
				key: "t1",
				title: "定义一",
				items: items.map((i) => ({
					id: i.id,
					title: `条目 ${i.id}`,
					whyClick: "why",
					url: `https://a.example/${i.id}`,
					source: i.source,
					sourceKey: "s1",
					...(i.publishedAt ? { publishedAt: i.publishedAt } : {}),
				})),
			},
		],
		filteredOut: {
			scanned: 20,
			dropped,
			summary: "",
			items: Array.from({ length: dropped }, (_, k) => ({
				id: `d${k}`,
				title: `被筛掉 ${k}`,
				url: `https://a.example/d${k}`,
				source: "某源",
				reason: "未过入选线",
			})),
		},
		sourceCount: 1,
	};
}

test("isoWeek:跨年的周按 ISO 规则(周四定年份)", () => {
	assert.equal(isoWeek(new Date("2026-08-19T00:00:00Z")), "2026-W34");
	// 2027-01-01 是周五,属于 2026 年的最后一周
	assert.equal(isoWeek(new Date("2027-01-01T00:00:00Z")), "2026-W53");
});

test("computeWeeklyMetrics:每源贡献率与时效滞后都算得出真数", () => {
	const m = computeWeeklyMetrics({
		config: config(),
		briefs: [
			brief("2026-08-18", [{ id: "a", source: "某源", publishedAt: "2026-08-17T00:00:00Z" }], 3),
			brief("2026-08-17", [{ id: "b", source: "某源", publishedAt: "2026-08-17T00:00:00Z" }], 1),
		],
		events: [],
		now: NOW,
	});
	const s1 = m.sources.find((s) => s.key === "s1");
	assert.equal(s1?.selected, 2);
	assert.equal(s1?.dropped, 4);
	assert.equal(s1?.lastSelected, "2026-08-18");
	// 一条隔天(1.5)、一条当天(0.5)→ 中位数 1
	assert.equal(m.lagDays, 1);
	assert.equal(m.falseKill.dropped, 4);
});

test("computeWeeklyMetrics:误杀率 = want 数 / 被筛掉数", () => {
	const m = computeWeeklyMetrics({
		config: config(),
		briefs: [brief("2026-08-18", [{ id: "a", source: "某源" }], 4)],
		events: [{ date: "2026-08-18", itemId: "d0", kind: "want", at: "2026-08-18T13:00:00Z" }],
		now: NOW,
	});
	assert.equal(m.falseKill.wanted, 1);
	assert.equal(m.falseKill.rate, 0.25);
});

test("makeProposals:每条提案都必须带依据,且不超过每周上限", () => {
	const cfg = config({
		sources: Array.from({ length: 5 }, (_, i) => ({
			key: `s${i}`,
			name: `源 ${i}`,
			url: `https://s${i}.example/feed`,
			category: "blog" as const,
		})),
	});
	const metrics = computeWeeklyMetrics({
		config: cfg,
		briefs: Array.from({ length: 14 }, (_, i) => brief(`2026-08-${String(5 + i).padStart(2, "0")}`, [])),
		events: [],
		now: NOW,
	});
	let n = 0;
	const proposals = makeProposals({
		config: cfg,
		metrics,
		noHitStreak: new Map(),
		wantedTitles: [],
		now: NOW,
		idSeed: () => `x${n++}`,
	});
	assert.ok(proposals.length <= MAX_PROPOSALS_PER_WEEK);
	for (const p of proposals) {
		assert.ok(p.evidence.length > 0, "提案必须说得出依据");
		assert.equal(p.status, "pending");
	}
});

test("makeProposals · H6:连续抓取失败的源直接生成停用提案,不等 14 期零入选", () => {
	const cfg = config({
		sources: [
			{
				key: "s1",
				name: "某源",
				url: "https://a.example/feed",
				category: "blog",
				health: { consecutiveFailures: 4, lastError: "HTTP 404" },
			},
		],
	});
	// 只有 1 期简报——零入选那条越线(要 14 期)必然不响,响的只能是健康越线
	const metrics = computeWeeklyMetrics({
		config: cfg,
		briefs: [brief("2026-08-18", [])],
		events: [],
		now: NOW,
	});
	const proposals = makeProposals({
		config: cfg,
		metrics,
		noHitStreak: new Map(),
		wantedTitles: [],
		now: NOW,
		idSeed: () => "x",
	});
	assert.equal(proposals.length, 1);
	assert.deepEqual(proposals[0].patch, { type: "source-disable", sourceKey: "s1" });
	assert.ok(proposals[0].evidence.includes("连续 4 次抓取失败"));
	assert.ok(proposals[0].evidence.includes("HTTP 404"));
});

test("makeProposals:什么都正常时不生成提案(没有依据就不许开口)", () => {
	const cfg = config();
	const metrics = computeWeeklyMetrics({
		config: cfg,
		briefs: [brief("2026-08-18", [{ id: "a", source: "某源" }])],
		events: [],
		now: NOW,
	});
	const proposals = makeProposals({
		config: cfg,
		metrics,
		noHitStreak: new Map([["t1", 0]]),
		wantedTitles: [],
		now: NOW,
		idSeed: () => "x",
	});
	assert.equal(proposals.length, 0);
});

test("isCooled:冷却期未满不自动生效", () => {
	const p: Proposal = {
		id: "p1",
		createdAt: "2026-08-17T00:00:00Z",
		week: "2026-W34",
		targetName: "x",
		summary: "s",
		evidence: "e",
		patch: { type: "tracker-source-mode-all", trackerKey: "t1" },
		status: "pending",
	};
	assert.equal(isCooled(p, NOW), false);
	assert.equal(isCooled(p, new Date("2026-08-25T00:00:00Z")), true);
});

test("S5 · 提案永远改不了用户手写的原话与圈改过的理解句", () => {
	const before = [
		tracker({
			question: "我想关注 AI Agent",
			intentSegments: [
				{ text: "我自己写的这句", edited: true },
				{ text: "编辑写的那句" },
			],
		}),
	];
	// 模拟一个恶意/失控的改动:把原话和锁定句都改掉
	const after = [
		{
			...before[0],
			question: "被改掉的原话",
			intentSegments: [{ text: "被改掉的锁定句" }, { text: "编辑改的那句" }],
			sourceMode: "all" as const,
		},
	];
	const safe = preserveImmutable(before, after);
	assert.equal(safe[0].question, "我想关注 AI Agent");
	assert.deepEqual(safe[0].intentSegments?.[0], { text: "我自己写的这句", edited: true });
	// 非锁定的部分该改还是改
	assert.equal(safe[0].intentSegments?.[1].text, "编辑改的那句");
	assert.equal(safe[0].sourceMode, "all");
});

test("S5 · applyProposal 改了别的字段,也不会碰到不可改区", () => {
	const cfg = config({
		trackers: [
			tracker({
				question: "原话不许动",
				sourceMode: "selected",
				sourceKeys: ["s1"],
				intentSegments: [{ text: "锁定句", edited: true }],
			}),
		],
	});
	const result = applyProposal(cfg, {
		id: "p1",
		createdAt: NOW.toISOString(),
		week: "2026-W34",
		targetName: "定义一",
		summary: "放宽取材范围",
		evidence: "连续 9 期零命中",
		patch: { type: "tracker-source-mode-all", trackerKey: "t1" },
		status: "pending",
	});
	assert.ok(result);
	assert.equal(result.config.trackers[0].sourceMode, "all");
	assert.equal(result.config.trackers[0].question, "原话不许动");
	assert.deepEqual(result.config.trackers[0].intentSegments?.[0], { text: "锁定句", edited: true });
	assert.ok(result.log?.text.includes("依据"));
});

test("applyProposal:没有实际改动时返回 null(不留空变更记录)", () => {
	const cfg = config({ trackers: [tracker({ sourceMode: "all" })] });
	const result = applyProposal(cfg, {
		id: "p1",
		createdAt: NOW.toISOString(),
		week: "2026-W34",
		targetName: "定义一",
		summary: "放宽取材范围",
		evidence: "e",
		patch: { type: "tracker-source-mode-all", trackerKey: "t1" },
		status: "pending",
	});
	assert.equal(result, null);
});

test("S6 · 到顶必须替换最旧的,不许无限追加", () => {
	const full = Array.from({ length: 12 }, (_, i) => `词${i}`);
	const next = capList(full, ["新词"], 12);
	assert.equal(next.length, 12);
	assert.ok(next.includes("新词"));
	assert.ok(!next.includes("词0"), "最旧的那个应被挤掉");
	// 已存在的词不重复追加
	assert.deepEqual(capList(["a", "b"], ["b"], 12), ["a", "b"]);
});

// ---------- 观察式发现(检索源域名 → 直连源提案) ----------

test("queryFeedDomains:检索源反复命中的域名被统计,聚合器与已订域名除外", () => {
	const cfg = config({
		sources: [
			{ key: "q1", name: "Google News 检索", url: "https://news.google.com/rss/search?q=agent&hl=en-US&gl=US&ceid=US:en", category: "news" },
			{ key: "s1", name: "某源", url: "https://a.example/feed", category: "blog" },
		],
	});
	const mk = (date: string, id: string, url: string, sourceKey: string): Brief => ({
		date,
		generatedAt: `${date}T11:00:00.000Z`,
		sections: [
			{
				key: "t1",
				title: "定义一",
				items: [{ id, title: id, whyClick: "why", url, source: "x", sourceKey, publishedAt: `${date}T00:00:00Z` }],
			},
		],
		filteredOut: { scanned: 1, dropped: 0, summary: "", items: [] },
		sourceCount: 2,
	});
	const briefs = [
		mk("2026-08-18", "a", "https://siliconangle.com/1", "q1"),
		mk("2026-08-17", "b", "https://www.siliconangle.com/2", "q1"),
		mk("2026-08-16", "c", "https://siliconangle.com/3", "q1"),
		// 聚合器域名与非检索源的条目都不算数
		mk("2026-08-15", "d", "https://old.reddit.com/r/x/1", "q1"),
		mk("2026-08-14", "e", "https://siliconangle.com/4", "s1"),
		// 已经订着的域名不再建议
		mk("2026-08-13", "f", "https://a.example/5", "q1"),
	];
	const found = queryFeedDomains(cfg, briefs, 3);
	assert.equal(found.length, 1);
	assert.equal(found[0].domain, "siliconangle.com");
	assert.equal(found[0].count, 3);
	assert.equal(found[0].trackerKey, "t1");
});

test("makeSourceAddProposal:带依据成案;feed 已在库里则不成案", () => {
	const cfg = config();
	const metrics = computeWeeklyMetrics({ config: cfg, briefs: [brief("2026-08-18", [])], events: [], now: NOW });
	const found = { domain: "siliconangle.com", count: 3, trackerKey: "t1", sample: "Fortinet buys Virtue AI" };
	const p = makeSourceAddProposal(found, { url: "https://siliconangle.com/feed", title: "SiliconANGLE", total: 40, fresh: 6 }, cfg, metrics, NOW, "w-0");
	assert.ok(p);
	assert.equal(p.patch.type, "source-add");
	assert.match(p.evidence, /3 条/);
	// 同一个 feed 已在库:不成案
	const dup = config({ sources: [{ key: "sa", name: "SiliconANGLE", url: "https://siliconangle.com/feed", category: "news" }] });
	assert.equal(makeSourceAddProposal(found, { url: "https://siliconangle.com/feed" }, dup, metrics, NOW, "w-1"), null);
});

test("applyProposal:source-add 加进源库并挂进出证据的追踪器;重复应用返回 null", () => {
	const cfg = config({ trackers: [tracker({ sourceMode: "selected", sourceKeys: ["s1"] })] });
	const p: Proposal = {
		id: "p-x",
		createdAt: NOW.toISOString(),
		week: "2026-W34",
		targetName: "SiliconANGLE",
		summary: "把 siliconangle.com 升级成直连来源",
		evidence: "近 3 期 3 条",
		status: "pending",
		patch: { type: "source-add", name: "SiliconANGLE", url: "https://siliconangle.com/feed", category: "news", trackerKey: "t1" },
	};
	const res = applyProposal(cfg, p);
	assert.ok(res);
	const key = fnv1a("https://siliconangle.com/feed");
	assert.equal(res.config.sources.length, 2);
	assert.equal(res.config.sources[1].key, key);
	assert.ok(res.config.trackers[0].sourceKeys?.includes(key));
	// 已经加过:第二次应用是 no-op
	assert.equal(applyProposal(res.config, p), null);
});
