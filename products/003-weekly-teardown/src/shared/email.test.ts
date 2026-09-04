// email.ts 的测试(退订 token + 门铃邮件模板)。跑法:npm test。
//
// token 那几条照 002 的用例来(签发 / 验证 / 篡改 / 换密钥),因为那段代码是从
// 002 物理复制过来的——**复制过来的东西必须连测试一起复制**,否则「和 002 一样」
// 这句话就没有任何东西钉着。
//
// 模板那几条钉的是 docs/01 决策 5 的三条硬约束:邮件只放清单 + 差异 + 一个按钮;
// 清单不许被截断;残缺必须说出来。**每一条都对应一种「不报错的错」**——邮件
// 少了一行、多了一段,收件人只会觉得这封信有点怪,没有任何东西会响。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTeardownEmail, unsubToken, verifyUnsubToken } from "./email.ts";
import type { TeardownEmailCandidate, TeardownEmailInput } from "./email.ts";
import { EMPTY_RECHECK } from "./scan-diff.ts";
import type { WeekDiff } from "./scan-diff.ts";

// ---------------------------------------------------------------------------
// 退订 token
// ---------------------------------------------------------------------------

const SECRET = "unsub-secret-长一点儿的随机串";
const OTHER = "another-secret";

describe("退订 token", () => {
	it("签发的 token 能验回同一个邮箱", async () => {
		const t = await unsubToken(SECRET, "someone@example.com");
		assert.equal(await verifyUnsubToken(SECRET, t), "someone@example.com");
	});

	it("中文/加号邮箱也能原样往返(base64url 不是装饰)", async () => {
		const email = "a+b.tag@例子.com";
		assert.equal(await verifyUnsubToken(SECRET, await unsubToken(SECRET, email)), email);
	});

	it("改邮箱那一半 → 验不过(签名对不上)", async () => {
		const t = await unsubToken(SECRET, "someone@example.com");
		const forged = `${btoa("victim@example.com").replace(/=+$/, "")}.${t.split(".")[1]}`;
		assert.equal(await verifyUnsubToken(SECRET, forged), null);
	});

	it("改签名那一半 → 验不过", async () => {
		const t = await unsubToken(SECRET, "someone@example.com");
		const [head, sig] = t.split(".");
		// 翻一个字符;避开「翻成同一个字符」的巧合
		const flipped = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
		assert.equal(await verifyUnsubToken(SECRET, `${head}.${flipped}`), null);
	});

	it("换一把密钥 → 验不过(这就是为什么它不能复用 SSO 密钥也没关系)", async () => {
		const t = await unsubToken(SECRET, "someone@example.com");
		assert.equal(await verifyUnsubToken(OTHER, t), null);
	});

	it("形状不对的串一律 null,不抛异常(退订端点会拿它当 400)", async () => {
		for (const bad of ["", ".", "nodot", "....", "!!!.???"]) {
			assert.equal(await verifyUnsubToken(SECRET, bad), null);
		}
	});
});

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

const cand = (fullName: string, over: Partial<TeardownEmailCandidate> = {}): TeardownEmailCandidate => ({
	fullName,
	stars: 1234,
	archived: false,
	oneLiner: `${fullName} 是一个命令行工具`,
	appealedFrom: null,
	...over,
});

const noDiff: WeekDiff = {
	prevWeekOf: null,
	appeared: [],
	archivedNow: [],
	licenseChanged: [],
	starJumps: [],
	recheck: EMPTY_RECHECK,
	changed: false,
};

const input = (over: Partial<TeardownEmailInput> = {}): TeardownEmailInput => ({
	domain: "长视频总结与转写",
	weekOf: "2026-W36",
	candidates: [cand("a/one"), cand("b/two")],
	diff: noDiff,
	stopped: null,
	openUrl: "https://nanisle.com/products/weekly-teardown/app",
	unsubUrl: "https://nanisle.com/products/weekly-teardown/unsub?token=abc",
	...over,
});

