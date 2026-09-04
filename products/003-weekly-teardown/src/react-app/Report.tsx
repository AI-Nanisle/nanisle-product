// 第三屏:深度报告(阶段 7 · docs/01 决策 6 / 7,docs/02 决策 T1 / T4)。
//
// 这一屏比另外两屏更容易写坏,因为它长得像一篇文章,而**文章天然会把降级藏起来**:
// 一份缺了 HN 语料、只读了 README、判断层被丢掉一半的报告,排版上和一份完整的
// 报告一模一样(docs/01 风险 1「错得很安静」)。所以这个文件有三条硬规矩,
// report-render.test.ts 逐条钉着:
//
//   ① gateNote 和 anchoredRatio 必须显示。「模型给了 8 条,5 条挂得上原文,
//      3 条挂不上已丢弃」——硬门的对价就是把删了什么说清楚,dropped 也要能查。
//   ② notes 不许折叠。它们记录的正是「这份报告缺了什么」,折叠 = 把降级藏起来。
//   ③ 页面上要写清:**可校验的是推理的地基,不是推理本身**。判断句在原文里
//      不存在,所以它不可能被锚定;我们校验的是「判断 ∈ 已锚定证据的闭包」。
//      不写这句,读者会以为判断本身有引用——那是一个我们没做过的承诺。
//
// 还有一条分级反转(docs/02 决策 T4),它在版面上必须一眼分得开:
//   事实层(时间线节点)锚不上 → **灰显并标注,不删**,判断权留给读者;
//   判断层(takeaway)挂不上   → **后端已经丢掉了**,页面上根本看不到,
//                               但丢了什么在「被丢弃的判断」里查得到。
//
// **本文件一个数都不算。**已锚定比例直接印 `report.anchoredRatio`(后端算的),
// 那两句 gateNote 直接印后端给的字符串。前端自己拿 evidence 数组算一遍的话,
// 它会在某次改版里和后端分叉,而分叉之后页面还是这么理直气壮地印着一个百分比。
//
// 和 Scan.tsx 同一条分工:**只渲染,不发请求**;除了几处 `<details>` 的开合,
// 组件全是无 hook 的纯函数,这样 report-render.test.ts 能直接把它们当函数调。

import type { ReactNode } from "react";

import type {
	ReportDropped,
	ReportEvidence,
	ReportNote,
	ReportTakeaway,
	TeardownReport,
	TimelineNode,
} from "../shared/types.ts";
import { PHASE_ORDER, PHASE_TEXT, pctText, phaseIndex, shortSha, sourceLabel } from "./report-run.ts";
import type { RunState } from "./report-run.ts";

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/** 数字统一包一层,既是排版也是**测试抓手**(同 Scan.tsx 的 N)。 */
function N({ v }: { v: number | string }) {
	return <b className="hn">{v}</b>;
}

const ymd = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

const KIND_LABEL: Record<TimelineNode["kind"], string> = {
	created: "建仓",
	release: "发布",
	"hn-story": "HN 发布帖",
	"hn-comment": "HN 评论",
	"last-push": "最后一次 push",
	archived: "归档",
};

// ---------------------------------------------------------------------------
// 生成中(SSE 的可读进度)
// ---------------------------------------------------------------------------

/**
 * 四步进度。**ping 不是进度**(types.ts 说得很直白:它是 thinking 期间唯一的
 * 字节),所以它只驱动右边那个跳动的点,一格进度都不推。`delta.chars` 只有
 * 字符数没有内容,页面就只说「已经吐了 N 字」,不假装能预览。
 *
 * `resumed` 那一支要单独说一句:接回来的是**进度不是流**——原来那条 SSE 随
 * 刷新一起断了,重连不了(写端在服务端的 waitUntil 里),现在页面是每 3 秒问
 * 一次 `/api/report/inflight`。不说清楚的话读者会以为他看的是实时字节,而
 * 「已生成 N 字」在这一支里永远是 0,那看起来就像卡住了。
 */
