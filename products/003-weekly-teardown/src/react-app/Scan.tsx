// 第一屏:本周清单(阶段 5)。
//
// **三块并列,不是「主内容 + 折叠的调试信息」**(docs/01 决策 4 的原话:
// 排除清单和检索台账「不是附加项,是产品本身」)。所以:
//
//   诚实声明   页面顶部,第一屏可见,**没有折叠开关**
//   01 候选清单  ≤5 行(申诉捞回的会让它超过 5,那时页面自己说清楚)
//   02 排除清单  293-386 行的现实。**不靠少显示解决,只靠分组 + 计数 + 折叠**
//   03 检索台账  检索词原文、每条词每一路的实况、配额档、提前收工的原因
//
// 这个文件**只渲染,不发请求**(同 Dossier.tsx 与 App.tsx 的分工)。除了几处
// `<details>` 的开合(交给浏览器,不进 React 状态),这里的组件全是纯函数——
// 这不只是洁癖:render.test.ts / scan-render.test.ts 那一层靠「直接把组件当函数
// 调 + react-dom/server 渲染成 HTML」来断言,组件一旦带上 hook 就测不动了。
// 阶段 3 栽过的那次(纯函数算出了理由,但没有任何一层把它送到屏幕上)就是
// 这一层要接住的东西。
//
// **本文件一个数都不算。**页面上出现的每一个数字要么来自 `ScanHonesty`
// (后端算的),要么来自 `WeeklyScan`(后端算的),要么是 `groupExclusions`
// 数出来的**分组条数**——最后这一类是「这一组里我真的渲染了几条」,不是
// 「我猜这一组该有几条」,它和台账的 excluded 相等这件事有测试钉着。

import type { ReactNode } from "react";