describe("门铃邮件 · 清单", () => {
	it("每一行有名字、★、一句话形态描述", () => {
		const { text } = renderTeardownEmail(input());
		assert.match(text, /1\. a\/one {2}★1,234/);
		assert.match(text, /a\/one 是一个命令行工具/);
		assert.match(text, /2\. b\/two/);
	});

	it("归档徽章:两个版本都要有,别只在网页上有", () => {
		const { text, html } = renderTeardownEmail(input({ candidates: [cand("dead/repo", { archived: true })] }));
		assert.match(text, /\[已归档\]/);
		assert.match(html, /已归档/);
	});

	it("admitted > 5 时**一行都不截断**(申诉能让清单长过 SCAN_PICK_LIMIT)", () => {
		const eight = Array.from({ length: 8 }, (_, i) => cand(`o/r${i}`));
		const { text, html, subject } = renderTeardownEmail(input({ candidates: eight }));
		for (let i = 0; i < 8; i++) {
			assert.match(text, new RegExp(`${i + 1}\\. o/r${i}\\b`), `第 ${i + 1} 行不见了`);
			assert.ok(html.includes(`o/r${i}`), `html 里第 ${i + 1} 行不见了`);
		}
		// 主题里的数字也得是真实条数,不是写死的 5
		assert.match(subject, /8 个候选/);
	});

	it("申诉捞回来的:显示「你捞回来的」+ 当初的排除理由", () => {
		const { text, html } = renderTeardownEmail({
			...input(),
			candidates: [cand("saved/one", { appealedFrom: "没有许可证,法律上不可用" })],
		});
		assert.match(text, /你捞回来的/);
		assert.match(text, /没有许可证,法律上不可用/);
		assert.match(html, /你捞回来的/);
		assert.match(html, /没有许可证,法律上不可用/);
	});

	it("算法挑的那些**不该**出现「你捞回来的」——那是用户动作的痕迹,不是装饰", () => {
		const { text } = renderTeardownEmail(input());
		assert.ok(!text.includes("你捞回来的"));
	});

	it("一句话没问出来时有降级文案,不是空白行", () => {
		const { text } = renderTeardownEmail(input({ candidates: [cand("no/liner", { oneLiner: null })] }));
		assert.match(text, /这一句形态描述没问出来/);
	});

	it("候选为 0 时说清是「全被规则筛掉了」,并把人指向排除清单", () => {
		const { text, subject } = renderTeardownEmail(input({ candidates: [] }));
		assert.match(subject, /这一周没有候选/);
		assert.match(text, /一个候选都没有/);
		assert.match(text, /排除清单/);
	});
});

describe("门铃邮件 · 差异", () => {
	it("第一周如实说「没有可比的上一周」", () => {
		const { text } = renderTeardownEmail(input());
		assert.match(text, /这是第一周,没有可比的上一周/);
		assert.ok(!text.includes("新进清单"));
	});

	it("四类变化各自出现,并且把口径(和哪一周比)印在标题里", () => {
		const { text } = renderTeardownEmail(
			input({
				diff: {
					prevWeekOf: "2026-W35",
					appeared: ["new/one"],
					archivedNow: ["dead/two"],
					licenseChanged: [{ fullName: "law/three", from: "MIT", to: null }],
					starJumps: [{ fullName: "hot/four", from: 1000, to: 1400, delta: 400 }],
					recheck: EMPTY_RECHECK,
					changed: true,
				},
			}),
		);
		assert.ok(text.includes("与上一次(2026-W35)比"));
		assert.match(text, /新进清单:new\/one/);
		assert.match(text, /转归档:dead\/two/);
		// 用 includes 而不是正则:这几句里的全角括号在正则里是普通字符,但
		// 半角括号会被当成捕获组——写错一次,断言会安静地变成「只要有这几个字就算过」。
		assert.ok(text.includes("换许可证:law/three(MIT → 没有许可证)"));
		assert.ok(text.includes("star 跃迁:hot/four(1,000 → 1,400,+400)"));
	});

	it("有上一周但什么都没动时,明说「一条都没有」,不是留一片空白", () => {
		const { text } = renderTeardownEmail(input({ diff: { ...noDiff, prevWeekOf: "2026-W35" } }));
		assert.match(text, /一条变化都没有/);
	});
});

// ---------------------------------------------------------------------------
// 复查(阶段 9)
// ---------------------------------------------------------------------------

/** 一份带复查结果的 diff。默认「上一周 3 个仓,全查成了,什么都没变」。 */
const withRecheck = (over: Partial<WeekDiff["recheck"]> = {}): WeekDiff => ({
	...noDiff,
	prevWeekOf: "2026-W35",
	recheck: { ...EMPTY_RECHECK, checked: 3, ...over },
});