export function ReportProgress({ run }: { run: RunState }) {
	if (run.kind !== "running") return null;
	const at = run.phase ? phaseIndex(run.phase) : -1;
	return (
		<section className="run-box" aria-label="生成进度">
			<div className="run-top">
				<span className="run-name">{run.fullName}</span>
				<span
					className="run-beat"
					title={
						run.resumed
							? "接回来的那一路是每 3 秒问一次服务端跑到哪了,不是心跳"
							: "服务端每 10 秒发一次心跳。它证明连接还活着,不代表又前进了一步"
					}
				>
					<span className={`beat-dot${run.beats > 0 ? " beat-on" : ""}`} />
					{run.beats === 0 ? "等第一个字节" : run.resumed ? `问过 ${run.beats} 次` : `心跳 ${run.beats} 次`}
				</span>
			</div>
			<ol className="run-steps">
				{PHASE_ORDER.map((p, i) => {
					const state = at < 0 ? "wait" : i < at ? "done" : i === at ? "now" : "wait";
					return (
						<li key={p} className={`run-step run-${state}`}>
							<span className="run-mark">{state === "done" ? "✓" : state === "now" ? "▸" : "·"}</span>
							<span className="run-title">{PHASE_TEXT[p].title}</span>
							<span className="run-detail">{PHASE_TEXT[p].detail}</span>
						</li>
					);
				})}
			</ol>
			<p className="run-foot">
				{run.chars > 0 ? (
					<>
						模型已经吐了 <N v={run.chars} /> 字。<span className="run-quiet">
							服务端只报字符数不报内容,所以这里没法给你预览。
						</span>
					</>
				) : (
					<span className="run-quiet">模型在 thinking 的那几十秒里一个字都不会吐出来 —— 上面那个点在跳就说明连接还活着。</span>
				)}
			</p>
			{run.resumed ? (
				<p className="run-resumed">
					这一趟不是这个页面开的,是刷新之后<strong>接回来的进度</strong>:原来那条流已经断了,现在是每 3 秒问一次服务端跑到哪了。
					所以上面不会有「已生成 N 字」——那个数只有流还连着时才有。跑完了这一页会自己把报告显示出来。
				</p>
			) : (
				<p className="run-resumed">
					这一趟跑在服务端的 <code>waitUntil</code> 里:<strong>你关掉页面它也会跑完</strong>,回来还看得到。
					刷新也不会丢进度。
				</p>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// ① 锚定总账:anchoredRatio + 两句 gateNote + 那句必须写清的话
// ---------------------------------------------------------------------------

/**
 * **规矩 ① 和 ③ 都落在这一段。**
 *
 * 两个数都直接印后端给的,前端一个都不算。
 *
 * **「一共 N 条证据」是后端整张证据表的条数**(`report.evidence.length`),
 * 里面**包含被判断层硬门丢掉的那些 takeaway 挂过的证据**——那些 takeaway 一条
 * 都不会渲染,所以这个数比这一页上看得见的证据多。这是有意的:分母不藏,
 * `anchoredRatio` 才和它对得上(两个数出自同一张表)。
 *
 * **别把它改成「前端自己数一遍渲染了几条」。**这条注释原来就是那么写的
 * (「这一页真的渲染了几条」),而它和代码从第一天起就对不上;下一个人照着
 * 那句话去「修正」,最可能的动作正好是让前端自己数——那就是本文件开头那条
 * 「一个数都不算」的规矩要防的分叉:两个口径,页面上还都印得理直气壮
 * (同 Scan.tsx 诚实声明那条家法,test 里有反证)。2026-09-01 阶段 7 评审改。
 */
export function AnchorLedger({ report }: { report: TeardownReport }) {
	return (
		<section className="report-gate" aria-label="锚定与丢弃">
			<p className="gate-ratio">
				这份报告一共 <N v={report.evidence.length} /> 条证据(<strong>含被丢弃的判断挂过的那些</strong>),
				其中 <N v={pctText(report.anchoredRatio)} /> 在原文里逐字定位到了。
			</p>
			<p className="gate-note">
				<span className="gate-tag">节 1</span>
				{report.history.gateNote}
			</p>
			<p className="gate-note">
				<span className="gate-tag">节 2</span>
				{report.source.gateNote}
			</p>
			<p className="gate-hard">
				可校验的是推理的地基,不是推理本身。
			</p>
			<p className="gate-why">
				判断句在原文里根本不存在,所以它<strong>不可能</strong>被锚定 ——
				任何「我们的判断也有引用」都是假的。这里校验的是另一件事:每一条判断都必须挂在
				<strong>已经逐字锚定的证据</strong>上,挂不上的在落库之前就被代码丢掉了(不是灰显,是丢掉)。
				所以你能核的是它站在哪几段原文上,能不能从那几段推出这句话,得你自己判断。
			</p>
		</section>
	);
}

// ---------------------------------------------------------------------------
// ② notes:不许折叠
// ---------------------------------------------------------------------------

/**
 * **规矩 ②。**这些是「这份报告缺了什么」的全部记录(HN 上没记录 / 文件树被截断 /
 * 节 1 模型调用失败 / mock 档……)。
 *
 * 它们**不许进 `<details>`**:折叠之后,一份残的报告和一份全的报告长得一模一样,
 * 而那正是这个产品最反对的事(docs/01 风险 1)。report-render.test.ts 里有一条
 * 用例专门断言这些文字**不落在任何 details 容器内**——把它们包进去,那条当场红。
 */
export function NoteList({ notes }: { notes: readonly ReportNote[] }) {
	if (notes.length === 0) return null;
	return (
		<section className="report-notes" aria-label="这份报告缺了什么">
			<h3 className="notes-h">这份报告缺了什么</h3>
			<ul className="notes-list">
				{notes.map((n, i) => (
					<li key={`${n.kind}-${i}`} className={`note note-${n.kind}`}>
						<span className="note-kind">{n.kind}</span>
						<span className="note-text">{n.text}</span>
					</li>
				))}
			</ul>
			<p className="notes-foot">
				这一块<strong>没有折叠开关</strong>,也不会被收起来:藏起来之后,一份残的报告和一份完整的报告长得一模一样。
			</p>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 证据:引文 + 永久回链 + 锚定结果
// ---------------------------------------------------------------------------

/**
 * 一条证据。**事实层锚不上是灰显不删**(docs/02 决策 T4 的反转:判断权留给读者),
 * 所以这里 `anchored === false` 的分支不是「不渲染」,是换一身灰加一句标注。
 *
 * 永久回链的文案里点出「链接里是 commit sha」不是炫技:`blob/main/...#L12` 会在
 * 对方下次提交之后指向完全不同的代码,而这个产品相对同类工具真正的差异之一
 * 就是它不会漂(docs/01 决策 7)。不说的话,读者没有任何办法看出这个区别。
 */
export function EvidenceCard({ e }: { e: ReportEvidence }) {
	const permanent = /\/blob\/[0-9a-f]{40}\//i.test(e.permalink);
	return (
		<figure className={`ev${e.anchored ? "" : " ev-off"}`}>
			<blockquote className="ev-quote">{e.quote}</blockquote>
			<figcaption className="ev-meta">
				<span className="ev-src">{sourceLabel(e.source)}</span>
				{e.anchored ? (
					<span className="ev-ok" title="anchorAcross 只在它声称的那一份材料里比对,跨源命中判为失败">
						已在原文中逐字定位
					</span>
				) : (
					<span className="ev-bad">未能在原文中定位 —— 这一条没有删,但它的引文我们核不上</span>
				)}
				<a className="ev-link" href={e.permalink} target="_blank" rel="noreferrer">
					{permanent ? "看原文(指向当时那几行,对方之后改了也不会漂)" : "看原文"}
				</a>
			</figcaption>
			{e.context && (
				<details className="ev-ctx">
					<summary>命中处前后各 150 字</summary>
					<pre>{e.context}</pre>
				</details>
			)}
		</figure>
	);
}

/** 证据表里找不到那个 id。不该发生(后端硬门保证),发生了就当场说破而不是留白。 */
function MissingEvidence({ id }: { id: string }) {
	return (
		<p className="ev-missing" role="alert">
			这里该有一条证据(<code>{id}</code>),但它不在证据表里 —— 这是一个 bug,别把这一行当成有据可查的。
		</p>
	);
}

// ---------------------------------------------------------------------------
// 判断层:takeaway 与被丢弃的
// ---------------------------------------------------------------------------

/**
 * 一条判断。三样东西缺一不可:结论、它对应档案里在意的哪一条、它站在哪几段原文上。
 *
 * `caresAbout` 用的是**报告快照那一份**(TeardownReport.caresAbout),不是用户
 * 现在那一份 —— types.ts 把这个坑写在字段注释里了:用户改完档案再打开旧报告,
 * 下标会指到另一条上去,而页面上没有任何东西会报错。
 */
export function TakeawayItem({
	t,
	caresAbout,
	evidence,
}: {
	t: ReportTakeaway;
	caresAbout: readonly string[];
	evidence: ReadonlyMap<string, ReportEvidence>;
}) {
	const care = caresAbout[t.caresAboutIndex];
	return (
		<li className="tk">
			<p className="tk-text">{t.text}</p>
			<p className="tk-cares">
				<span className="tk-cares-tag">对应你在意的第 {t.caresAboutIndex + 1} 条</span>
				{care ?? "(这一条在跑报告时的那一版档案里找不到了)"}
			</p>
			<div className="tk-basis">
				<p className="tk-basis-h">它的地基({t.basedOn.length} 条已锚定的引文):</p>
				{t.basedOn.map((id) => {
					const e = evidence.get(id);
					return e ? <EvidenceCard key={id} e={e} /> : <MissingEvidence key={id} id={id} />;
				})}
			</div>
		</li>
	);
}

export function TakeawayList({
	takeaways,
	caresAbout,
	evidence,
	empty,
}: {
	takeaways: readonly ReportTakeaway[];
	caresAbout: readonly string[];
	evidence: ReadonlyMap<string, ReportEvidence>;
	/** 一条都没剩下时说什么。**空着不行**——那看起来像「这一节没什么可说的」。 */
	empty: string;
}) {
	if (takeaways.length === 0) return <p className="empty-note">{empty}</p>;
	return (
		<ul className="tk-list">
			{takeaways.map((t, i) => (
				<TakeawayItem key={`${i}-${t.text.slice(0, 16)}`} t={t} caresAbout={caresAbout} evidence={evidence} />
			))}
		</ul>
	);
}

/**
 * 被丢弃的判断。**可以折叠,但入口必须在**(规矩 ①):硬门的对价就是把删了
 * 什么说清楚,而这些句子读者一条都没见过——不给入口的话,「丢弃」这个动作就
 * 只是一句我们自己说的话。
 *
 * 这里和 notes 的处理故意不一样,区别值得说破:notes 说的是「这份报告缺了什么」
 * (读者必须知道),dropped 说的是「模型说了但没通过的那几句」(读者可以选择
 * 不看)。前者折叠是隐瞒,后者折叠是版面。
 */
export function DroppedBlock({ dropped, where }: { dropped: readonly ReportDropped[]; where: string }) {
	if (dropped.length === 0) {
		return <p className="dropped-none">这一节模型给的每一条都挂上了原文,没有被丢弃的。</p>;
	}
	return (
		<details className="dropped">
			<summary className="dropped-head">
				<span className="dropped-count">{dropped.length} 条</span>
				{where}被硬门丢弃的判断(点开看丢了什么、为什么)
			</summary>
			<ul className="dropped-list">
				{dropped.map((d, i) => (
					<li key={`${i}-${d.kind}`} className={`drop drop-${d.kind}`}>
						<p className="drop-text">{d.text}</p>
						<p className="drop-why">
							<span className="drop-kind">{d.kind}</span>
							{d.reason}
						</p>
					</li>
				))}
			</ul>
			<p className="dsec-why">
				这些是<strong>模型真的写出来过</strong>的句子。它们没进上面那份清单,不是因为它们一定错,
				而是因为它们挂不上任何一段已经逐字锚定的原文 —— 在这个产品里那就等于没有地基。
			</p>
		</details>
	);
}

// ---------------------------------------------------------------------------
// 节 1 · 它当年怎么走到今天
// ---------------------------------------------------------------------------

/**
 * HN 那一块。**`commentCandidates === 0` 时不假装有**(docs/01 决策 7 的语料就是它)。
 *
 * 帖子的分数是真的(HN Algolia 对 story 给 `points`),**评论的分数不是**——
 * HN 不公开评论分数,2026-09-01 实测确认 Algolia 的 comment 命中里连 `points`
 * 这个键都没有。所以这一块里唯一和「排名」有关的说法是候选池的**顺序口径**,
 * 而且两种口径说两句不同的话:拿到官方 `kids` 才敢说「HN 排在最前面的 N 条」。
 */
export function HnBlock({ report }: { report: TeardownReport }) {
	const { hnStory, commentCandidates, commentOrder, commentsMissing } = report.history;
	if (!hnStory) {
		return (
			<p className="hn-none" role="note">
				<strong>这个项目在 HN 上没有记录。</strong>
				节 1 里因此没有当年的一手反应,只有 GitHub 自己的字段和 changelog ——
				而当年那条 Show HN 底下的质疑帖,恰恰是判断层最好的原料。这一份少了它。
			</p>
		);
	}
	return (
		<>
			<div className="hn-story">
				<a className="hn-title" href={hnStory.url ?? hnStory.permalink} target="_blank" rel="noreferrer">
					{hnStory.title}
				</a>
				<span className="hn-facts">
					<span className="fact">
						<N v={hnStory.points} /> 分
					</span>
					<span className="fact">
						<N v={hnStory.numComments} /> 条评论
					</span>
					<a className="fact fact-link" href={hnStory.permalink} target="_blank" rel="noreferrer">
						去 HN 看当年的讨论 →
					</a>
				</span>
			</div>
			{commentCandidates === 0 ? (
				<p className="hn-none" role="note">
					找到了发布帖,但它底下<strong>一条评论都没有</strong> —— 当年的一手反应在 HN 上没有记录,
					下面的判断里没有任何一条来自读者的质疑。
				</p>
			) : (
				<p className="dsec-why">
					代码取回了 <N v={commentCandidates} /> 条候选评论,<strong>模型唯一被允许的动作是从里面挑几条</strong> ——
					取数和排序都是代码做的,挑中的那几条在下面的时间线上带着「模型挑的」标记。
					{commentOrder === "kids" ? (
						<>
							{" "}
							顺序是 <strong>HN 自己的排序</strong>(官方接口的 <code>kids</code>,真实反映当年的投票),
							所以时间线上写得出「HN 排在第几条」。<strong>分数印不出来:HN 不公开评论分数</strong>,
							谁也拿不到。
							{commentsMissing > 0 ? (
								<> 其中 {commentsMissing} 条的正文取不到,如实少给了 —— 没有拿后面的评论补上来充数。</>
							) : null}
						</>
					) : (
						<>
							{" "}
							<strong>这一份拿不到 HN 自己的排序</strong>(官方接口这会儿没给出 <code>kids</code>),
							所以候选池是按发表时间从早到晚给的 —— 下面那几条<strong>不代表当年被顶得最高</strong>。
						</>
					)}
				</p>
			)}
		</>
	);
}

/**
 * 时间线。**事实层:锚不上灰显并标注,不删。**
 *
 * 这和判断层是相反的处理,而两者在同一页上,所以版面必须让读者一眼分得开——
 * 灰掉的节点还在,被丢弃的判断根本不在。页面上有一段明写的对照(LayerLegend)。
 */
export function Timeline({ report }: { report: TeardownReport }) {
	const evidence = new Map(report.evidence.map((e) => [e.id, e]));
	const nodes = report.history.timeline;
	if (nodes.length === 0) {
		return <p className="empty-note">时间线上一个节点都没有 —— 连 GitHub 的建仓日期都没取到,这一节基本是空的。</p>;
	}
	return (
		<ol className="tl">
			{nodes.map((n, i) => {
				const e = evidence.get(n.evidenceId);
				const off = e ? !e.anchored : false;
				return (
					<li key={`${n.at}-${i}`} className={`tl-node tl-${n.kind}${off ? " tl-unanchored" : ""}`}>
						<div className="tl-head">
							<span className="tl-at">{ymd(n.at)}</span>
							<span className="tl-kind">{KIND_LABEL[n.kind] ?? n.kind}</span>
							<span className="tl-label">{n.label}</span>
							{off && <span className="tl-off">未能在原文中定位</span>}
						</div>
						{n.pickedWhy && (
							<p className="tl-why">
								<span className="by-model" title="节 1 里唯一一处模型的措辞:它为什么从 30 条候选评论里挑了这一条">
									模型挑的
								</span>
								{n.pickedWhy}
							</p>
						)}
						{e ? <EvidenceCard e={e} /> : <MissingEvidence id={n.evidenceId} />}
					</li>
				);
			})}
		</ol>
	);
}

// ---------------------------------------------------------------------------
// 节 2 · 它源码里值得抄什么
// ---------------------------------------------------------------------------

/**
 * 真的读过的那几份文件。**这是节 2 的问责区**:读了哪几个、凭什么挑的、
 * 喂进去多少字,全部摊开——「读了哪几个文件是可复述的」是这一节相对
 * 「让模型自己去看看」的全部区别。
 *
 * `treeTruncated === true` 的那条警示必须显著:那时候节 2 **只读了 README**,
 * 而一份只读了 README 的报告和一份读了 5 份源码的报告,排版上长得一模一样。
 */
export function SourceFiles({ report }: { report: TeardownReport }) {
	const { files, treeTruncated, commitSha } = report.source;
	return (
		<>
			{treeTruncated && (
				<p className="report-alarm" role="alert">
					<strong>文件树太大被截断,这一节只读了 README。</strong>
					GitHub 的文件树接口对超大仓只给一部分(truncated),拿不到完整清单就没法按路径挑源码 ——
					所以下面的判断里没有一条来自真正的实现代码。
				</p>
			)}
			{files.length === 0 ? (
				<p className="empty-note">一份文件正文都没取到,这一节没有可读的东西。</p>
			) : (
				<div className="files-wrap">
					<table className="files">
						<thead>
							<tr>
								<th>真的读过的文件</th>
								<th>打分</th>
								<th>喂进模型的字数</th>
								<th>仓内字节</th>
								<th>凭什么挑了它</th>
							</tr>
						</thead>
						<tbody>
							{files.map((f) => (
								<tr key={f.path}>
									<td>
										<a href={f.blobUrl} target="_blank" rel="noreferrer">
											{f.path}
										</a>
									</td>
									<td>{f.score}</td>
									<td>{f.chars}</td>
									<td>{f.size > 0 ? f.size : "—"}</td>
									<td className="files-why">{f.why}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<p className="dsec-why">
				这几个链接和下面每一条引文的回链,里面都是 commit <code>{shortSha(commitSha)}</code> 的完整 sha,
				<strong>不是分支名</strong> —— <code>blob/main/…#L12</code> 会在对方下次提交之后指向完全不同的代码,
				而这些链接永远指向我们当时读到的那几行。
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// 两层的对照(事实层灰显 vs 判断层已丢弃)
// ---------------------------------------------------------------------------

/**
 * 同一页上两种相反的处理,不明写读者只会当成排版不一致。
 * 这一段是 docs/02 决策 T4 那张表的人话版。
 */
export function LayerLegend() {
	return (
		<section className="layer-legend" aria-label="两层的不同处理">
			<div className="layer layer-fact">
				<h4>事实层 · 灰显不删</h4>
				<p>
					时间线上的节点(建仓日、release、HN 帖子)。引文没能在原文里定位到时,节点<strong>照样留在页面上</strong>,
					只是灰掉并标一句「未能在原文中定位」。判断权留给你:日期本身来自 GitHub 字段,不会因为引文没配上就不成立。
				</p>
			</div>
			<div className="layer layer-judge">
				<h4>判断层 · 直接丢弃</h4>
				<p>
					每一节的结论。挂不上已锚定证据的那些,<strong>在落库之前就被代码丢掉了</strong>,你在上面根本看不到它们
					—— 不是灰显。在最想被读的那一层放软门就是自欺:灰色会被当成排版,照读不误。
					丢了哪些、为什么,在每节的「被硬门丢弃的判断」里查得到。
				</p>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 整屏
// ---------------------------------------------------------------------------

function Sec({ no, title, count, why, children }: { no: string; title: string; count: string; why?: ReactNode; children: ReactNode }) {
	return (
		<section className="dsec rise rise-2">
			<div className="dsec-head">
				<span className="dsec-no">{no}</span>
				<h2>{title}</h2>
				<span className="dsec-count">{count}</span>
			</div>
			{why && <p className="dsec-why">{why}</p>}
			{children}
		</section>
	);
}

export default function ReportView({ report }: { report: TeardownReport }) {
	const evidence = new Map(report.evidence.map((e) => [e.id, e]));
	const when = new Date(report.generatedAt);
	const whenText = Number.isNaN(when.getTime()) ? "" : when.toISOString().slice(0, 16).replace("T", " ");

	return (
		<>
			<section className="report-id rise rise-1">
				<h2 className="report-name">
					<a href={`https://github.com/${report.fullName}`} target="_blank" rel="noreferrer">
						{report.fullName}
					</a>
				</h2>
				<p className="report-facts">
					<span className="fact">commit {shortSha(report.commitSha)}</span>
					<span className="fact">档案 v{report.dossierRev}</span>
					<span className="fact fact-quiet">{whenText} UTC 生成</span>
					<span className="fact fact-quiet">
						{report.model.provider} · {report.model.historyModel}
						{report.model.sourceModel !== report.model.historyModel ? ` / ${report.model.sourceModel}` : ""}
					</span>
					<span className="fact fact-quiet">按上限估 ${report.estUsd}</span>
				</p>
				<p className="dsec-why">
					整份报告锚在 commit <code>{report.commitSha}</code> 上。下面每一条引文的回链里都是这个 sha,
					<strong>不是分支名</strong>:对方之后改了代码,这些链接照样指向我们当时读到的那几行。
				</p>
			</section>

			{/* ② notes 永远在最上面,永远不折叠 */}
			<NoteList notes={report.notes} />

			{/* ① gateNote + anchoredRatio + ③ 那句必须写清的话 */}
			<AnchorLedger report={report} />

			<LayerLegend />

			<Sec
				no="01"
				title="它当年怎么走到今天"
				count={`${report.history.timeline.length} 个节点`}
				why={
					<>
						主体是<strong>当年 HN 上的一手反应原文</strong>,不是今天的文章回头总结。
						时间线上的日期和标签全由代码生成,模型在这一节只做两件事:从候选评论里挑几条、写下面那几条判断。
					</>
				}
			>
				<HnBlock report={report} />
				<Timeline report={report} />
				<h3 className="tk-h">这一节的判断</h3>
				<TakeawayList
					takeaways={report.history.takeaways}
					caresAbout={report.caresAbout}
					evidence={evidence}
					empty="这一节一条判断都没剩下 —— 要么模型调用没成功(上面的清单里会写),要么它给的每一条都挂不上已锚定的原文,被硬门丢完了。上面那句 gateNote 是这件事的账。"
				/>
				<DroppedBlock dropped={report.history.dropped} where="节 1 " />
			</Sec>

			<Sec
				no="02"
				title="它源码里值得抄什么"
				count={`${report.source.files.length} 份文件`}
				why={
					<>
						每条判断都必须标出<strong>它对应你档案里在意的第几条</strong>,标不出来的在落库之前就丢了。
						这不是形式主义:它是滤掉「这个项目用了 zod 做校验」这类<strong>真但无用</strong>的观察的唯一手段。
					</>
				}
			>
				<SourceFiles report={report} />
				<h3 className="tk-h">这一节的判断</h3>
				<TakeawayList
					takeaways={report.source.takeaways}
					caresAbout={report.caresAbout}
					evidence={evidence}
					empty="这一节一条判断都没剩下 —— 读了哪几个文件仍然列在上面(那是代码做的),但没有一条判断挂得上已锚定的原文。"
				/>
				<DroppedBlock dropped={report.source.dropped} where="节 2 " />
			</Sec>

			<section className="dsec rise rise-3">
				<div className="dsec-head">
					<span className="dsec-no">03</span>
					<h2>这份报告基于的那一版档案</h2>
					<span className="dsec-count">v{report.dossierRev}</span>
				</div>
				<p className="dsec-why">
					上面每一条判断标的「你在意的第 N 条」指的是<strong>下面这一份快照</strong>,不是你现在那一份档案。
					改过档案之后再回来看这份旧报告,下标仍然对得上 —— 因为它存的是当时那一份。
				</p>
				{report.caresAbout.length === 0 ? (
					<p className="empty-note">那一版档案里「我在意」一条都没有。</p>
				) : (
					<ol className="cares-snap">
						{report.caresAbout.map((c, i) => (
							<li key={`${i}-${c}`}>{c}</li>
						))}
					</ol>
				)}
			</section>
		</>
	);
}
