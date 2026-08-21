const base = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Build a browser-visible URL under the product's mounted base path. */
export function productPath(path = ""): string {
	const suffix = path.replace(/^\/+/, "");
	return suffix ? `${base}/${suffix}` : base || "/";
}

/** Build an API URL without leaking the internal Worker mount point. */
export function apiPath(path: string): string {
	return productPath(`api/${path.replace(/^\/+/, "")}`);
}

/**
 * 「刚花掉一次额度」的广播。花额度的地方(配置页的编辑调用)和显示额度的地方
 * (页眉的读数)隔着整棵组件树,为一个只读小数字铺一层 context 不划算——
 * 一个 window 事件就够,App.tsx 收到后重取 /api/usage。
 */
export const USAGE_CHANGED = "nanisle:usage-changed";

export type ProductView = "brief" | "notes" | "config";

export function viewFromPathname(pathname: string): ProductView {
	for (const view of ["config", "notes"] as const) {
		if (pathname === productPath(view) || pathname.startsWith(`${productPath(view)}/`)) return view;
	}
	return "brief";
}

export function pathForView(view: ProductView): string {
	return productPath(view);
}