describe("门铃邮件 · 复查上一周的仓", () => {
	it("**掉出清单 + 已归档**要同时说出来 —— 只说前者会被读成「它只是排名掉了」", () => {
		const { text } = renderTeardownEmail(
			input({
				diff: withRecheck({
					changed: 1,
					changes: [{ fullName: "dead/one", kind: "archived", stillListed: false }],
				}),
			}),
		);
		assert.match(text, /转归档:dead\/one/);
		assert.ok(text.includes("不在上面那份清单里了"));
	});

	it("仓被删(404)是一种「死了」,措辞和「没查成」完全不同", () => {
		const { text } = renderTeardownEmail(
			input({
				diff: withRecheck({
					changed: 1,
					changes: [{ fullName: "poof/gone", kind: "gone", stillListed: false }],
				}),
			}),
		);
		assert.match(text, /已经没了:poof\/gone/);
		assert.ok(text.includes("404"));
		// **不能被写成「没查成」**:这是 GitHub 明确回答的,不是我们没问到
		assert.ok(!text.includes("poof/gone —— 没查成"));
	});

	it("没查成的那些单独成栏,并且明说「不代表它们出事了」", () => {
		const { text } = renderTeardownEmail(
			input({
				diff: withRecheck({
					unchecked: 2,
					unavailable: [
						{ fullName: "a/one", why: "GET /repos/a/one 失败:HTTP 503" },
						{ fullName: "b/two", why: "复查撞上 GitHub 限流" },
					],
				}),
			}),
		);
		assert.ok(text.includes("复查了上一周清单上的 3 个仓:0 个有变化,2 个没查成"));
		assert.ok(text.includes("没查成的不代表它们出事了"));
		assert.match(text, /a\/one —— GET \/repos\/a\/one 失败:HTTP 503/);
		// 没查成 ≠ 没了:404 那套措辞一个字都不该出现
		assert.ok(!text.includes("已经没了"));
	});

	it("复查过了什么都没发现,那句账**照样印**(否则和「根本没复查」长得一样)", () => {
		const { text } = renderTeardownEmail(input({ diff: withRecheck() }));
		assert.ok(text.includes("复查了上一周清单上的 3 个仓:0 个有变化,0 个没查成"));
	});

	it("这一趟没做复查(checked=0)时**一个字都不提** —— 不把「没做」说成「做了没发现」", () => {
		const { text } = renderTeardownEmail(input({ diff: { ...noDiff, prevWeekOf: "2026-W35" } }));
		assert.ok(!text.includes("复查"));
	});
});

describe("门铃邮件 · 残缺必须说", () => {
	it("stopped 非空时正文有警示,主题也标出来", () => {
		const { text, html, subject } = renderTeardownEmail(input({ stopped: "额度不够,只跑了 3 条检索词" }));
		assert.match(text, /这一周的清单是残缺的/);
		assert.match(text, /只跑了 3 条检索词/);
		assert.match(html, /这一周的清单是残缺的/);
		assert.match(subject, /清单残缺/);
	});

	it("stopped 为 null 时不许出现这句警示(别把正常的一周吓成残缺)", () => {
		const { text, subject } = renderTeardownEmail(input());
		assert.ok(!text.includes("清单是残缺的"));
		assert.ok(!subject.includes("清单残缺"));
	});
});

describe("门铃邮件 · 只当门铃不当报纸(docs/01 决策 5)", () => {
	it("正文里只有一个回网页的地址,而且就是 openUrl", () => {
		const { text } = renderTeardownEmail(input());
		const links = text.match(/https?:\/\/\S+/g) ?? [];
		// 一个「打开网页」+ 一个退订,不多不少
		assert.deepEqual(links.sort(), [input().openUrl, input().unsubUrl].sort());
	});

	it("**没有报告正文**:没有 takeaway、没有引文、没有 commit sha 的行号链接", () => {
		// 这条用例的写法是:凡是只可能来自深度报告的痕迹,一个都不许出现在邮件里。
		// 它挡的是「把报告塞进邮件更方便」这种以后一定会有人提的改动 ——
		// 那些带 commit sha 的行号链接在邮件客户端里全是死的(email.ts 文件头)。
		const { text, html } = renderTeardownEmail(
			input({
				candidates: [cand("a/one"), cand("b/two", { appealedFrom: "排在第 9 位" })],
				stopped: "额度不够",
				diff: { ...noDiff, prevWeekOf: "2026-W35", appeared: ["c/three"], changed: true },
			}),
		);
		for (const marker of ["takeaway", "引文", "逐字", "#L", "commit", "basedOn", "锚定"]) {
			assert.ok(!text.includes(marker), `text 里出现了报告的痕迹:${marker}`);
			assert.ok(!html.includes(marker), `html 里出现了报告的痕迹:${marker}`);
		}
		// 而且整封信短得像门铃:一封放了报告全文的信不可能只有这么长
		assert.ok(text.length < 1200, `正文 ${text.length} 字,门铃不该这么长`);
	});

	it("List-Unsubscribe 要用的退订地址一定在正文里(Gmail 2024 起的硬要求之外再给人一条路)", () => {
		const { text, html } = renderTeardownEmail(input());
		assert.ok(text.includes(input().unsubUrl));
		assert.ok(html.includes(input().unsubUrl));
	});
});
