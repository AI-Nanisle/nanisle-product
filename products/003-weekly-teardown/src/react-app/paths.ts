// 从 002 物理复制。产品挂在主站子路径下,所有 URL(页面和 API)都要带上
// vite 的 BASE_URL 前缀——直接写 "/api/health" 会打到主站根,不会进产品 Worker。
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
