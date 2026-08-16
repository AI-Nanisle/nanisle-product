import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "/products/daily-brief/",
	plugins: [react(), cloudflare(), tailwindcss()],
	server: { port: 5199 },
});
