import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "/products/watch-router/",
	plugins: [react(), cloudflare(), tailwindcss()],
	// 5200 只供 localhost:3000 的开发代理访问(主仓 product-mounts.ts 登记的
	// devPort)。strictPort 锁死,禁止 Vite 静默漂移——001 在 5199,互不占用。
	server: { host: "localhost", port: 5200, strictPort: true },
});
