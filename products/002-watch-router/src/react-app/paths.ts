// 从 001 物理复制裁剪(002 是单视图,不需要 view 路由)。
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
