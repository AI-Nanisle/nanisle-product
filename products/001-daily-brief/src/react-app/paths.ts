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

export type ProductView = "brief" | "config";

export function viewFromPathname(pathname: string): ProductView {
	return pathname === productPath("config") || pathname.startsWith(`${productPath("config")}/`)
		? "config"
		: "brief";
}

export function pathForView(view: ProductView): string {
	return productPath(view);
}
