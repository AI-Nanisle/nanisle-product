// 关注档案的四节(docs/01 决策 3)。
//
// **四节的顺序就是信任链,不是表单的排版顺序**:
//   01 你的原话      只读。AI 永不改写 —— 它是用户判断「我理解得对不对」的基准
//   02 我理解的领域   可改。系统对那句话的理解,摆出来让人质疑
//   03 我在意 / 我不在意  可改,两栏等重。右栏直接变成排除清单
//   04 我拿这些词去搜  可改。每周扫描唯一的召回入口,问责区的核心
//
// 越往下越接近「下周你会看到什么」。所以 04 不是「高级设置」,它是这一页
// 最该被读到的一节——用户看得见系统拿什么词去 GitHub 搜,改它就能改变下周
// 看到什么。这是 001「追踪定义档案」那套的移植,但立场更硬:001 的四节是
// 「编辑写给你的稿子」,003 的四节是**问责**。
//
// 这个组件只管渲染和编辑内存里的那份 fields,不发任何请求;拉取、保存、
// 删除、错误状态全在 App.tsx。分开是为了让「改了什么」和「存不存得进去」
// 各有一处可读的代码。

import { useState } from "react";

import { DOSSIER_LIMITS, WEEKLY_SCAN_SCHEDULE } from "../shared/types.ts";
import type { DossierFields, EmailPrefs } from "../shared/types.ts";
import { InlineInput } from "./InlineInput";
import { addItem, limitOf, moveItem, normalizeDomain, remaining, removeItem, replaceItem } from "./dossier-edit.ts";
import type { ListKey } from "./dossier-edit.ts";

/** 当前正在就地编辑的位置。null = 没有任何输入框展开。 */
type EditTarget = { key: "domain" } | { key: ListKey; index: number } | { key: ListKey; index: "new" } | null;

function sameTarget(a: EditTarget, b: EditTarget): boolean {
	if (a === null || b === null) return a === b;
	if (a.key !== b.key) return false;
	return ("index" in a ? a.index : null) === ("index" in b ? b.index : null);
}

/** 一条可就地编辑的行。悬停/聚焦才露出操作按钮,平时是干净的读物。 */
function Item({
	text,
	index,
	mono,
	accent,
	numbered,
	editing,
	onEdit,
	onCommit,
	onCancel,
	onRemove,
	onMove,
	moveLabel,
	reject,
}: {
	text: string;
	index: number;
	mono?: boolean;
	accent?: boolean;
	/** 检索词才编号:它们是一条条真的会被发出去的请求,序号有意义 */
	numbered?: boolean;
	editing: boolean;
	onEdit: () => void;
	onCommit: (next: string) => void;
	onCancel: () => void;
	onRemove: () => void;
	/** 给了才显示「改判到另一栏」 */
	onMove?: () => void;
	moveLabel?: string;
	/** 这一条刚被规则拒绝的理由(只在 editing 时有意义)。 */
	reject?: string | null;
}) {
	if (editing) {
		return (
			<li className={`item item-editing${mono ? " item-mono" : ""}`}>
				{numbered && <span className="item-idx">{index + 1}</span>}
				<InlineInput
					value={text}
					mono={mono}
					accent={accent}
					maxLength={DOSSIER_LIMITS.itemMax}
					onCommit={onCommit}
					onCancel={onCancel}
				/>
				{reject && (
					<p className="reject-note" role="alert">
						{reject}
					</p>
				)}
			</li>
		);
	}
	return (
		<li className={`item${mono ? " item-mono" : ""}`}>
			{numbered && <span className="item-idx">{index + 1}</span>}
			<button type="button" className="item-text" onClick={onEdit} title="点一下改这条(回车提交,Esc 放弃)">
				{text}
			</button>
			{onMove && (
				<button type="button" className="item-act" onClick={onMove} title={moveLabel} aria-label={`${moveLabel}:${text}`}>
					⇄
				</button>
			)}
			<button type="button" className="item-act" onClick={onRemove} aria-label={`删除:${text}`} title="删掉这条">
				×
			</button>
		</li>
	);
}

/**
 * 一栏列表。节 03 的两栏和节 04 的检索词共用它——**共用不是为了省代码,
 * 是为了让「我在意」和「我不在意」在版面上真的一样重**:同一个组件、
 * 同样的内边距、同样的标题字号,两栏之间唯一的差别是顶线的颜色。
 */
