// ISO 8601 周编号。周扫的每一行都按它归档(weekly_scan.week_of),形状是
// `2026-W36`——**字典序即时间序**,所以 store.ts 那句 `ORDER BY week_of DESC`
// 不需要额外的日期列,第二周的跨周 diff 直接取最近两条就行。
//
// 单独一个文件而不是塞进 store.ts:它是纯日期算术,没有 D1 也没有业务,
// 而 recall-check 脚本和阶段 8 的 cron 都要用它,不该为了一个函数把 D1 的
// 类型拖进那两处。

/**
 * 某个时刻属于 ISO 8601 的哪一周,返回 `YYYY-Www`。
 *
 * **为什么不能直接用日历年 + 「今年第几个周一」**:ISO 的周归属规则是
 * 「一周属于它的星期四所在的那一年」,于是跨年那一周的年份会和日历年不一致,
 * 而且两个方向都会发生:
 *
 *   2024-12-30(周一) → **2025**-W01   日历上还是 2024 年,ISO 已经进 2025 了
 *   2021-01-01(周五) → **2020**-W53   日历上已是 2021 年,ISO 还留在 2020
 *
 * 用日历年拼出来的 `2024-W01` 和 `2021-W53` 会让同一周在库里出现两个 id
 * (cron 跨年那天补跑一次就复现),重跑幂等当场失效——ux_scan 那条 UNIQUE
 * 认的是 (dossier_id, week_of),week_of 不一样它就是两行。更难看出来的是
 * 排序:`2021-W53` 排在 `2021-W01` 后面,跨周 diff 会把去年最后一周当成
 * 今年最新的一周拿去比。
 *
 * 算法是标准那一套:先把日期挪到**本周的星期四**(周四决定这一周归哪年),
 * 之后年份直接读这个星期四的年份,周数是它离同年 1 月 1 日的天数换算。
 * 全程走 UTC 取值——闸门和归档口径统一用 UTC(store.ts todayUtc 的理由),
 * 本地时区会让同一个时刻在两台机器上算出不同的周。
 */
export function isoWeek(at: number | Date = Date.now()): string {
	const src = at instanceof Date ? at : new Date(at);
	// 只取年月日,把时分秒抹掉:同一天的两次调用必须给出同一个答案
	const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
	// getUTCDay() 周日是 0;`|| 7` 把周日换算成 7,这样 1..7 = 周一..周日,
	// `+ 4 - dow` 就是「挪到本周星期四」(周一 +3、周日 -3)。
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const isoYear = d.getUTCFullYear();
	const jan1 = Date.UTC(isoYear, 0, 1);
	const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
	return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** `2026-W36` 的形状校验。查询参数进来先过它,别拿一个乱七八糟的串去查库。 */
export const WEEK_OF_RE = /^\d{4}-W\d{2}$/;
