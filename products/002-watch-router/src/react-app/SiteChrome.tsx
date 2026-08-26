// 站点外壳:与主站页眉同一件东西(主仓 web/components/site-header.tsx +
// login-dialog.tsx 的 AuthControl)。产品挂在 nanisle.com/products/daily-brief
// 下,和主站同源——进产品不该像换了个网站,更不该把「我是谁」弄丢。
//
// 用户身份两级取:
//   1. 本产品 /api/health 回的会话邮箱——产品自己的会话说了算,离线/独立
//      部署时也有(本地 dev 是 dev@local)。
//   2. 主站 /api/auth/get-session(同源 better-auth)——补上名字和头像,
//      让圆标和主站长得一模一样。拿不到就只用邮箱,不影响页眉可用。
// 退出登录必须两边一起退,只退一个会出现「回主站还是登录态」或者
// 「产品里还能继续读」的怪事。

import { useEffect, useRef, useState } from "react";
import { apiPath, productPath } from "./paths";

export interface SiteUser {
	name?: string;
	email: string;
	image?: string | null;
}

/** 主站地址取不到时的兜底(线上就是这个值)。 */
const FALLBACK_SITE = "https://nanisle.com";

const NAV = [
	{ href: "/products", label: "产品" },
	{ href: "/journal", label: "日志" },
	{ href: "/about", label: "关于" },
];

interface SiteInfo {
	/** 主站根地址(无尾斜杠),导航与登录链接都挂在它下面 */
	site: string;
	/** 主站的「打开产品」闸口:登录后会带手递 token 把人送回来 */
	loginUrl: string;
	user: SiteUser | null;
}

function useSiteInfo(): SiteInfo | null {
	const [info, setInfo] = useState<SiteInfo | null>(null);

	useEffect(() => {
		let alive = true;
		void (async () => {
			let site = FALLBACK_SITE;
			let loginUrl = `${FALLBACK_SITE}/api/launch/watch-router`;
			let user: SiteUser | null = null;

			try {
				const res = await fetch(apiPath("health"));
				if (res.ok) {
					const h = (await res.json()) as {
						site?: string;
						loginUrl?: string;
						email?: string | null;
					};
					if (h.site) site = h.site.replace(/\/+$/, "");
					if (h.loginUrl) loginUrl = h.loginUrl;
					if (h.email) user = { email: h.email };
				}
			} catch {
				// 网络故障也要把页眉画出来:字标和导航用兜底地址照常可点
			}

			// 已经认出人了才去问主站要名字/头像。独立跑产品(没有主站)时这步
			// 必然失败,上面的邮箱兜底已经够撑起圆标和下拉里的身份行。
			if (user) {
				try {
					const res = await fetch(`${site}/api/auth/get-session`, {
						credentials: "include",
					});
					if (res.ok) {
						const data = (await res.json()) as { user?: SiteUser } | null;
						if (data?.user?.email) user = data.user;
					}
				} catch {
					// 主站会话拿不到:退回只有邮箱的身份
				}
			}

			if (alive) setInfo({ site, loginUrl, user });
		})();
		return () => {
			alive = false;
		};
	}, []);

	return info;
}

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

/** 主站同款页眉。产品的每个状态(读、配置、锁屏、报错)都套着它。 */
export function SiteHeader() {
	const info = useSiteInfo();
	const site = info?.site ?? FALLBACK_SITE;

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
					{/* 身份还没问出来时占住位置,避免圆标出现时整条导航横跳 */}
					{!info ? (
						<span className="user-chip user-chip-ghost" aria-hidden />
					) : info.user ? (
						<UserMenu user={info.user} site={site} />
					) : (
						<a className="btn-line btn-login" href={info.loginUrl}>
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
