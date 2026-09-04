// 第四屏:跨周变化(2026-09-01 上线前终审)。
//
// **这一屏是这个产品存在的理由本身。** docs/01「为什么不做成 skill」那一节的
// 结论是:这个产品完全可以做成一个 Claude Code skill,半天做完,skill 给不了的
// 只有**跨周状态**;而站长选的四条差异化里有两条建在它上面。在这一屏出现之前,
// 跨周 diff 算完只进了一封**可能发不出去的**邮件(本地库里就躺着一行
// `sent_at: null, error: 'SES send failed (HTTP 403)'`),而认领行不删不重试,
// 于是那一周的结论在库里一个字都没有。
//
// 连带的更重:docs/01 风险 4 的判据原文是「第二个月诚实复盘一次:如果站长从不
// 去翻上一周的结果,那就该把这个产品退回 skill 形态」—— 而在这一屏之前,**产品里
// 根本没有「翻上一周」这个动作可翻**。一条执行不了的判据不是判据。这一屏就是把
// 那个动作造出来。
//
// 三条规矩是后端契约里逐条写死的(types.ts / scan.ts 的 docblock),这一屏把它们
// 落到像素上:
//
//   1. `change: null` = 「这一周**没有跨周记录**」,**不是**「没有变化」。
//      后者是 change 非 null 且 counts.changed === false。两句话文案必须不同 ——
//      混成一句的话,一个「我们压根没记」的星期会被读成「我们记了,一切照旧」。
//   2. `counts.recheckChecked === 0` 时**一个字都不要提复查**。说「复查了 0 个」
//      是把「没做」说成「做了没发现」(邮件模板里是同一条规矩)。所以复查那一节
//      在这种情况下**整节不渲染**,连标题都没有。
//   3. **「没查成」和「没了」是两栏。**「没查成」只代表这一次没问到 GitHub,不代表
//      它出事了 —— 这是终审那条「404 与 5xx 必须分开」的同一条纪律。
//
// **本文件一个数都不算**(家法同 Scan.tsx):四类变化的数字一律取
// `change.counts`,**不是** `diff.appeared.length`。两者由后端的 `putWeeklyChange`
// 从同一份 WeekDiff 一次算出,而邮件正文用的也是同一组数 —— 前端另数一遍就等于
// 同一件事有两个算法,而两个算法迟早只有一个是对的。唯一的例外是「我这一栏真的
// 渲染了几行」(同 groupExclusions 的口径),那不是猜,是数自己画出来的东西。
//
// 这个文件**只渲染,不发请求**(分工同 Scan.tsx / Dossier.tsx),组件全是纯函数 ——
// changes-render.test.ts 靠「直接把组件当函数调 + react-dom/server 渲染成 HTML」
// 来断言,组件一旦带上 hook 就测不动了。

import type { ReactNode } from "react";

import type {
	GetScanResponse,
	RecheckChange,
	RecheckReport,
	WeekDiff,
	WeeklyChange,
	WeeklyChangeCounts,
	WeeklyScan,
} from "../shared/types.ts";
import ScanView from "./Scan";

// ---------------------------------------------------------------------------
// 小件(与 Scan.tsx 同款,刻意重复而不是抽公共文件:两屏的排版将来会分头走,
// 而 <N> 只有两行)
// ---------------------------------------------------------------------------

/** 页面上每一个数字都包一层,既是排版也是**测试抓手**(class="hn" 好断言)。 */
function N({ v }: { v: number }) {
	return <b className="hn">{v}</b>;
}

const repoUrl = (fullName: string) => `https://github.com/${fullName}`;

/** 许可证的「没有」是一种状态,不是留白 —— 留白会被读成「我没查」。 */
const lic = (v: string | null) => (v === null ? "没有许可证" : v);

// ---------------------------------------------------------------------------
// 翻周那一列
// ---------------------------------------------------------------------------