export function ListColumn({
	title,
	note,
	items,
	max,
	tone,
	mono,
	numbered,
	emptyText,
	addLabel,
	edit,
	onEditTarget,
	onItems,
	onMove,
	moveLabel,
	listKey,
	reject,
	onReject,
}: {
	title: string;
	note: string;
	items: string[];
	max: number;
	tone: "ink" | "accent";
	mono?: boolean;
	numbered?: boolean;
	emptyText: string;
	addLabel: string;
	edit: EditTarget;
	onEditTarget: (t: EditTarget) => void;
	onItems: (next: string[]) => void;
	/** 节 03 才有:把这一条挪到另一栏 */
	onMove?: (index: number) => void;
	moveLabel?: string;
	listKey: ListKey;
	/**
	 * 最近一次编辑被规则拒绝的理由,由 DossierView 持有(同一时刻只有一个
	 * 输入框开着,所以一份状态够用)。**必填,不是可选**:少传一个可选 prop
	 * 编译器不会说话,而症状正是这次评审抓到的那个——「拒绝了,但页面上
	 * 一个字都没有」。
	 */
	reject: string | null;
	/** 拒绝时报理由;成功/放弃时传 null,把上一条理由收掉。 */
	onReject: (msg: string | null) => void;
}) {
	const left = remaining(items, max);
	const accent = tone === "accent";
	const adding = edit !== null && edit.key === listKey && "index" in edit && edit.index === "new";
	/** 理由只显示在**开着输入框的那一栏**;别的栏不该跟着报错。 */
	const mine = edit !== null && edit.key === listKey ? reject : null;

	return (
		<div className={`col ${tone}`}>
			<div className="col-head">
				<h3>{title}</h3>
				<span className="col-count">
					{items.length}/{max}
				</span>
			</div>
			<p className="col-note">{note}</p>
			<div className="col-body">
				{items.length === 0 && !adding ? (
					<p className="empty-note">{emptyText}</p>
				) : (
					<ul className="item-list">
						{items.map((text, i) => (
							<Item
								key={`${text}-${i}`}
								text={text}
								index={i}
								mono={mono}
								accent={accent}
								numbered={numbered}
								editing={sameTarget(edit, { key: listKey, index: i })}
								onEdit={() => onEditTarget({ key: listKey, index: i })}
								onCommit={(next) => {
									const r = replaceItem(items, i, next);
									// 被拒绝时**什么都不收**:输入框留在原地、用户刚打的字还在、
									// 理由就显示在它下面。原来这里先 onEditTarget(null) 再看
									// r.ok,于是撞车的那条会「原地弹回旧文本」,看起来像用户
									// 自己打错了(2026-09-01 第二轮评审 ①)。
									if (!r.ok) {
										onReject(r.reason);
										return;
									}
									onReject(null);
									onEditTarget(null);
									onItems(r.list);
								}}
								onCancel={() => {
									onReject(null);
									onEditTarget(null);
								}}
								onRemove={() => onItems(removeItem(items, i))}
								onMove={onMove ? () => onMove(i) : undefined}
								moveLabel={moveLabel}
								reject={mine}
							/>
						))}
					</ul>
				)}
				{adding ? (
					<div style={{ marginTop: 6 }}>
						<InlineInput
							value=""
							mono={mono}
							accent={accent}
							maxLength={DOSSIER_LIMITS.itemMax}
							placeholder="回车添加,Esc 放弃"
							onCommit={(v) => {
								const r = addItem(items, v, max);
								// 同上:拒绝 = 留住输入框和内容 + 当场给理由。收起输入框的话,
								// 用户看到的是「计数没变、页面上没字」,最可能的反应是再打一遍
								// 同样的内容——那正是 docs/01 风险 1 说的「错得很安静」。
								if (!r.ok) {
									onReject(r.reason);
									return;
								}
								onReject(null);
								onEditTarget(null);
								onItems(r.list);
							}}
							onCancel={() => {
								onReject(null);
								onEditTarget(null);
							}}
						/>
						{mine && (
							<p className="reject-note" role="alert">
								{mine}
							</p>
						)}
					</div>
				) : (
					<button
						type="button"
						className="item-add"
						disabled={left === 0}
						onClick={() => onEditTarget({ key: listKey, index: "new" })}
					>
						{left === 0 ? `已满 ${max} 条` : `+ ${addLabel}(还能加 ${left} 条)`}
					</button>
				)}
			</div>
		</div>
	);
}

