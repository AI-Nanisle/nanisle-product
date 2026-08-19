// E1 · 邮件推送(docs/04)的单测:退订 token 往返与防篡改、模板转义、
// 三句话的清洗与兜底。三句话虽然实现在 pipeline-core,但它整个存在的理由
// 就是邮件正文,测试归在这里。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderBriefEmail, unsubToken, verifyUnsubToken } from "./email.ts";
import { assembleBrief, parseEditorialJson } from "./pipeline-core.ts";
import type { FetchResult, Tracker } from "./pipeline-core.ts";

const SECRET = "test-secret";

test("unsubToken:往返验签拿回原邮箱", async () => {
	const token = await unsubToken(SECRET, "reader@example.com");
	assert.equal(await verifyUnsubToken(SECRET, token), "reader@example.com");
});

test("unsubToken:改一个字符 / 换密钥 / 纯垃圾,全部验不过", async () => {
	const token = await unsubToken(SECRET, "reader@example.com");
	const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
	assert.equal(await verifyUnsubToken(SECRET, tampered), null);
	assert.equal(await verifyUnsubToken("other-secret", token), null);
	assert.equal(await verifyUnsubToken(SECRET, "not-a-token"), null);
	assert.equal(await verifyUnsubToken(SECRET, ""), null);
});

test("renderBriefEmail:主题带中文日期,正文转义 HTML,text 版带退订链接", () => {
	const mail = renderBriefEmail({
		date: "2026-08-19",
		tldr: ["第一句", '<script>alert("x")</script>', "第三句"],
		appUrl: "https://nanisle.com/products/daily-brief",
		unsubUrl: "https://nanisle.com/products/daily-brief/api/email/unsub?token=abc",
	});
	assert.equal(mail.subject, "南屿简报 · 8月19日");
	assert.ok(!mail.html.includes("<script>"), "三句话必须转义后进 HTML");
	assert.ok(mail.html.includes("&lt;script&gt;"));
	assert.ok(mail.text.includes("unsub?token=abc"));
	assert.ok(mail.html.includes("打开今日简报"));
});

test("parseEditorialJson:tldr 清洗——去空、截 60 字、最多 3 句;格式不对整个丢掉", () => {
	const base = { sections: {}, notableDrops: [], droppedSummary: "" };
	const long = "长".repeat(80);
	const good = parseEditorialJson(JSON.stringify({ ...base, tldr: ["  a  ", "", long, "b", "c"] }), []);
	assert.deepEqual(good.tldr, ["a", "长".repeat(60), "b"]);
	assert.equal(parseEditorialJson(JSON.stringify({ ...base, tldr: "一句话" }), []).tldr, undefined);
	assert.equal(parseEditorialJson(JSON.stringify({ ...base, tldr: [] }), []).tldr, undefined);
	assert.equal(parseEditorialJson(JSON.stringify(base), []).tldr, undefined);
});

test("assembleBrief:模型漏给 tldr 时,从各版块首条机械拼出兜底", async () => {
	const tracker = { key: "t1", name: "追踪一", quota: 5 } as Tracker;
	const fetched: FetchResult = {
		candidates: [
			{
				id: "id1",
				sourceKey: "s1",
				source: "源一",
				category: "blog",
				title: "一篇标题",
				url: "https://example.com/a",
				publishedAt: "2026-08-19T00:00:00.000Z",
				excerpt: "摘要",
			},
		],
		ruleDropped: [],
		scanned: 1,
		sourcesOk: 1,
		sourceErrors: [],
		sourceStatus: [],
	};
	const editorial = parseEditorialJson(
		JSON.stringify({
			sections: { t1: [{ id: "id1", whyClick: "值得点开的理由" }] },
			notableDrops: [],
			droppedSummary: "",
		}),
		[tracker],
	);
	const brief = await assembleBrief(editorial, fetched, {
		date: "2026-08-19",
		sourceCount: 1,
		trackers: [tracker],
		lookupDiscussions: false,
	});
	assert.equal(brief.tldr?.length, 1);
	assert.ok(brief.tldr![0].includes("一篇标题"));
	assert.ok(brief.tldr![0].includes("值得点开的理由"));
});