/**
 * 最近 N 周的台账,倒序。**这就是「翻上一周」那个动作的入口**(风险 4 的判据
 * 要能执行,靠的就是这一列)。
 *
 * 为什么这里自己排一次序:后端 `listRecentScans` 已经 `ORDER BY week_of DESC`,
 * 而 `week_of` 的形状(`2026-W36`)是**字典序即时间序**(shared/week.ts 顶部)。
 * 再排一次的成本是一行,换来的是「万一哪天那条 SQL 的排序被改动,页面不会安静地
 * 把三周前排在最上面」——一份顺序错了的历史列表不会报错,只会让人读错。
 * **注意这不是「前端自己算数」**:每一行的四个计数仍然原样取自 `WeeklyScan`,
 * 这里动的只是行的先后。
 *
 * `stopped` 非空的那几周必须标出来:那一周的清单是**残的**,拿它当基准去比
 * 「新出现了什么」会得出一堆假的「新进清单」——而残的清单和全的清单长得一模一样
 * (docs/01 风险 1「错得很安静」)。
 */
export function WeekPicker({
	scans,
	picked,
	onPick,
}: {
	scans: readonly WeeklyScan[];
	/** 当前在看哪一周;null = 最近一周(也就是列表第一行)。 */
	picked: string | null;
	onPick: ((weekOf: string) => void) | null;
}) {
	if (scans.length === 0) {
		return (
			<p className="empty-note">
				还没有任何一周的扫描记录。跨周变化要有<strong>两周</strong>才比得出来 —— 先去本周清单跑一次,下一周再回来看。
			</p>
		);
	}
	const sorted = [...scans].sort((a, b) => (a.weekOf < b.weekOf ? 1 : a.weekOf > b.weekOf ? -1 : 0));
	const current = picked ?? sorted[0]?.weekOf ?? null;
	return (
		<>
			<ol className="week-list">
				{sorted.map((s, i) => {
					const on = s.weekOf === current;
					return (
						<li key={s.weekOf} className={`week-row${on ? " week-on" : ""}${s.stopped ? " week-partial" : ""}`}>
							<button
								type="button"
								className="week-pick"
								aria-current={on ? "true" : undefined}
								disabled={onPick === null}
								onClick={() => onPick?.(s.weekOf)}
							>
								<span className="week-of">{s.weekOf}</span>
								{i === 0 && <span className="week-tag">最近一周</span>}
								<span className="week-facts">
									进清单 <N v={s.admitted} /> · 排除 <N v={s.excluded} /> · 返回 <N v={s.returned} /> · 抓失败{" "}
									<N v={s.fetchFailed} />
								</span>
								<span className="week-rev">档案 v{s.dossierRev}</span>
								{s.stopped && (
									<span className="week-stopped" title={s.stopped}>
										这一周没跑完 · 清单是残的
									</span>
								)}
							</button>
						</li>
					);
				})}
			</ol>
			<p className="dsec-why">
				标着<strong>「这一周没跑完」</strong>的那几周,检索词有一部分根本没发出去,清单是残的。
				拿它当基准比出来的「新进清单」里会混进一批<strong>其实上周就有、只是上周没搜到</strong>的仓 ——
				鼠标停在那个标记上能看到当时提前收工的原因。
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// 「这一周没有跨周记录」 vs 「记了,一个变化都没有」
// ---------------------------------------------------------------------------

/**
 * `change: null`。**这句话说的是「没记过」,不是「没变化」。**
 *
 * 这是这一屏最容易写坏的一处,而写坏了不会报错:把它和「记了、没变化」写成同一句
 * 之后,一个从来没被算过跨周结论的星期会显示成「一切照旧」—— 那正是这个产品
 * 反复在防的那种「错得很安静」。所以这里连一个「变化」两个字都不出现。
 */
export function NoChangeRecord({ weekOf }: { weekOf: string | null }) {
	return (
		<div className="xw-none">
			<p className="xw-none-lead">
				<strong>{weekOf ? `${weekOf} ` : "这一周"}没有跨周记录。</strong>
				也就是说:这一周的跨周结论<strong>从来没有被算出来过、也没有存下来</strong>。
			</p>
			<p className="dsec-why">
				这句话<strong>不等于「这一周什么都没变」</strong> —— 那是另一回事,而且那一种情况下这一节会明说它拿哪一周来比的。
				没有记录只有三种可能:
			</p>
			<ul className="xw-why-list">
				<li>这个档案还没跑过周扫(那就先去本周清单跑一次);</li>
				<li>那一周跑在「跨周结论落库」这条改动上线之前(旧的那几周只算过一次、只进了邮件,库里没有);</li>
				<li>那一行的明细坏了 —— 服务端解析不了就当它不存在,并且在日志里响一声,而不是印出一个数底下一行都没有。</li>
			</ul>
		</div>
	);
}

/**
 * `prevWeekOf === null`:第一周。**如实说,不假装有。**
 *
 * docs/01 决策 8 早就写明了这个代价:「第一周注定看起来平庸,四条差异化里有三条
 * 要到第二周才有东西可看」。既然产品方案里接受了它,页面上就该原样说出来,而不是
 * 渲染一个四格全是 0 的比较区块 —— 那个 0 读起来是「比过了,没变化」,是假话。
 *
 * **这段话里一个「复查」都不许出现**,哪怕是「下周就会有复查结论」这种将来时。
 * 第一周的 `recheckChecked` 恒为 0,而文件顶部规矩 2 是一条**没有例外**的规矩:
 * 只要那个数是 0,页面上就不该有那两个字 —— 留一个「未来时的例外」,下一个人
 * 照着它写一句「这一周复查了 0 个」就没有任何东西拦得住了。所以这里说的是
 * 「上面这几个仓一周之后各自怎么样了」,同一件事,但不借那个词。
 */
export function FirstWeek({ weekOf }: { weekOf: string }) {
	return (
		<div className="xw-first">
			<p className="xw-first-lead">
				<strong>这是第一周({weekOf}),没有可比的上一周。</strong>
			</p>
			<p className="dsec-why">
				增量要到<strong>下周</strong>才有东西可看:这一周的清单已经作为基准存进库里了,下一次周扫跑完,
				这里就会出现「新进清单 / 转归档 / 换许可证 / star 跃迁」四类,以及上面这几个仓一周之后各自怎么样了。
				<strong>这一节现在不画那四个格子</strong> —— 四个 0 读起来是「比过了,没变化」,而事实是根本没得比。
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 四类变化
// ---------------------------------------------------------------------------

/**
 * 计数与明细自检。口径抄 `Scan.tsx` 的 `LedgerCheck`:这个产品的标准是**错要响**。
 *
 * 正常情况下这一段什么都不渲染 —— `putWeeklyChange` 只收一个 `diff`,列和 JSON
 * 都由它从同一份算出来,调用方连传一组自相矛盾的数的机会都没有。真对不上就只有
 * 一种解释:库里那一行被人手改过、或者写坏了。那时候页面上四个数照样是后端那一组
 * (下面那些格子印的就是 counts),但必须当场说破它和明细对不上。
 *
 * **`changed` 不在自检范围内**:它不是「四类之和 > 0」——复查报出来的变化
 * (转归档 / 换许可证 / 仓没了)不进那四栏。拿和去验它会造出一个每周都可能误报的
 * 假警报,而那正是这份自检要防的东西的反面。
 */
export function ChangeCheck({ counts, diff }: { counts: WeeklyChangeCounts; diff: WeekDiff }) {
	const bad: string[] = [];
	if (counts.appeared !== diff.appeared.length) bad.push(`新进清单 ${counts.appeared} vs 明细 ${diff.appeared.length} 条`);
	if (counts.archived !== diff.archivedNow.length)
		bad.push(`转归档 ${counts.archived} vs 明细 ${diff.archivedNow.length} 条`);
	if (counts.licenseChanged !== diff.licenseChanged.length)
		bad.push(`换许可证 ${counts.licenseChanged} vs 明细 ${diff.licenseChanged.length} 条`);
	if (counts.starJumps !== diff.starJumps.length)
		bad.push(`star 跃迁 ${counts.starJumps} vs 明细 ${diff.starJumps.length} 条`);
	if (bad.length === 0) return null;
	return (
		<p className="scan-alarm" role="alert">
			<strong>这一周的跨周记录自相矛盾。</strong>
			计数和明细对不上:{bad.join(";")}。下面的数字印的是<strong>落库的那一组计数</strong>(邮件里用的也是它),
			但明细少了几条 —— 这一行八成写坏了,把这一周重跑一次才会重新算。
		</p>
	);
}

/**
 * 一格变化。
 *
 * `n` 来自 `counts`,`children` 来自 `diff` —— **两个来源在这里刻意分开传**,
 * 就是为了让「数字取自后端、明细只负责铺开」这件事在类型上就成立:想把 n 写成
 * `children.length` 的人得先改这个签名。
 */
function ChangeCell({ label, n, hint, children }: { label: string; n: number; hint: string; children: ReactNode }) {
	return (
		<div className={`xw-cell${n > 0 ? " xw-cell-on" : ""}`}>
			<div className="xw-cell-head">
				<span className="xw-cell-label">{label}</span>
				<N v={n} />
			</div>
			<p className="xw-cell-hint">{hint}</p>
			{n === 0 ? <p className="xw-cell-none">这一类这周一个都没有。</p> : children}
		</div>
	);
}

/**
 * 「本周与上一周比」那一块。
 *
 * 标题里印的是 `prevWeekOf` 的**原值**,而不是「上周」两个字:cron 挂过一周、
 * 或者这个人上上周才建的档,中间就会有空档,拿来比的那一周不一定是本周减 7 天
 * (types.ts `WeeklyChange.prevWeekOf` 的注释写死了这条)。把口径印在读者眼前,
 * 比让他自己默认「上周」然后在某一周被静静地骗一次好。
 */
export function CrossWeek({ change }: { change: WeeklyChange }) {
	const { counts, diff, weekOf, prevWeekOf } = change;
	if (prevWeekOf === null) return <FirstWeek weekOf={weekOf} />;
	return (
		<>
			<p className="xw-lead">
				<strong>{weekOf}</strong> 和上一次(<strong>{prevWeekOf}</strong>)比。
				<span className="xw-lead-why">
					{" "}
					写「上一次」不写「上周」是有原因的:定时扫描挂过一周、或者你这份档案中间隔过几周,拿来比的就不是上周
					—— 这里印的是<strong>真的拿来比的那一周</strong>。
				</span>
			</p>

			{counts.changed ? null : (
				<p className="xw-quiet">
					<strong>比过了 —— 和 {prevWeekOf} 相比,一个变化都没有。</strong>
					这和「这一周压根没被算过」是两回事:这一周的结论算出来了、也存下来了,内容就是「什么都没动」。
				</p>
			)}

			<ChangeCheck counts={counts} diff={diff} />

			<div className="xw-grid">
				<ChangeCell label="新进清单" n={counts.appeared} hint="上一次的清单里没有它">
					<ul className="xw-list">
						{diff.appeared.map((name) => (
							<li key={name}>
								<a className="xw-name" href={repoUrl(name)} target="_blank" rel="noreferrer">
									{name}
								</a>
							</li>
						))}
					</ul>
				</ChangeCell>

				<ChangeCell label="转归档" n={counts.archived} hint="archived 由 false 变 true,作者自己按的">
					<ul className="xw-list">
						{diff.archivedNow.map((name) => (
							<li key={name}>
								<a className="xw-name" href={repoUrl(name)} target="_blank" rel="noreferrer">
									{name}
								</a>
							</li>
						))}
					</ul>
				</ChangeCell>

				<ChangeCell label="换许可证" n={counts.licenseChanged} hint="能不能抄它,这一条说了算">
					<ul className="xw-list">
						{diff.licenseChanged.map((c) => (
							<li key={c.fullName}>
								<a className="xw-name" href={repoUrl(c.fullName)} target="_blank" rel="noreferrer">
									{c.fullName}
								</a>
								<span className="xw-delta">
									{lic(c.from)} → {lic(c.to)}
								</span>
							</li>
						))}
					</ul>
				</ChangeCell>

				<ChangeCell label="star 跃迁" n={counts.starJumps} hint="按比例算的阈值,两头都夹住(小项目翻倍、大仓日常波动)">
					<ul className="xw-list">
						{diff.starJumps.map((j) => (
							<li key={j.fullName}>
								<a className="xw-name" href={repoUrl(j.fullName)} target="_blank" rel="noreferrer">
									{j.fullName}
								</a>
								<span className="xw-delta">
									★{j.from} → ★{j.to}(+{j.delta})
								</span>
							</li>
						))}
					</ul>
				</ChangeCell>
			</div>

			<p className="dsec-why">
				这四格的数字取自这一行<strong>落库的计数</strong>,和每周一那封邮件里的那句话是同一组数 —— 页面不会自己再数一遍明细。
				{counts.recheckChecked > 0 && (
					<>
						{" "}
						注意<strong>「有没有变化」不等于这四格之和大于 0</strong>:下面那一节报出来的
						(转归档 / 换许可证 / 仓没了)不进这四栏。
					</>
				)}
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// 复查结论(三栏)
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<RecheckChange["kind"], string> = {
	gone: "已经没了",
	archived: "转归档",
	license: "换了许可证",
};

/**
 * 复查那三个数的**页面级自检**(2026-09-01 冻结前最后一轮补的)。
 *
 * 在这之前,页面上每一个数都有自检(`Scan.tsx` 的 `LedgerCheck`、上面的
 * `ChangeCheck`),**只有复查这三个数没有** —— 它们是全页唯一「无人核对」的数。
 * 当时验不了是因为缺一块拼图:`changed` 的口径是「几个**仓**出事了」而 `changes`
 * 是「一共几**条**变化」(一个仓归档 + 换许可证是两条一个仓),所以
 * `checked = changed + unchecked + 没事的` 里的最后一项在明细层根本拿不到。
 *
 * 后端补上 `recheck.unchanged` 之后那一项有了,等式在明细层**精确成立**:
 *
 *   checked = changed(仓数) + unchecked + unchanged.length
 *
 * 因为上一周清单上的每个仓恰好落进三处之一 —— 没查成、出事了、查过没事。
 * 另外 `unchecked === unavailable.length` 也一起验(那是同一个数的两处投影)。
 *
 * **`changes.length` 故意不参与等式**:它是条数不是仓数,拿它去验会造出一个
 * 「一个仓同时归档又换许可证」时必然误报的假警报 —— 而假警报正是这类自检
 * 最该防的东西的反面(立场同 `ChangeCheck` 对 `changed` 的处理)。
 *
 * 正常情况下它什么都不渲染:这三个数和明细都是 `foldRecheck` 一趟循环里同时产出的,
 * 对不上只有一种解释 —— 库里那一行被人手改过,或者写坏了。
 */
export function RecheckCheck({ counts, recheck }: { counts: WeeklyChangeCounts; recheck: RecheckReport }) {
	const bad: string[] = [];
	const sum = counts.recheckChanged + counts.recheckUnchecked + recheck.unchanged.length;
	if (counts.recheckChecked !== sum)
		bad.push(
			`本该查 ${counts.recheckChecked} 个,但「出事了 ${counts.recheckChanged} + 没查成 ${counts.recheckUnchecked} + 查过没事 ${recheck.unchanged.length}」= ${sum}`,
		);
	if (counts.recheckUnchecked !== recheck.unavailable.length)
		bad.push(`没查成 ${counts.recheckUnchecked} vs 明细 ${recheck.unavailable.length} 个`);
	if (bad.length === 0) return null;
	return (
		<p className="scan-alarm" role="alert">
			<strong>这一周的复查账对不上。</strong>
			{bad.join(";")}。上一次清单上的每个仓只可能落进三处之一(没查成 / 出事了 / 查过没事),
			这三处加起来必须等于本该查的个数 —— 对不上说明这一行写坏了,下面三栏至少有一栏是残的。
		</p>
	);
}

/**
 * 一条复查出来的变化。
 *
 * **两件事必须分别说出来**(scan-diff.ts `RecheckChange.stillListed` 的原话):
 * 「它掉出清单了」和「它死了」是两回事,而后者重要得多。只说前者的话,读者会以为
 * 它只是排名掉下去了 —— 而**加复查这个功能的全部理由**就是要报出后者:一个仓
 * 一旦归档 / 被删,它就会被规则层筛掉,于是**它不会出现在本周清单上**,
 * 「上周清单 vs 本周清单」这条口径天生看不见它。
 */
export function RecheckChangeRow({ c }: { c: RecheckChange }) {
	return (
		<li className={`rk-row rk-${c.kind}`}>
			<a className="xw-name" href={repoUrl(c.fullName)} target="_blank" rel="noreferrer">
				{c.fullName}
			</a>
			<span className={`rk-kind rk-kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
			{c.kind === "license" && c.license && (
				<span className="xw-delta">
					{lic(c.license.from)} → {lic(c.license.to)}
				</span>
			)}
			{c.kind === "gone" && (
				<span className="rk-why">GitHub 上已经打不开(404 / 410 / 451):删库、改名,或者被下架。</span>
			)}
			{c.stillListed ? (
				<span className="rk-listed">还在这一周的清单上</span>
			) : (
				<span className="rk-dropped">已掉出这一周的清单</span>
			)}
		</li>
	);
}

/**
 * 复查那一整节。**只有 `counts.recheckChecked > 0` 才允许调用它**
 * (调用方 ChangesView 直接不渲染这一节),理由见文件顶部规矩 2。
 *
 * 三栏分得开,是因为它们是三件不同的事:
 *   - 出事了:复查真的问到了 GitHub,而且答案不好看;
 *   - 没查成:**我们不知道它怎么样**。这不是坏消息,是「没有消息」;
 *   - 查过没事:问到了,一切照旧。
 *
 * 第三栏的名单**直接用后端给的 `recheck.unchanged`**,不再自己算。
 *
 * 上一轮这里做的是 `resolved` 减去 `changes` 里的名字:`resolved` 的定义是「复查
 * 真的给出了答案(ok **或** gone)的仓名」(scan-diff.ts),它**包含**刚被删库的
 * 那几个,照字面渲染就会把一个死掉的仓印在「没事」那一栏 —— 正是这一屏最想避免的
 * 那种错。减法是对的,但它是**每个下游都得自己想起来做一次**的减法,而将来的邮件
 * 模板想不起来的那一次不会报错(2026-09-01 冻结前最后一轮把它收回了后端)。
 *
 * `resolved` 保留着,它有自己的语义(复查给出了答案的),只是**不该被读成「没事」**。
 */
export function RecheckPanel({ counts, recheck }: { counts: WeeklyChangeCounts; recheck: RecheckReport }) {
	const fine = recheck.unchanged;
	return (
		<>
			<p className="rk-lead">
				上一次清单上有 <N v={counts.recheckChecked} /> 个仓,这一趟逐个去 GitHub 问了一遍:
				<N v={counts.recheckChanged} /> 个有变化,<N v={counts.recheckUnchecked} /> 个没查成。
			</p>
			<RecheckCheck counts={counts} recheck={recheck} />
			<p className="dsec-why">
				为什么要单独去问一遍:一个仓<strong>一旦归档或者被删,它就会被规则层筛掉</strong>,于是它压根不会出现在本周的
				候选清单上 —— 而上面那四格比的是「上一次的清单 vs 这一周的清单」,两边都在才比得成。也就是说那四格
				<strong>天生看不见「上周那个仓这周死了」</strong>。这一节就是补这个洞的。
			</p>

			<div className="rk-cols">
				<div className="rk-col rk-col-changed">
					<h4 className="rk-h">出事了 · {recheck.changes.length} 条</h4>
					<p className="rk-note">问到了 GitHub,答案不好看。</p>
					{recheck.changes.length === 0 ? (
						<p className="empty-note">这一栏是空的 —— 问到的那些仓一个都没出事。</p>
					) : (
						<ul className="rk-list">
							{recheck.changes.map((c) => (
								<RecheckChangeRow key={`${c.fullName}#${c.kind}`} c={c} />
							))}
						</ul>
					)}
				</div>

				<div className="rk-col rk-col-unchecked">
					<h4 className="rk-h">没查成 · {recheck.unavailable.length} 个</h4>
					<p className="rk-note">
						这一次没问到 GitHub(5xx / 被限流 / 这一趟的预算到了)。
						<strong>这不代表它们有什么问题</strong> —— 只代表我们这一趟不知道它们怎么样,它们照旧在上一次的清单上。
						下一周会重新问一遍。
					</p>
					{recheck.unavailable.length === 0 ? (
						<p className="empty-note">这一栏是空的 —— 该问的都问到了。</p>
					) : (
						<ul className="rk-list">
							{recheck.unavailable.map((u) => (
								<li key={u.fullName} className="rk-row rk-unchecked">
									<a className="xw-name" href={repoUrl(u.fullName)} target="_blank" rel="noreferrer">
										{u.fullName}
									</a>
									<span className="rk-why">没问到的原因:{u.why}</span>
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="rk-col rk-col-fine">
					<h4 className="rk-h">查过,没事 · {fine.length} 个</h4>
					<p className="rk-note">问到了,和上一次比没有变化。</p>
					{fine.length === 0 ? (
						<p className="empty-note">这一栏是空的。</p>
					) : (
						<ul className="rk-list rk-list-quiet">
							{fine.map((name) => (
								<li key={name} className="rk-row">
									<a className="xw-name" href={repoUrl(name)} target="_blank" rel="noreferrer">
										{name}
									</a>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// 整屏
// ---------------------------------------------------------------------------

export interface ChangesViewProps {
	/** 这一周的跨周记录。null = **没有记录**(不是「没有变化」)。 */
	change: WeeklyChange | null;
	/** 在看哪一周;null = 最近一周。 */
	picked: string | null;
	/** 翻周那一列的数据(GET /api/scan/history)。 */
	scans: readonly WeeklyScan[];
	onPick: ((weekOf: string) => void) | null;
	/** 那一周的整包清单(GET /api/scan?weekOf=)。还没取到就是 null。 */
	weekScan: GetScanResponse | null;
	/**
	 * 正在换一周 —— 也就是说**手上这份 change / weekScan 不属于 `picked` 那一周**。
	 *
	 * 这个标志必须传进来,不能只在外面画个骨架屏:内容区照常渲染的话,页面会在
	 * 头上写着 W35、底下摆着 W36 的结论,而两边都是真数据,没有一处会报错。
	 * 翻周那一列仍然照画(挑周的人要看得见自己挑了哪一周),只是这期间点不动。
	 */
	busy?: boolean;
}

/**
 * 节的编号是**按真正渲染出来的节现算的**,不是写死 01/02/03/04。
 *
 * 因为复查那一节会整节消失(recheckChecked === 0 时一个字都不许提),写死编号
 * 的话页面上会出现「01、02、04」这种缺号 —— 缺号本身在这个产品里是个信号
 * (读者会去找那个不见了的 03),而这里它什么都不代表。
 */
function Sections({ items }: { items: { title: string; count?: string; body: ReactNode }[] }) {
	return (
		<>
			{items.map((s, i) => (
				<section key={s.title} className={`dsec rise rise-${Math.min(i + 1, 4)}`}>
					<div className="dsec-head">
						<span className="dsec-no">{String(i + 1).padStart(2, "0")}</span>
						<h2>{s.title}</h2>
						{s.count && <span className="dsec-count">{s.count}</span>}
					</div>
					{s.body}
				</section>
			))}
		</>
	);
}

export default function ChangesView({ change, picked, scans, onPick, weekScan, busy = false }: ChangesViewProps) {
	const showRecheck = !busy && change !== null && change.counts.recheckChecked > 0;
	// 正在换周时,「这一周是哪一周」只能听 picked 的 —— change 里那个 weekOf 说的
	// 是**上一份**(还没被换掉的那一份)
	const weekOf = busy ? (picked ?? null) : (change?.weekOf ?? picked ?? scans[0]?.weekOf ?? null);

	const items: { title: string; count?: string; body: ReactNode }[] = [
		{
			title: "翻周",
			count: scans.length > 0 ? `最近 ${scans.length} 周` : undefined,
			body: (
				<>
					<p className="dsec-why">
						<strong>这一屏是这个产品相对一个本地脚本的唯一存在理由。</strong>
						一次性的扫描每次都从头跑,没有「上一周」这个概念;这里存着的是<strong>你每一周看到过的那一份清单</strong>,
						所以才比得出「这周和上次比变了什么」。挑一周看它当时的结论和当时的清单。
					</p>
					<WeekPicker scans={scans} picked={picked} onPick={busy ? null : onPick} />
				</>
			),
		},
		{
			title: "与上一次比",
			count: weekOf ?? undefined,
			body: busy ? (
				// **不能在这儿画 NoChangeRecord**:「还没读到」和「这一周没有跨周记录」
				// 是两句完全不同的话,而它们的区别正是这一屏最要紧的那条规矩
				<p className="empty-note">正在读 {weekOf ?? "这一周"} 的跨周记录…</p>
			) : change === null ? (
				<NoChangeRecord weekOf={weekOf} />
			) : (
				<CrossWeek change={change} />
			),
		},
	];

	// **复查那一节:recheckChecked === 0 时整节不出现,连标题都没有。**
	// 渲染一个「复查 · 0 个」的空节等于把「这一周没做复查」说成「做了,没发现」
	// —— 后端的邮件模板里守的是同一条规矩(types.ts WeeklyChangeCounts)。
	if (showRecheck) {
		items.push({
			title: "复查上一次清单上的仓",
			count: `${change.counts.recheckChecked} 个`,
			body: <RecheckPanel counts={change.counts} recheck={change.diff.recheck} />,
		});
	}

	items.push({
		title: "那一周的清单",
		count: !busy && weekScan?.scan ? `${weekScan.candidates.length} 行候选` : undefined,
		body: busy ? (
			<p className="empty-note">正在读 {weekOf ?? "这一周"} 的清单…</p>
		) : (
			<WeekBundle weekScan={weekScan} weekOf={weekOf} />
		),
	});

	return <Sections items={items} />;
}

/**
 * 选中那一周的整包清单,折叠着。
 *
 * 用的是**本周清单那一屏的同一个组件**(ScanView),而且一个数都没改口径 ——
 * 「翻上一周」翻到的必须是当时那一屏原样的东西,重画一份精简版的话,两份迟早
 * 会在某个字段上不一致,而不一致的那一天没有人会发现。
 *
 * 申诉和「拆开看看」两个入口在这里**都不给**:申诉是往**这一周**的清单里塞东西
 * (后端按 weekOf 写),在一屏历史上摆一个会写另一周的按钮是个陷阱;而深度报告
 * 只拆「你自己那一周清单上的仓」,入口留在本周清单那一屏就够了,两处入口只会让
 * 「我这一天的两份额度花到哪去了」更难查。
 */
export function WeekBundle({ weekScan, weekOf }: { weekScan: GetScanResponse | null; weekOf: string | null }) {
	if (!weekScan?.scan || !weekScan.honesty) {
		return (
			<p className="empty-note">
				{weekOf ? `${weekOf} ` : "这一周"}没有存下来的清单。删过档案的话,它名下全部历史周扫会跟着一起删掉。
			</p>
		);
	}
	return (
		<details className="week-bundle">
			<summary className="week-bundle-head">
				展开 {weekScan.scan.weekOf} 当时的完整清单(候选 {weekScan.candidates.length} 行 / 排除{" "}
				{weekScan.scan.excluded} 条 / 检索台账)
			</summary>
			<p className="dsec-why">
				下面是<strong>那一周原样的三块</strong>,和你当时在「本周清单」上看到的是同一个组件、同一份台账。
				这里不给「这个该进来」和「拆开看看」两个按钮 —— 申诉写的是某一周的清单,深度报告花的是当天的额度,
				两件事的入口都该留在本周清单那一屏,不该在一屏历史上再开一个。
			</p>
			<ScanView
				scan={weekScan.scan}
				candidates={weekScan.candidates}
				exclusions={weekScan.exclusions}
				honesty={weekScan.honesty}
				extras={{}}
				appeal={{ onAppeal: null, pending: null }}
			/>
		</details>
	);
}