export interface DossierViewProps {
	/** 用户原话。任何状态下都是只读的。 */
	sentence: string;
	fields: DossierFields;
	onFields: (next: DossierFields) => void;
	/** 还没保存过的草稿(POST /api/dossier/draft 刚回来那一份)。 */
	draft: boolean;
	/** 草稿态:后端把 sentence 原样回显了 —— 当场自证「我没改你的话」。 */
	verbatim: boolean;
	/** 已保存档案的版本号;草稿态为 null。 */
	rev: number | null;
	/** 「换一句话」的去处:草稿态回种子屏,已保存态开删档面板。 */
	onRestate: () => void;
	/** 编辑被规则拦下时的一句理由(重复了 / 那栏满了),由 App 显示。 */
	onNotice: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// 门铃邮件的订阅开关(阶段 9,站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------

/**
 * 每周一早那封信收不收。
 *
 * **为什么放在档案屏而不是第一屏**(站长把这个判断留给了实现):
 *
 * 1. 第一屏是「这一周的内容」——它每周整屏换一次。订阅状态不是这一周的属性,
 *    放在那里会让人以为自己关掉的是「这一周不发」。
 * 2. 档案屏已经是这个产品所有「怎么服务你」的开关所在:那句原话、关心什么、
 *    检索词、以及删档。**邮件订阅和它们是同一类东西**,不是内容。
 * 3. 最重要的一条:`email_optout` 在删档时**故意不删**(store.ts
 *    deleteDossierCascade),而删档按钮就在这一屏。两个动作并排,那条取舍才
 *    解释得清 —— 「删档」和「别给我发信」是两件强度完全不同的事,分别在哪个
 *    按钮上,用户要能一眼看见。分到两屏的话,「我删了档案怎么还在收信」会
 *    变成一个没有地方回答的问题。
 *
 * 纯函数组件(不发请求、没有 useState):渲染层的测试靠「直接当函数调 +
 * react-dom/server 渲染成 HTML」来断言,带 hook 就测不动了。取数和写回在 App.tsx。
 */
export function EmailSwitch({
	prefs,
	busy,
	onChange,
}: {
	/** null = 还没读到(或这个实例读失败了)。**不猜一个默认值**:一个显示着
	 * 「在收」的开关,在真实状态是「已退订」时是一句谎话。 */
	prefs: EmailPrefs | null;
	busy: boolean;
	onChange: (optedOut: boolean) => void;
}) {
	if (!prefs) {
		return (
			<section className="mailbox">
				<div className="mailbox-head">
					<h3>每周一早的门铃邮件</h3>
				</div>
				<p className="dsec-why">正在读订阅状态…</p>
			</section>
		);
	}
	const on = !prefs.optedOut;
	return (
		<section className="mailbox">
			<div className="mailbox-head">
				<h3>每周一早的门铃邮件</h3>
				{/* **先说当前是什么状态,再给按钮**:一个不知道当前值的按钮,
				    用户点下去之前不知道自己会得到什么。 */}
				<span className={`mailbox-state${on ? " on" : ""}`}>{on ? "在收" : "已退订"}</span>
			</div>

			<p className="mailbox-now">
				{on ? (
					<>
						{WEEKLY_SCAN_SCHEDULE.human}扫完之后,发一封到 <strong>{prefs.email}</strong>。
					</>
				) : (
					<>
						已经退订,<strong>{prefs.email}</strong> 不会再收到这封信。
					</>
				)}
			</p>

			{/* 说清楚退订之后失去什么。这一段不是免责声明,是这个开关唯一的信息量:
			    「不发信」听起来只是少一次打扰,实际上失去的是**主动告诉你**的那部分。 */}
			<p className="dsec-why">
				这封信里有两样东西:<strong>本周那 5 个候选</strong>,和<strong>与上一周比变了什么</strong>
				 —— 后者包括「你上周在看的那个项目这周归档了 / 已经不在了」这类
				<strong>只有这封信会主动告诉你</strong>的事(它已经不在清单上了,所以你不会在网页上撞见它)。
				退订之后这两样都还在,只是要你自己想起来来看。
			</p>
			<p className="dsec-why">
				<strong>退订不影响网页。</strong>
				周扫照跑、清单和每一条排除理由照常落库,深度拆解照样能点。关掉的是门铃,不是产品。
			</p>
			{!prefs.configured && (
				<p className="dsec-why warn-line">
					不过这个实例没有配发信凭证(EMAIL_UNSUB_SECRET / AWS 凭证缺一),
					所以本来就没有信会发出去 —— 这个开关记的是你的意愿,配上凭证之后才会生效。
				</p>
			)}

			<div className="mailbox-row">
				<button type="button" className={on ? "btn-quiet" : "btn-ink"} disabled={busy} onClick={() => onChange(on)}>
					{busy ? "保存中…" : on ? "停掉这封信" : "重新开始收"}
				</button>
				<span className="mailbox-hint">
					{on
						? "邮件底部那条一键退订链接和这个开关是同一件事,点哪个都一样。"
						: "从邮件里点过退订的话,这里也会显示「已退订」—— 两处是同一个状态。"}
				</span>
			</div>
		</section>
	);
}

export default function DossierView({
	sentence,
	fields,
	onFields,
	draft,
	verbatim,
	rev,
	onRestate,
	onNotice,
}: DossierViewProps) {
	const [edit, setEdit] = useState<EditTarget>(null);
	/**
	 * 「加一条 / 改一条」被规则拒绝的那句理由(2026-09-01 第二轮评审 ①)。
	 *
	 * **为什么显示在输入框底下,而不是走 onNotice 那个页顶横幅**:这一页很长,
	 * 用户按下回车时眼睛在节 03 或节 04 上,页顶的横幅多半在屏幕外——那和
	 * 什么都不显示的差别很小,而这一条评审要修的正是「什么都不显示」。
	 * 跨栏改判(move)仍然走横幅:它没有输入框可挂,而且动的是两栏之间的东西,
	 * 页面级的一句话更合适。
	 *
	 * 一份状态够用:同一时刻只有一个输入框开着(edit 是单个目标)。
	 */
	const [reject, setReject] = useState<string | null>(null);

	/** 换编辑位置 = 上一条理由作废。理由是给那一个输入框的,不是给这一页的。 */
	const goEdit = (t: EditTarget) => {
		setReject(null);
		setEdit(t);
	};

	/** 节 03 的跨栏改判。目标栏满了或撞了就把理由喊出来,绝不静默丢条。 */
	const move = (from: ListKey, to: ListKey, index: number) => {
		const r = moveItem(fields[from], fields[to], index, limitOf(to));
		if (!r.ok) {
			onNotice(r.reason);
			return;
		}
		onFields({ ...fields, [from]: r.from, [to]: r.to });
	};

	return (
		<>
			{/* ———————————— 01 你的原话 ———————————— */}
			<section className="dsec rise rise-1">
				<div className="dsec-head">
					<span className="dsec-no">01</span>
					<h2>你的原话</h2>
					<span className="dsec-lock">只读 · AI 不改</span>
					{draft && verbatim && (
						<span className="verbatim" title="后端把这句话原封不动回显了">
							原样回显 ✓
						</span>
					)}
				</div>
				<p className="sentence">「{sentence}」</p>
				<p className="dsec-why">
					这一节<strong>永远不会被 AI 改写,你自己也改不了</strong>
					。它的用处只有一个:下面三节是我从这句话推出来的,你任何时候都能对着它判断「我理解得对不对」。
					基准要是也能改,这份档案就没法被质疑了。
					<br />
					想换一句话说 ——{" "}
					<button type="button" className="btn-quiet" onClick={onRestate}>
						{draft ? "回去重写这句话 →" : "删掉这份档案重建 →"}
					</button>
				</p>
			</section>

			{/* ———————————— 02 我理解的领域 ———————————— */}
			<section className="dsec rise rise-2">
				<div className="dsec-head">
					<span className="dsec-no">02</span>
					<h2>我理解的领域</h2>
					<span className="dsec-count">{fields.domain.length}/{DOSSIER_LIMITS.domainMax}</span>
				</div>
				{sameTarget(edit, { key: "domain" }) ? (
					<div style={{ marginTop: 12 }}>
						<InlineInput
							value={fields.domain}
							multiline
							maxLength={DOSSIER_LIMITS.domainMax}
							placeholder="一句话说清这份档案的领域边界"
							onCommit={(v) => {
								// domain 是单值,没有「重复 / 满了」这两种拒绝——normalizeDomain
								// 之后总能存,所以这条路上不需要 reject
								goEdit(null);
								onFields({ ...fields, domain: normalizeDomain(v) });
							}}
							onCancel={() => goEdit(null)}
						/>
					</div>
				) : (
					<button type="button" className="domain-line" onClick={() => goEdit({ key: "domain" })} title="点一下改写">
						{fields.domain || "（空的 —— 点一下补上,不然周扫不知道这句话在说哪个圈子）"}
					</button>
				)}
				<p className="dsec-why">
					错了就改。这是我对那句话的理解,不是你说过的话 ——
					把「上下文工程」理解成 RAG 还是 KV cache,差的是下周整份清单。
				</p>
			</section>

			{/* ———————————— 03 我在意 / 我不在意 ———————————— */}
			<section className="dsec rise rise-3">
				<div className="dsec-head">
					<span className="dsec-no">03</span>
					<h2>我在意 / 我不在意</h2>
					<span className="dsec-count">各 ≤ {DOSSIER_LIMITS.listMax} 条</span>
				</div>
				<p className="dsec-why">
					两栏一样重。<strong>右边这栏不是「顺便填的排除项」</strong>
					—— 它直接变成每周扫描的排除清单,是这份档案里唯一能立刻产生可见效果的字段。
					判错了点条目上的 ⇄ 就能挪到另一栏。
				</p>
				<div className="two-col">
					<ListColumn
						listKey="caresAbout"
						title="我在意"
						note="将来每条结论都要标出它对应这里的哪一条;标不出来的结论会被丢掉。"
						items={fields.caresAbout}
						max={DOSSIER_LIMITS.listMax}
						tone="ink"
						emptyText="至少写一条 —— 空着的话,那道「结论必须对应某一条在意」的门就自动失效了。"
						addLabel="加一条在意的"
						edit={edit}
						onEditTarget={goEdit}
						reject={reject}
						onReject={setReject}
						onItems={(caresAbout) => onFields({ ...fields, caresAbout })}
						onMove={(i) => move("caresAbout", "notCaresAbout", i)}
						moveLabel="改判到「我不在意」"
					/>
					<ListColumn
						listKey="notCaresAbout"
						title="我不在意"
						note="每条都会变成排除理由,写在每周的排除清单里给你看。空着也行 —— 硬凑出来的排除项会安静地滤掉真项目。"
						items={fields.notCaresAbout}
						max={DOSSIER_LIMITS.listMax}
						tone="accent"
						emptyText="空的。空的排除清单是响的:它明晃晃摆在第一屏上;硬凑的那条才是安静的。"
						addLabel="加一条不要的"
						edit={edit}
						onEditTarget={goEdit}
						reject={reject}
						onReject={setReject}
						onItems={(notCaresAbout) => onFields({ ...fields, notCaresAbout })}
						onMove={(i) => move("notCaresAbout", "caresAbout", i)}
						moveLabel="改判到「我在意」"
					/>
				</div>
			</section>

			{/* ———————————— 04 我拿这些词去搜 ———————————— */}
			<section className="dsec rise rise-4">
				<div className="dsec-head">
					<span className="dsec-no">04</span>
					<h2>我拿这些词去搜</h2>
					<span className={`dsec-count${fields.queries.length < DOSSIER_LIMITS.queriesMin ? " warn" : ""}`}>
						{fields.queries.length}/{DOSSIER_LIMITS.queriesMax} 条 · 至少 {DOSSIER_LIMITS.queriesMin} 条
					</span>
				</div>
				<p className="dsec-why">
					<strong>这是每周扫描唯一的召回入口。</strong>
					每条各发一次 GitHub 搜索,能捞回什么由 GitHub 的索引决定 —— 改这几个词,下周你看到的东西就变了。
					<br />
					也正因为它是唯一入口:这些词没覆盖到的项目,你永远不会知道它漏了。所以这一栏摆在这儿给你改,
					不是设置项,是<strong>问责</strong>。
				</p>
				<div className="two-col" style={{ gridTemplateColumns: "1fr" }}>
					<ListColumn
						listKey="queries"
						title="检索词"
						note="2-4 个英文词一条;同一个概念给出圈内的不同叫法;至少一条用 topic: 限定。别写具体仓库名。"
						items={fields.queries}
						max={DOSSIER_LIMITS.queriesMax}
						tone="ink"
						mono
						numbered
						emptyText="一条都没有 —— 这样的档案在 GitHub 上一个仓都捞不回来。"
						addLabel="加一条检索词"
						edit={edit}
						onEditTarget={goEdit}
						reject={reject}
						onReject={setReject}
						onItems={(queries) => onFields({ ...fields, queries })}
					/>
				</div>
				{rev !== null && (
					<p className="dsec-why">
						当前是第 <strong>v{rev}</strong> 版。改动保存后版本会 +1,将来每份周扫和报告上都印着它基于哪一版档案跑的。
					</p>
				)}
			</section>
		</>
	);
}
