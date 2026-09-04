// 从 001 的 Dossier.tsx 物理复制(自包含:不跨产品 import)。
// 改动两处,都有理由:
//   1. 样式从 Tailwind 任意值换成 index.css 的 .inline-input —— 003 的档案页
//      整体用的是语义 class,混两套写法以后没人知道改哪儿;
//   2. **加了 isComposing 判断**。001 那份没有,而这个产品的三节输入(领域、
//      在意/不在意)全是中文:用拼音输入法打字时,选字用的回车会先冒出一个
//      keydown,原来那份会把「zhongwen」这半截拼音当成一条内容提交掉。
//      001 的「对编辑说一句」输入框里已经有 isComposing 这道判断,只是没下沉
//      到 InlineInput —— 这里补上。
//
// 键盘契约(全站就地编辑都靠它,不许在调用方另起炉灶):
//   Enter      提交(multiline 时 Shift+Enter 换行)
//   Esc        放弃,不提交
//   失焦       按提交处理 —— 点到别处就当写完了,比「点到别处内容消失」好

import { useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

export function InlineInput({
	value,
	accent,
	mono,
	multiline,
	placeholder,
	maxLength,
	onCommit,
	onCancel,
}: {
	value: string;
	/** 朱红描边:用在「我不在意」那一栏,和它的标题同色 */
	accent?: boolean;
	/** 等宽:检索词是要发给 GitHub 的字符串,不是散文 */
	mono?: boolean;
	multiline?: boolean;
	placeholder?: string;
	/** 直接来自 DOSSIER_LIMITS,不在这里写死数字 */
	maxLength?: number;
	onCommit: (next: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(value);
	/**
	 * 「这一轮已经了结了」——**只用来挡紧接着的那一次 blur**。
	 *
	 * 要挡的是两种重复:Esc 之后的 blur 会把放弃变成提交;Enter 之后的 blur 会
	 * 把一次提交变成两次。React 在元素被卸载时通常不派发 onBlur,但「通常」不够
	 * —— 调用方完全可能在取消/提交后仍然渲染这个框,而 003 现在正是这种用法:
	 * 加一条被规则拒绝时输入框**留在原地**(内容还在,理由显示在它下面)。
	 *
	 * 所以这里有两条规矩,缺一条就会咬到自己(2026-09-01 第二轮评审的「提醒」):
	 *   1. **键盘提交不看这个闩**。原来 commit() 第一行就是 `if (settled) return`,
	 *      于是一旦 cancel() 把它置成 true,这个实例此后**任何**提交都被吞掉——
	 *      注释里举的那个「取消后仍然渲染」的例子,恰恰是它自己会坏的例子。
	 *   2. **用户一动键盘就重新上膛**(onChange 里清零)。不然「回车 → 被拒 →
	 *      改两个字 → 点到别处」这条路上,最后那次 blur 提交会被上一轮的闩挡掉,
	 *      用户刚改的内容安静消失 —— 正是这道闩本来要防的那种事。
	 */
	const settled = useRef(false);

	const cls = `inline-input${accent ? " accent" : ""}${mono ? " mono" : ""}${multiline ? " multiline" : ""}`;

	const cancel = () => {
		settled.current = true;
		onCancel();
	};
	/** 键盘提交:总是发生。发生之后把闩合上,挡住紧随其后的 blur。 */
	const commit = (text: string) => {
		settled.current = true;
		onCommit(text);
	};
	/** 失焦提交:上一次 Enter/Esc 刚了结过就不再提交一遍。 */
	const commitOnBlur = (text: string) => {
		if (settled.current) return;
		commit(text);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			cancel();
			return;
		}
		if (e.key !== "Enter") return;
		// 输入法组字中的回车是「选这个词」,不是「我写完了」
		if (e.nativeEvent.isComposing) return;
		if (multiline && e.shiftKey) return;
		e.preventDefault();
		commit(draft);
	};

	const common = {
		autoFocus: true,
		value: draft,
		placeholder,
		maxLength,
		className: cls,
		onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			// 又在打字 = 这一轮还没完,重新上膛(见 settled 的注释第 2 条)
			settled.current = false;
			setDraft(e.target.value);
		},
		onKeyDown,
		onBlur: () => commitOnBlur(draft),
	};

	return multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}

export default InlineInput;
