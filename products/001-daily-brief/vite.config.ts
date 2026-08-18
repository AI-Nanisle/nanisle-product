import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "/products/daily-brief/",
	plugins: [react(), cloudflare(), tailwindcss()],
	// 5199 只供 localhost:3000 的开发代理访问。禁止 Vite 静默漂移到
	// 5200，否则代理和产品进程会在两个不同端口上。
	server: { host: "localhost", port: 5199, strictPort: true },
});
