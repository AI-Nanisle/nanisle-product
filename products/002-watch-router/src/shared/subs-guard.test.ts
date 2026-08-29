// 订阅模式的安全护栏(docs/05 + 2026-08-29 安全评审)。这里验的都是「被绕过就要
// 出事」的那几条:内网地址、每天一条的原子性、订阅额度。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedFeedHost, parseSubscriptionInput } from "./discover.ts";
import { MemoryStore, QUOTA_LIMITS, QuotaExceededError } from "./store.ts";

describe("isBlockedFeedHost", () => {
	it("blocks loopback, private ranges, link-local metadata and CGNAT", () => {
		for (const h of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254", // 云元数据
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"localhost",
			"foo.localhost",
			"db.internal",
			"metadata.local",
			"::1",
			"fe80::1",
			"fd00::1",
		]) {
			assert.equal(isBlockedFeedHost(h), true, `应拦下 ${h}`);
		}
	});
	it("allows ordinary public hosts", () => {
		for (const h of ["feeds.megaphone.fm", "example.com", "172.32.0.1", "8.8.8.8", "11.0.0.1"]) {
			assert.equal(isBlockedFeedHost(h), false, `不该拦 ${h}`);
		}
	});
});

describe("parseSubscriptionInput", () => {
	it("rejects a feed URL pointing at the metadata service", () => {
		assert.equal(parseSubscriptionInput("http://169.254.169.254/latest/meta-data/"), null);
		assert.equal(parseSubscriptionInput("https://169.254.169.254/"), null);
		assert.equal(parseSubscriptionInput("https://127.0.0.1:8787/admin"), null);
	});
	it("rejects http feeds (https only)", () => {
		assert.equal(parseSubscriptionInput("http://feeds.example.com/rss"), null);
	});
	it("still accepts a normal https podcast feed and the two video platforms", () => {
		assert.deepEqual(parseSubscriptionInput("https://feeds.megaphone.fm/abc"), {
			platform: "podcast",
			feedUrl: "https://feeds.megaphone.fm/abc",
		});
		assert.deepEqual(parseSubscriptionInput("https://space.bilibili.com/12345"), { platform: "bilibili", mid: "12345" });
		assert.equal(parseSubscriptionInput("https://www.youtube.com/@someone")?.platform, "youtube");
	});
});

describe("claimSubRun(每人每天一条的闸)", () => {
	it("only the first concurrent caller gets the day", async () => {
		const store = new MemoryStore();
		const results = await Promise.all(Array.from({ length: 20 }, () => store.claimSubRun("a@b.c", "2026-08-29")));
		assert.equal(results.filter((r) => r === "fresh").length, 1);
		assert.equal(results.filter((r) => r === "taken").length, 19);
	});
	it("a stale 运行中 placeholder can be taken over, and the takeover is distinguishable", async () => {
		const store = new MemoryStore();
		assert.equal(await store.claimSubRun("a@b.c", "2026-08-29"), "fresh");
		// 没到 staleMs:不给
		assert.equal(await store.claimSubRun("a@b.c", "2026-08-29", 60_000), "taken");
		// 把占位改老,兜底就能接手
		const cur = await store.getSubRun("a@b.c", "2026-08-29");
		await store.putSubRun("a@b.c", { ...cur!, at: Date.now() - 30 * 60_000 });
		assert.equal(await store.claimSubRun("a@b.c", "2026-08-29", 20 * 60_000), "takeover");
	});
	it("a finished run (not 运行中) is never taken over", async () => {
		const store = new MemoryStore();
		await store.putSubRun("a@b.c", { date: "2026-08-29", picked: null, reason: "无可用候选", at: Date.now() - 86_400_000 });
		assert.equal(await store.claimSubRun("a@b.c", "2026-08-29", 20 * 60_000), "taken");
	});
});

describe("订阅额度与提交额度分开计", () => {
	it("sub is 1/day and does not eat into submit", async () => {
		const store = new MemoryStore();
		assert.equal(QUOTA_LIMITS.sub, 1);
		await store.reserveQuota("a@b.c", "2026-08-29", "sub");
		await assert.rejects(store.reserveQuota("a@b.c", "2026-08-29", "sub"), QuotaExceededError);
		// 手动提交那 10 次不受影响
		for (let i = 0; i < QUOTA_LIMITS.submit; i++) await store.reserveQuota("a@b.c", "2026-08-29");
		await assert.rejects(store.reserveQuota("a@b.c", "2026-08-29"), QuotaExceededError);
		assert.equal(await store.getQuota("a@b.c", "2026-08-29"), QUOTA_LIMITS.submit);
	});
});