import { NEAR_MISS_SHOWN, defaultOpen, groupExclusions, rankedOutRank } from "../shared/scan-groups.ts";
import type { ExclusionGroup } from "../shared/scan-groups.ts";
import { SCAN_PICK_LIMIT, WEEKLY_SCAN_SCHEDULE } from "../shared/types.ts";
import type {
	RunScanResponse,
	ScanCandidate,
	ScanExclusion,
	ScanHonesty,
	SourceRoute,
	WeeklyScan,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/** 台账/声明里的数字统一包一层,既是排版也是**测试抓手**(class="hn" 好断言)。 */
function N({ v }: { v: number }) {
	return <b className="hn">{v}</b>;
}

const repoUrl = (fullName: string) => `https://github.com/${fullName}`;

/** ISO 时间戳 → YYYY-MM-DD。GitHub 给什么显示什么,解析不动就原样回显。 */
function ymd(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	return new Date(t).toISOString().slice(0, 10);
}

const ROUTE_LABEL: Record<SourceRoute, { text: string; title: string; hot?: boolean }> = {
	stars: { text: "star 路", title: "按 star 排序那一路捞到的 —— 这类你自己搜也搜得到" },
	updated: {
		text: "updated 路 · 新冒出来的",
		title: "只有「按最近更新排序」那一路捞到它。按 star 排序永远排不进前 30 —— 这是你手工搜索找不到的那一类",
		hot: true,
	},
	both: { text: "两路都有", title: "按 star 和按最近更新两路都捞到了它" },
	appealed: { text: "你捞回来的", title: "不是搜出来的:你在排除清单里点了「这个该进来」" },
};

// ---------------------------------------------------------------------------
// 诚实声明(docs/02「诚实声明的措辞」· docs/01 风险 1 的缓解 2)
// ---------------------------------------------------------------------------

/**
 * 页面顶部那句话。**不可折叠,不可关闭。**
 *
 * 每一个数都直接取自 `honesty`,**这一段里没有一处算术**。types.ts 的
 * ScanHonesty docblock 把理由写死了:前端一旦拿 `candidates.length` 之类的
 * 东西凑分子分母,它就会在某次改版里和台账分叉,而分叉之后这句话还是这么
 * 理直气壮地摆在页面顶部。scan-render.test.ts 里有一条用例故意喂进
 * 「honesty 说 5、candidates 只有 2 行」的输入,断言这里印的是 5。
 *
 * 两处降级,都是为了不撒谎:
 * - `claimedTotal === 0`:历史那一路(GET /api/scan)没有 trace,当周 GitHub
 *   声称的总数没留档。这时说「有 0 个」是假话,所以退回一句不带数字的话。
 * - `fetchFailed > 0`:那句话字面上是「拿回 M、筛掉 K、剩下 N」,而这三个数
 *   只有在 fetchFailed 为 0 时才加得起来。不说的话读者会以为我们算错了,
 *   而真相是有几个仓抓不通、我们不敢显示。
 */
export function HonestyStatement({ honesty }: { honesty: ScanHonesty }) {
	return (
		<section className="honesty" aria-label="诚实声明">
			<p className="honesty-lead">
				{honesty.claimedTotal > 0 ? (
					<>
						GitHub 说和这个领域相关的仓有 <N v={honesty.claimedTotal} /> 个(它自己报的匹配总数)。
					</>
				) : (
					<>GitHub 上和这个领域相关的仓可能有上万个(这一周没留下 GitHub 声称的总数,所以这里不给数字)。</>
				)}{" "}
				搜索接口每条查询最多只肯返回 <N v={honesty.searchCap} /> 个,我用 <N v={honesty.queryCount} /> 条查询、
				<N v={honesty.routeCount} /> 种排序去取,实际拿回 <N v={honesty.returned} /> 个,按规则筛掉{" "}
				<N v={honesty.excluded} /> 个,剩下 <N v={honesty.admitted} /> 个在这里。
				{honesty.fetchFailed > 0 && (
					<>
						{" "}
						另有 <N v={honesty.fetchFailed} /> 个抓不通(仓删了 / 改名了 / 被下架了),不显示也不计入上面两个数。
					</>
				)}
			</p>
			<p className="honesty-hard">
				这不是这个领域的全部,也不保证是最好的 {SCAN_PICK_LIMIT} 个。
			</p>
			<p className="honesty-out">下面第 03 节的检索词你可以改,改完回档案页保存,再重跑一次。</p>
		</section>
	);
}

/**
 * 台账等式自检:`returned = admitted + excluded + fetchFailed`。
 *
 * 站长 2026-09-01 拍板这条必须成立。后端在 runWeeklyScan 里对不上时会
 * console.error,但那行日志没有人看;这个产品自己的标准是「错要响」,所以
 * 页面上也当场说破。正常情况下这一段什么都不渲染。
 */
export function LedgerCheck({ scan }: { scan: WeeklyScan }) {
	const sum = scan.admitted + scan.excluded + scan.fetchFailed;
	if (sum === scan.returned) return null;
	return (
		<p className="scan-alarm" role="alert">
			<strong>这一周的台账对不上。</strong>拿回 {scan.returned} 个,但进清单 {scan.admitted} + 排除 {scan.excluded} +
			抓失败 {scan.fetchFailed} = {sum}。上面那句诚实声明因此是不可信的 —— 请把这一周重跑一次。
		</p>
	);
}

// ---------------------------------------------------------------------------
// 01 候选清单
// ---------------------------------------------------------------------------

/**
 * 「拆开看看」那个入口(阶段 7)。
 *
 * **这是全站唯一一个花大钱的按钮**,所以它旁边必须写着代价:一趟 1-2 分钟、
 * 按上限估 $0.4-0.6、每个账号每天 2 份。不写的话,读者会拿它当「展开详情」点
 * ——那是一天两次机会里的一次,而且没有撤销。
 */
export interface TeardownHandlers {
	/** 点「拆开看看」。null = 这一屏不给拆(比如正在跑周扫,清单马上要被换掉)。 */
	onTeardown: ((fullName: string) => void) | null;
	/** 正在跑的那个仓名。一人同时只许一趟(后端 409 也这么判)。 */
	pending: string | null;
}

const NO_TEARDOWN: TeardownHandlers = { onTeardown: null, pending: null };

/**
 * 一行候选。
 *
 * 三处降级都是必须的,因为它们的「空」都有具体含义:
 * - `license === null` → 「没有许可证」。留白的话读者会读成「我没查」,而
 *   真相是「查了,GitHub 说没有」——那还是一条硬排除理由(它能出现在候选行上
 *   只有一种可能:你申诉把它捞回来了)。
 * - `oneLiner === null` → 那次模型调用失败了。空着的话这一行看起来像「这个仓
 *   没什么可说的」,而事实是我们没问出来。
 * - `archived` → 归档徽章。它在候选清单里同样只可能来自申诉。
 *
 * `oneLiner` 旁边永远标着「模型写的描述」:这个产品全篇在区分「代码算的」和
 * 「模型说的」,而这一行是整块清单里**唯一**一处模型产出。
 */
export function CandidateRow({ c, teardown = NO_TEARDOWN }: { c: ScanCandidate; teardown?: TeardownHandlers }) {
	const route = ROUTE_LABEL[c.sourceRoute] ?? ROUTE_LABEL.stars;
	const running = teardown.pending === c.fullName;
	const locked = teardown.pending !== null;
	// 「你捞回来的」那句话的来源:后端 join 好的当初排除理由(store.ts
	// getWeeklyScan)。这一层不自己去排除清单里找 —— 找得到与否取决于调用方
	// 传没传排除清单,而门铃邮件不会传。
	const appealedReason = c.appealedFrom;
	return (
		<li className={`cand${appealedReason ? " cand-appealed" : ""}`}>
			<div className="cand-top">
				<span className="cand-rank">{c.rank}</span>
				<a className="cand-name" href={repoUrl(c.fullName)} target="_blank" rel="noreferrer">
					{c.fullName}
				</a>
				<span className="cand-stars" title="GitHub 的 stargazers_count">
					★{c.stars}
				</span>
				<span className={`route-chip${route.hot ? " route-hot" : ""}`} title={route.title}>
					{route.text}
				</span>
				{teardown.onTeardown && (
					<button
						type="button"
						className="cand-teardown"
						disabled={locked}
						title="跑一份带逐字引文和永久回链的深度报告:1-2 分钟,按上限估 $0.4-0.6,每个账号每天 2 份"
						onClick={() => teardown.onTeardown?.(c.fullName)}
					>
						{running ? "拆解中…" : "拆开看看"}
					</button>
				)}
			</div>
			<div className="cand-facts">
				{c.archived && (
					<span className="fact fact-warn" title="archived === true,作者自己按的">
						已归档
					</span>
				)}
				<span className={`fact${c.license === null ? " fact-warn" : ""}`}>
					{c.license === null ? "没有许可证" : c.license}
				</span>
				<span className="fact">最后 push {ymd(c.pushedAt)}</span>
				<span className="fact fact-quiet">建于 {ymd(c.repoCreatedAt)}</span>
			</div>
			{c.oneLiner ? (
				<p className="cand-liner">
					<span className="by-model" title="这一行是模型写的形态描述,不是判断,也不决定谁进清单">
						模型写的描述
					</span>
					{c.oneLiner}
				</p>
			) : (
				<p className="cand-liner cand-liner-missing">
					<span className="by-model by-model-off">没拿到描述</span>
					那次模型调用没成功,所以这一行没有形态描述。<strong>清单本身不受影响</strong> —— 谁进清单是代码判的。
				</p>
			)}
			{appealedReason && (
				<p className="cand-appeal-note">
					你捞回来的。它原本被排除,理由是「{appealedReason}」——这条理由仍然成立,只是你决定要看它。
				</p>
			)}
		</li>
	);
}

export function CandidateList({
	candidates,
	teardown = NO_TEARDOWN,
}: {
	candidates: readonly ScanCandidate[];
	teardown?: TeardownHandlers;
}) {
	if (candidates.length === 0) {
		return (
			<p className="empty-note">
				这一周一个候选都没有。不是页面坏了 —— 要么检索词一个仓都没捞回来,要么捞回来的全被规则筛掉了。
				下面第 02、03 节能看出是哪一种。
			</p>
		);
	}
	const extra = candidates.length - SCAN_PICK_LIMIT;
	return (
		<>
			{teardown.onTeardown && (
				<p className="teardown-cost">
					每一行右边的<strong>「拆开看看」</strong>会跑一份深度报告:抓 GitHub 字段、README、releases、文件树、
					当年 HN 上的讨论和 ≤5 份源码正文,再逐字锚定每一条引文。
					<strong> 一趟 1-2 分钟,按上限估 $0.4-0.6,每个账号每天 2 份</strong> —— 这不是「展开详情」,点之前先挑清楚。
					同一个 commit 拆过第二次不重跑也不扣额度 —— <strong>除非你中间改过档案</strong>:
					报告里每条判断标的「你在意的第 N 条」指的就是那一版档案,档案变了,同一个仓值得按新的
					「我在意什么」重跑一遍,那是新的一份,<strong>要再扣一份额度</strong>。
				</p>
			)}
			<ul className="cand-list">
				{candidates.map((c) => (
					<CandidateRow key={c.fullName} c={c} teardown={teardown} />
				))}
			</ul>
			{extra > 0 && (
				<p className="dsec-why">
					这里有 {candidates.length} 行而不是 {SCAN_PICK_LIMIT} 行:多出来的 {extra} 个是你从排除清单里捞回来的。
					台账的「进清单」跟着 +{extra}、「排除」跟着 -{extra},<strong>三个数仍然加得起来</strong>。
				</p>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// 02 排除清单
// ---------------------------------------------------------------------------

export interface AppealHandlers {
	/** 点「这个该进来」。null = 这一屏不给申诉(比如还在跑)。 */
	onAppeal: ((fullName: string) => void) | null;
	/** 正在申诉中的那个仓名。 */
	pending: string | null;
}

/**
 * 一条排除。理由**原样显示**——它是这一条能不能被核对的全部依据。
 *
 * 唯一的例外是「排名之外」那 153 条:它们的理由是同一句话套不同的名次,
 * 逐条铺开 153 遍等于用噪音淹掉信息。所以那一组把名次提到行首当 `#7`,
 * 正文换成短句,**完整原文挂在 title 上**(鼠标一停就看得到)——是换了个
 * 摆法,不是把它藏起来。
 */
export function ExclusionRow({
	e,
	appeal,
	showRank,
}: {
	e: ScanExclusion;
	appeal: AppealHandlers;
	/** 「排名之外」那一组:把名次单独提出来当行首,比塞在长句里好读得多。 */
	showRank?: boolean;
}) {
	const rank = showRank ? rankedOutRank(e.reason) : null;
	// 一次只许一条申诉在飞(它要动台账的两个计数)。所以**所有**按钮一起禁用,
	// 只有在飞的那一条换文案 —— 别的行留着一个能点、点了却静默无事的按钮,
	// 就是阶段 3 那个洞换了个地方长出来。
	const busy = appeal.pending === e.fullName;
	const locked = appeal.pending !== null;
	return (
		<li className="excl">
			{rank !== null && <span className="excl-rank">#{rank}</span>}
			<a className="excl-name" href={repoUrl(e.fullName)} target="_blank" rel="noreferrer">
				{e.fullName}
			</a>
			<span className="excl-reason" title={e.reason}>
				{showRank && rank !== null ? "通过了全部规则,只是名次排在前 5 之外" : e.reason}
			</span>
			{appeal.onAppeal && (
				<button
					type="button"
					className="excl-appeal"
					disabled={locked}
					title="强制把它放进这一周的候选清单。只重跑这一个仓,不重跑整周的搜索"
					onClick={() => appeal.onAppeal?.(e.fullName)}
				>
					{busy ? "捞回中…" : "这个该进来"}
				</button>
			)}
		</li>
	);
}

/**
 * 一个分组。**分组头上的数字是真实条数**,不是「显示了几条」——折叠起来的
 * 那 117 条仍然在库里、仍然算在台账的 excluded 里,分组头是读者验这件事的
 * 唯一入口。所以 count 直接来自 group.count(= items.length),不许写成
 * 「显示前 N 条」之类的东西。
 */
export function ExclusionGroupBlock({ group, appeal }: { group: ExclusionGroup; appeal: AppealHandlers }) {
	const ranked = group.key === "ranked-out";
	return (
		<details className={`excl-group src-${group.source}`} open={defaultOpen(group)}>
			<summary className="excl-head">
				<span className={`src-chip src-chip-${group.source}`}>{group.source === "rule" ? "代码算的" : "模型判的"}</span>
				<span className="excl-label">{group.label}</span>
				<span className="excl-count">{group.count} 条</span>
			</summary>
			<p className="excl-note">{group.note}</p>
			{group.count === 0 ? (
				<p className="empty-note">
					这一周一条都没有。<strong>这是好消息</strong>:上面那些排除全部是代码从 GitHub 字段算出来的,
					你点开每个仓就能自己核对。
				</p>
			) : (
				<ul className="excl-list">
					{group.items.map((e) => (
						<ExclusionRow key={e.fullName} e={e} appeal={appeal} showRank={ranked} />
					))}
				</ul>
			)}
		</details>
	);
}

/** 一整块(资格 / 判断 / 名次)。三块在版面上必须一眼分得开。 */
function ExclusionBlockBox({
	tone,
	title,
	lead,
	children,
}: {
	tone: "rule" | "model" | "rank";
	title: string;
	lead: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className={`excl-block blk-${tone}`}>
			<h3 className="excl-block-title">{title}</h3>
			<p className="excl-block-lead">{lead}</p>
			{children}
		</div>
	);
}

/**
 * 排除清单整块。**386 行的现实靠信息设计消化,不靠少显示**(站长拍板保等式:
 * `returned = admitted + excluded + fetchFailed`,所以每一条都在库里,少显示
 * 就是让分母有据、分子无据)。
 *
 * 三块的分法不是排版偏好:
 *   - 资格问题:代码从 GitHub 字段直接算的,读者拿仓库页面能当场核对;
 *   - 模型判的:读者核不了,只能自己判断信不信。**空的时候也留一行**,
 *     因为「这一周一条模型判的排除都没有」本身就是要说出来的事实;
 *   - 名次问题:这些仓一点毛病都没有,只是这周排在 5 名之外。它和上面两块
 *     的信息量根本不同——前两块是「我不该看它」,这一块是「我这周没看到它」,
 *     而这一块才是最值得申诉的那一批。所以它独占一块,并且把最靠前的几个
 *     常驻在外面(整组 153 条仍然折叠着,一条不少)。
 */
export function ExclusionList({
	exclusions,
	appeal,
	excluded,
}: {
	exclusions: readonly ScanExclusion[];
	appeal: AppealHandlers;
	/** 台账里的 excluded。用来当场验「分组条数加起来 = 台账说的那个数」。 */
	excluded: number;
}) {
	const { groups, appealed, total } = groupExclusions(exclusions);
	const rank = groups.find((g) => g.key === "ranked-out") ?? null;
	const nearMiss = rank ? rank.items.slice(0, NEAR_MISS_SHOWN) : [];
	const eligibility = groups.filter((g) => g.block === "eligibility");
	const judgement = groups.filter((g) => g.block === "judgement");

	return (
		<>
			<p className="excl-sum">
				这一周排除了 <N v={total} /> 个仓,<strong>每一个都在下面</strong>,分组折叠但一条不少。
				{total !== excluded && (
					<span className="scan-alarm" role="alert">
						{" "}
						台账说排除了 {excluded} 个,和这里数出来的 {total} 条对不上。
					</span>
				)}
			</p>

			<ExclusionBlockBox
				tone="rule"
				title="资格问题 · 代码算的"
				lead={
					<>
						判据全部来自 <code>GET /repos/&#123;owner&#125;/&#123;repo&#125;</code> 的原始字段,
						<strong>模型一个字都没参与</strong>。每一条你都能点开仓库自己核。
					</>
				}
			>
				{eligibility.map((g) => (
					<ExclusionGroupBlock key={g.key} group={g} appeal={appeal} />
				))}
			</ExclusionBlockBox>

			<ExclusionBlockBox
				tone="model"
				title="判断 · 模型判的"
				lead={
					<>
						这一块和上面那块<strong>颜色不一样是有原因的</strong>:上面的你能核,这里的你核不了,只能自己判断信不信。
					</>
				}
			>
				{judgement.map((g) => (
					<ExclusionGroupBlock key={g.key} group={g} appeal={appeal} />
				))}
			</ExclusionBlockBox>

			{rank && (
				<ExclusionBlockBox
					tone="rank"
					title="名次问题 · 一点毛病都没有"
					lead={
						<>
							这 {rank.count} 个仓<strong>通过了全部规则</strong>,只是这周排在前 {SCAN_PICK_LIMIT} 之外。
							它们和上面两块的性质完全不同——上面是「不该看」,这里是「这周没看到」。
							<strong>最值得申诉的就是这一批。</strong>
						</>
					}
				>
					{nearMiss.length > 0 && (
						<div className="near-miss">
							<h4>差一点进清单的</h4>
							<ul className="excl-list">
								{nearMiss.map((e) => (
									<ExclusionRow key={e.fullName} e={e} appeal={appeal} showRank />
								))}
							</ul>
						</div>
					)}
					<ExclusionGroupBlock group={rank} appeal={appeal} />
				</ExclusionBlockBox>
			)}

			{appealed.length > 0 && (
				<ExclusionBlockBox
					tone="rank"
					title={`你捞回来的 · ${appealed.length} 个`}
					lead={
						<>
							这些已经搬进上面的候选清单了,所以<strong>不再计入排除数</strong>(台账的「进清单」+
							{appealed.length}、「排除」-{appealed.length},三个数仍然加得起来)。
							排除行本身留着,因为「当初为什么被筛掉」正是这个动作最该留下的痕迹。
						</>
					}
				>
					<ul className="excl-list">
						{appealed.map((e) => (
							<li key={e.fullName} className="excl excl-done">
								<span className="excl-rank">✓</span>
								<a className="excl-name" href={repoUrl(e.fullName)} target="_blank" rel="noreferrer">
									{e.fullName}
								</a>
								<span className="excl-reason">当初的理由:{e.reason}</span>
							</li>
						))}
					</ul>
				</ExclusionBlockBox>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// 03 检索台账
// ---------------------------------------------------------------------------

/**
 * 一次跑完才知道的那些(GET 回来的历史没有)。
 *
 * **stopped 不在这里**(2026-09-01 阶段 4/5 评审):提前收工的原因现在是台账的
 * 一列(`WeeklyScan.stopped`),落了库。留在 extras 里的后果是刷新一次警示就
 * 没了,而清单还是残的 —— 页面于是把一份残缺扫描渲染成正常结果,而顶上还挂着
 * 一句理直气壮的诚实声明。
 */
export interface RunExtras {
	trace?: RunScanResponse["trace"];
	rate?: RunScanResponse["rate"];
}

/**
 * 提前收工的警示。**必须显著,不能藏在台账里。**
 *
 * `stopped` 非空意味着这一周的清单是**残缺的**:有几条检索词根本没发出去。
 * 而残的清单和全的清单长得一模一样(docs/01 风险 1「错得很安静」),不提示
 * 就是我们自己在犯那个错——页面顶部还挂着一句理直气壮的诚实声明。
 */
export function StoppedNotice({ stopped }: { stopped?: string | null }) {
	if (!stopped) return null;
	return (
		<p className="scan-alarm" role="alert">
			<strong>这一周没跑完:{stopped}</strong>
			<br />
			也就是说档案里的检索词有一部分**根本没跑通**,这份清单是残的。顶上那句诚实声明里的「我用 N 条查询」
			说的是真的拿回了结果的条数,不是档案里写了几条 —— 两者不一样时,差额就是这里少掉的。
			配额恢复后重跑一次,或者给实例配上 GITHUB_PAT(匿名档 10 次/分钟,双路 16 次必然要等)。
		</p>
	);
}

/** 配额档。露出来是为了让「这周只捞回 12 个」有个能查的解释,而不是让人以为发现层坏了。 */
export function RateLine({ rate }: { rate: NonNullable<RunExtras["rate"]> }) {
	return (
		<p className="rate-line">
			<span className={`fact${rate.authenticated ? "" : " fact-warn"}`}>
				{rate.authenticated ? "PAT 档 · search 30 次/分钟" : "匿名档 · search 10 次/分钟"}
			</span>
			<span className="fact">search 打了 {rate.searchCalls} 次</span>
			<span className="fact">REST 打了 {rate.coreCalls} 次</span>
			{rate.searchRemaining !== null && <span className="fact fact-quiet">search 余额 {rate.searchRemaining}</span>}
			{rate.coreRemaining !== null && <span className="fact fact-quiet">REST 余额 {rate.coreRemaining}</span>}
			<span className={`fact${rate.waitedMs > 10_000 ? " fact-warn" : " fact-quiet"}`}>
				为等额度停了 {Math.round(rate.waitedMs / 1000)} 秒
			</span>
		</p>
	);
}

/**
 * 检索台账。四个数**直接来自 `WeeklyScan`**(后端算的),检索词原文来自
 * `scan.queries`(当周真的跑通的那一份,不是档案里现在的那一份 —— 档案改过
 * 之后两者会不一样,而这一屏说的是那一周发生了什么)。
 *
 * 检索词必须原文可见:docs/01 决策 3 说它「是查全的唯一补救手段,本身也是
 * 问责区的一部分——你看得见我拿什么词去搜的」。
 */
export function Ledger({ scan, extras }: { scan: WeeklyScan; extras: RunExtras }) {
	const trace = extras.trace ?? [];
	return (
		<>
			<p className="ledger-line">
				跑通 <N v={scan.queries.length} /> 条查询(原文见下)· 返回 <N v={scan.returned} /> 个仓 · 进清单{" "}
				<N v={scan.admitted} /> · 排除 <N v={scan.excluded} /> · 抓失败 <N v={scan.fetchFailed} />
			</p>
			<LedgerCheck scan={scan} />
			<StoppedNotice stopped={scan.stopped} />

			<h4 className="ledger-h">这一周真的跑通的检索词</h4>
			<ol className="query-list">
				{scan.queries.map((q, i) => (
					<li key={`${q}-${i}`}>
						<code>{q}</code>
					</li>
				))}
			</ol>
			<p className="dsec-why">
				这是<strong>那一周发出去的</strong>那一份。你后来改过档案的话,这里和档案页显示的不一样是对的 ——
				这一屏说的是那一周发生了什么。
			</p>

			{trace.length > 0 ? (
				<>
					<h4 className="ledger-h">每条词、每一路,分别捞回几个</h4>
					<div className="trace-wrap">
						<table className="trace">
							<thead>
								<tr>
									<th>检索词</th>
									<th>排序</th>
									<th>捞回</th>
									<th>GitHub 声称有</th>
									<th>出错没有</th>
								</tr>
							</thead>
							<tbody>
								{trace.map((t, i) => (
									<tr key={`${t.query}-${t.sort}-${i}`} className={t.error ? "trace-bad" : undefined}>
										<td>
											<code>{t.query}</code>
										</td>
										<td>{t.sort === "updated" ? "最近更新" : "star"}</td>
										<td>{t.returned}</td>
										<td>{t.totalCount}</td>
										<td>{t.error ? t.error : "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			) : (
				<p className="dsec-why">
					这一周的逐路实况没有留档(只有「刚跑完」那一次才知道每条词各捞回几个,历史读取拿不到)。
					台账那四个数是落了库的,上面那一行就是它们。
				</p>
			)}

			{extras.rate && (
				<>
					<h4 className="ledger-h">这一趟的配额</h4>
					<RateLine rate={extras.rate} />
					<p className="dsec-why">
						露出配额档是为了让「这周只捞回 12 个」有个能查的解释,而不是让人以为发现层坏了。
						GitHub 的 search 桶是<strong>整个实例共享</strong>的,不是按用户分的。
					</p>
				</>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// 重跑这一周:确认框与回执(2026-09-01 上线前终审 A2)
// ---------------------------------------------------------------------------

/**
 * 「现在重跑这一周」的二次确认。**在这之前它是一颗点下去就走的裸按钮。**
 *
 * 终审把后果说得很具体:`putWeeklyScan` 第一件事就是按 `scan_id` 删光这一周的
 * 候选和排除,而 `scan_id` 是 (档案, 周) 算出来的,同一周必然撞上。用户申诉过
 * 3 个仓(每个花掉一次 `ai` 额度 + 一次 GitHub 调用),点一下重跑,「你捞回来的」
 * 那一节连同 3 行候选一起消失 —— **而台账是重新算的,所以四个数照样自洽,
 * 没有一处会报错,页面看起来完全正常。** 更难受的是台账对不上时页面给的提示
 * 原文就是「请把这一周重跑一次」(上面 `LedgerCheck`),我们自己把人往这颗按钮上推。
 *
 * 后端这一半已经修了(`restoreAppeals`:重跑前读 `scan_appeal` 把申诉过的仓搬回来),
 * 所以这个框**不是在劝阻**,是在说清三件事:换掉什么、会尽量搬回什么、搬不回来的
 * 那些会怎么样。三件里最容易被漏掉的是第三件 —— 不说清「下次搜到会自动回来」的话,
 * 用户看到回执里少了一个名字,唯一能做的判断是「我那一次申诉白点了」。
 *
 * `appealCount` 由调用方从**当前这一包**数出来(`candidates.filter(c => c.appealedFrom)`),
 * 不需要新端点。这是「我手上这份清单里有几行是你捞回来的」,不是猜一个数。
 */
export function RerunConfirm({
	weekOf,
	appealCount,
	busy,
	onConfirm,
	onCancel,
}: {
	weekOf: string;
	/** 这一周清单上有几行是用户自己申诉捞回来的。 */
	appealCount: number;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<section className="danger">
			<h3>重跑 {weekOf} 这一周?</h3>
			{appealCount > 0 ? (
				<p>
					<strong>这一周有 {appealCount} 个仓是你自己捞回来的</strong>
					(在排除清单里点过「这个该进来」)。重跑会先把这一周的候选和排除<strong>整批删掉重灌</strong>,
					所以那 {appealCount} 个要靠一次专门的恢复才回得来。
				</p>
			) : (
				<p>
					这一周<strong>没有</strong>你自己捞回来的仓,所以这一次重跑不会丢掉任何一次申诉。
					下面这些是它照样会做的事。
				</p>
			)}
			<p>重跑会做的事:</p>
			<ul>
				<li>
					<strong>整周的检索重跑一遍</strong> —— 这一周的候选和排除整批换掉,不是在现在这份结果上加东西。
					名次会变,上次差一名进清单的这次可能进来,反过来也一样。
				</li>
				{appealCount > 0 && (
					<li>
						你捞回来的那 {appealCount} 个<strong>会尽量搬回来</strong>:每个仓真打一次{" "}
						<code>GET /repos</code> 核实它还在(这道门不能省 —— 拿搜索索引里那份凑数,会让一个昨天刚删掉的仓
						靠一条一周前的申诉记录重新出现在清单上)。
					</li>
				)}
				{appealCount > 0 && (
					<li>
						<strong>搬不回来的会在跑完之后逐个列出来</strong>,原因只有一个:这一趟根本没搜到它
						(名次掉出搜索的返回范围、检索词改过、或者这一趟提前收工了)。硬搬的话台账等式就要说谎。
						<strong>它的申诉记录留着</strong> —— 下一次搜到它的重跑会自动把它搬回去,你不用再点一次,也不用再花一次额度。
					</li>
				)}
				<li>这一趟大概几十秒,<strong>不扣 AI 额度</strong>(时间几乎全花在等 GitHub 上)。已经跑出来的深度报告不受影响。</li>
			</ul>
			<div className="danger-row">
				<button type="button" className="btn-danger" disabled={busy} onClick={onConfirm}>
					{busy ? "扫描中…" : "确认重跑"}
				</button>
				<button type="button" className="btn-line" disabled={busy} onClick={onCancel}>
					再想想
				</button>
			</div>
		</section>
	);
}

/**
 * 清单屏底部那条收单台:说清这是哪一周,外加那颗重跑按钮。
 *
 * **为什么这一条也要做成组件**(而不是留在 App.tsx 的 JSX 里,像它原来那样):
 * 上面那个 `RerunConfirm` 单独测得再绿,也拦不住「有人把按钮直接接回 runScan、
 * 确认框从此再也不会被渲染」——那正是 render.test.ts 顶部记的阶段 3 那个洞的形状
 * (纯函数把话算对了,但没有任何一层把它送到屏幕上)。**闸门和被闸的那颗按钮
 * 必须在同一个测得到的组件里**,断言才能说「点这颗按钮只会打开确认框,不会重跑」。
 *
 * 所以这里的分工是死的:`onAsk` = 打开确认框(按钮只会调它),`onConfirm` = 真的重跑
 * (只有确认框里那颗红按钮调得到)。App 那边只提供 `confirming` 这一个布尔状态。
 */
export function RerunBar({
	scan,
	appealCount,
	busy,
	running,
	confirming,
	onAsk,
	onConfirm,
	onCancel,
}: {
	scan: WeeklyScan;
	/** 这一周清单上有几行是用户自己申诉捞回来的(调用方从这一包里数)。 */
	appealCount: number;
	/** 有别的事在飞(取数 / 重跑),按钮该禁用。 */
	busy: boolean;
	/** 正在跑的是重跑那一趟(决定按钮上写什么)。 */
	running: boolean;
	/** 确认框开着没有。 */
	confirming: boolean;
	onAsk: () => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<>
			{confirming && (
				<RerunConfirm
					weekOf={scan.weekOf}
					appealCount={appealCount}
					busy={busy}
					onConfirm={onConfirm}
					onCancel={onCancel}
				/>
			)}
			<div className="savebar">
				<span className="savebar-msg">
					这一份是 {scan.weekOf},基于档案 v{scan.dossierRev} 跑的。下一次自动周扫:{WEEKLY_SCAN_SCHEDULE.human}。
				</span>
				<div className="right">
					{/* **这颗按钮永远只调 onAsk。** 直接接 onConfirm 的那一版就是终审
					    A2 描述的那个 bug:点一下,「你捞回来的」那一节连同几行候选一起消失,
					    而台账是重新算的,所以四个数照样自洽,一处都不会报错。 */}
					<button type="button" className="btn-ink" disabled={busy || confirming} onClick={onAsk}>
						{running ? "扫描中…(几十秒)" : "现在重跑这一周"}
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * 重跑跑完的回执。**申诉那两栏是这个组件存在的全部理由。**
 *
 * `restored` / `missing` 直接来自 `RunScanResponse.appeals`(后端算的),这里
 * 一个都不数、一个都不推断。`missing` 非空时那句「下次搜到会自动回来」不是安慰话,
 * 是 `scan_appeal` 那一行确实留着这个事实的复述 —— 不说的话,少掉的那一行会被
 * 读成「我那次申诉白点了」,而下一步他多半会再点一次,再花一次额度做一件系统
 * 已经答应会自动做的事。
 *
 * 做成组件而不是一个返回字符串的纯函数:阶段 3 栽过的那次就是「纯函数把话算对了,
 * 但没有任何一层把它送到屏幕上」。是组件,渲染层测试才抓得住它。
 */
export function RerunReceipt({
	appeals,
	stopped,
	rate,
}: {
	appeals: RunScanResponse["appeals"];
	stopped: string | null;
	rate: RunScanResponse["rate"];
}) {
	return (
		<>
			<p style={{ margin: 0 }}>
				{stopped
					? "跑完了,但是提前收工了 —— 下面第 03 节红框里写着原因,这一周的清单是残的。"
					: `跑完了。这一趟打了 ${rate.searchCalls} 次 search + ${rate.coreCalls} 次 REST。`}
			</p>
			{appeals.restored.length > 0 && (
				<p className="rerun-appeals" style={{ margin: "8px 0 0" }}>
					你之前捞回来的 <b className="hn">{appeals.restored.length}</b> 个搬回来了:{appeals.restored.join("、")}。
				</p>
			)}
			{appeals.missing.length > 0 && (
				<p className="rerun-missing" style={{ margin: "8px 0 0" }}>
					有 <b className="hn">{appeals.missing.length}</b> 个这一趟没搜到,所以没能搬回来:{appeals.missing.join("、")}。
					<strong> 这不是白点了</strong> —— 它们的申诉记录还留着,下一次搜到它的重跑会<strong>自动</strong>把它们搬回清单,
					你不用再点一次「这个该进来」,也不用再花一次额度。
				</p>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// 整屏
// ---------------------------------------------------------------------------

export interface ScanViewProps {
	scan: WeeklyScan;
	candidates: readonly ScanCandidate[];
	exclusions: readonly ScanExclusion[];
	honesty: ScanHonesty;
	extras: RunExtras;
	appeal: AppealHandlers;
	/** 阶段 7 的入口。不给就整屏一个「拆开看看」都不渲染(门铃邮件那条路就不需要)。 */
	teardown?: TeardownHandlers;
}

export default function ScanView({ scan, candidates, exclusions, honesty, extras, appeal, teardown }: ScanViewProps) {
	// 申诉捞回的那些,候选行上要显示「当初是因为什么被排除的」——那是这个动作
	// 最该留下的痕迹。这句理由由**后端**在读取时 join 好(store.ts getWeeklyScan
	// 填 `ScanCandidate.appealedFrom`),这一层不再自己在两个数组之间配对。
	//
	// 为什么搬到后端(2026-09-01 阶段 4/5 评审):在这里配对只对**这一屏**有效,
	// 而阶段 8 的门铃邮件只拿候选清单去渲染,那枚徽记和那句理由会安静地消失。
	// 让 join 发生在所有读取路径的上游,下游就拿不到一份缺了这件事的候选清单。
	return (
		<>
			<HonestyStatement honesty={honesty} />
			<StoppedNotice stopped={scan.stopped} />

			<section className="dsec rise rise-1">
				<div className="dsec-head">
					<span className="dsec-no">01</span>
					<h2>候选清单</h2>
					<span className="dsec-count">{candidates.length} 行</span>
				</div>
				<CandidateList candidates={candidates} teardown={teardown} />
			</section>

			<section className="dsec rise rise-2">
				<div className="dsec-head">
					<span className="dsec-no">02</span>
					<h2>排除清单</h2>
					<span className="dsec-count">{scan.excluded} 条</span>
				</div>
				<p className="dsec-why">
					<strong>这一节不是调试信息,它和上面那张清单一样重。</strong>
					「你没给我看的那些去哪了」是这个产品要回答的问题 —— 每一条都带理由,
					而理由分两栏渲染:<strong>代码从 GitHub 字段算出来的</strong>,和<strong>模型判的</strong>。
					这两者混成一色,就等于让你把判断当事实读。
				</p>
				<ExclusionList exclusions={exclusions} appeal={appeal} excluded={scan.excluded} />
			</section>

			<section className="dsec rise rise-3">
				<div className="dsec-head">
					<span className="dsec-no">03</span>
					<h2>检索台账</h2>
					<span className="dsec-count">{scan.weekOf}</span>
				</div>
				<Ledger scan={scan} extras={extras} />
			</section>
		</>
	);
}
