// 站点外壳:从 002 物理复制(自包含,不跨产品 import),与主站页眉是同一件
// 东西。产品挂在 nanisle.com/products/weekly-teardown 下,和主站同源——进产品
// 不该像换了个网站,更不该把「我是谁」弄丢。
//
// **与 002 那份的唯一实质差别**:002 的 /api/health 会回 site / loginUrl /
// email 三样,页眉自己去问就够了;003 的 /api/health 只有 provider / hasPat /
// hasDb(worker 已实现且测过,本阶段不动它)。所以身份改成由 App 传进来——
// App 反正要打 GET /api/dossier,那一发的 401 里就带着 loginUrl(guard.ts
// 写死的契约),200 则说明已登录。页眉不再自己发第三个请求。
//
// 名字和头像仍然向主站的 better-auth 会话要(同源 GET,独立部署时必然失败,
// 那就只显示一个首字母圆标,不影响可用)。
// 退出登录必须两边一起退,只退一个会出现「回主站还是登录态」或者「产品里
// 还能继续读」的怪事。

import { useEffect, useRef, useState } from "react";
import { productPath } from "./paths";

export interface SiteUser {
	name?: string;
	email: string;
	image?: string | null;
}

/** 主站地址取不到时的兜底(线上就是这个值)。 */
const FALLBACK_SITE = "https://nanisle.com";
/** 连 401 都没拿到时的登录闸口兜底(和 guard.ts loginUrl 同形)。 */
const FALLBACK_LOGIN = `${FALLBACK_SITE}/api/launch/weekly-teardown`;

/** 从 loginUrl 反推主站根地址:导航和登录按钮都挂在它下面。 */
function siteOf(loginUrl: string | null): string {
	if (!loginUrl) return FALLBACK_SITE;
	try {
		return new URL(loginUrl, window.location.href).origin;
	} catch {
		return FALLBACK_SITE;
	}
}

const NAV = [
	{ href: "/products", label: "产品" },
	{ href: "/journal", label: "日志" },
	{ href: "/about", label: "关于" },
];

/** 页眉主字标:五枚像素岛组成一条 52° 航线(与主站 web/components/logo.tsx 同形)。 */
function LogoWordmark() {
	return (
		<span className="logo-wordmark" aria-hidden>
			<span>NAN</span>
			<svg viewBox="0 0 14 18" width="14" height="18">
				<g fill="var(--accent)">
					<rect className="logo-route-tile" x="0.6" y="13.6" width="2.8" height="2.8" rx="0.45" />
					<rect className="logo-route-tile" x="3.1" y="10.4" width="2.8" height="2.8" rx="0.45" />
					<rect className="logo-route-tile" x="5.6" y="7.2" width="2.8" height="2.8" rx="0.45" />
					<rect className="logo-route-tile" x="8.1" y="4" width="2.8" height="2.8" rx="0.45" />
					<rect className="logo-route-tile" x="10.6" y="0.8" width="2.8" height="2.8" rx="0.45" />
				</g>
			</svg>
			<span>ISLE</span>
		</span>
	);
}

function UserMenu({ user, site }: { user: SiteUser; site: string }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

	const signOut = async () => {
		setBusy(true);
		try {
			// 主站的 better-auth 会话(同源 POST)
			await fetch(`${site}/api/auth/sign-out`, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
		} catch {
			// 主站不可达也得把本产品的会话退掉,下面那步不能跳
		}
		// 本产品的会话 cookie:worker 清掉后把人送回主站
		window.location.href = productPath("auth/logout");
	};

	return (
		<div className="user-menu" ref={rootRef}>
			<button
				type="button"
				className="user-chip"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="账号菜单"
				onClick={() => setOpen((v) => !v)}
			>
				{user.image ? <img src={user.image} alt="" width={26} height={26} /> : <span aria-hidden>{initial}</span>}
			</button>

			{open && (
				<div className="user-pop" role="menu">
					<div className="user-pop-id">
						{user.name && <strong>{user.name}</strong>}
						<span>{user.email}</span>
					</div>
					<button
						type="button"
						role="menuitem"
						className="user-pop-item"
						disabled={busy}
						onClick={() => void signOut()}
					>
						{busy ? "正在退出…" : "退出登录"}
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * 主站同款页眉。产品的每个状态(读、编辑、锁屏、报错)都套着它。
 *
 * @param signedIn  App 从 GET /api/dossier 的状态码得知的登录态;null = 还没问出来
 * @param loginUrl  401 响应里带回来的地址(不自己拼),没有就用兜底
 */
export function SiteHeader({ signedIn, loginUrl }: { signedIn: boolean | null; loginUrl: string | null }) {
	const site = siteOf(loginUrl);
	const [user, setUser] = useState<SiteUser | null>(null);

	useEffect(() => {
		// 没登录就别去问主站要身份:那一发注定是匿名的,白等一个请求
		if (!signedIn) {
			setUser(null);
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const res = await fetch(`${site}/api/auth/get-session`, { credentials: "include" });
				if (!res.ok) return;
				const data = (await res.json()) as { user?: SiteUser } | null;
				if (alive && data?.user?.email) setUser(data.user);
			} catch {
				// 独立部署 / 主站不可达:退回下面那个只有首字母的匿名圆标
			}
		})();
		return () => {
			alive = false;
		};
	}, [signedIn, site]);

	return (
		<header className="site-header">
			<div className="site-header-in">
				<a className="brand" href={site} aria-label="南屿 nanisle 首页">
					<LogoWordmark />
					<span className="brand-cn">南屿</span>
				</a>

				<nav className="site-nav" aria-label="主导航">
					{NAV.map((item) => (
						<a key={item.href} href={`${site}${item.href}`}>
							{item.label}
						</a>
					))}
					<span className="nav-divider" aria-hidden />
					{/* 登录态还没问出来时占住位置,避免圆标出现时整条导航横跳 */}
					{signedIn === null ? (
						<span className="user-chip user-chip-ghost" aria-hidden />
					) : signedIn ? (
						// 主站会话拿不到名字时用一个占位身份:圆标该在的时候就得在
						<UserMenu user={user ?? { email: "已登录" }} site={site} />
					) : (
						<a className="btn-line btn-login" href={loginUrl ?? FALLBACK_LOGIN}>
							登录
						</a>
					)}
					<a className="btn-ink" href={`${site}/#signal`}>
						订阅更新
					</a>
				</nav>
			</div>
		</header>
	);
}
