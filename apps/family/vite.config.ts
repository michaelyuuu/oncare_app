import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = { "/api": { target: process.env.ONCARE_API_PROXY_TARGET ?? "http://127.0.0.1:3000", rewrite: (path: string) => path.replace(/^\/api/, ""), ws: true } };
export default defineConfig({ plugins: [react()], server: { proxy }, preview: { proxy } });
