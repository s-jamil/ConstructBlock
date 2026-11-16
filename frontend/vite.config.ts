import { defineConfig } from "vite";
const proxy = { "/api/documents": { target: "http://127.0.0.1:3002", changeOrigin: false }, "/api": { target: "http://127.0.0.1:3001", changeOrigin: false }, "/health": { target: "http://127.0.0.1:3001", changeOrigin: false } };
export default defineConfig({ server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy }, preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy } });
