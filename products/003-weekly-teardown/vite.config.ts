import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	// 产品挂在主站的子路径下，资源引用必须带上这个前缀——不设的话
	// dist/client 里的 /assets/... 在 nanisle.com 上会 404（落到主站根）。
	base: "/products/weekly-teardown/",
	plugins: [react(), cloudflare(), tailwindcss()],
	// 5201 只供 localhost:3000 的开发代理访问（主仓 product-mounts.ts 登记的
	// devPort）。strictPort 锁死，禁止 Vite 静默漂移——001 在 5199、002 在 5200。
	server: { host: "localhost", port: 5201, strictPort: true },
});
