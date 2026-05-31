import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "path";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routeFileIgnorePattern:
        "(^|/)(__tests__/.*|.*\\.(test|spec)\\.(ts|tsx)|.*\\.(components|treemap)\\.tsx)$",
    }),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@deckos/contracts": path.resolve(__dirname, "../contracts/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    hmr: {
      port: 5173,
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: (proxy, _options) => {
          const debugProxy = process.env.VITE_DEBUG_PROXY === "1";

          proxy.on("error", (err, _req, _res) => {
            console.warn("[vite] Proxy error:", err.message);
          });

          if (debugProxy) {
            proxy.on("proxyReq", (_proxyReq, req, _res) => {
              console.log(`[vite] Proxying ${req.url} to backend`);
            });
            proxy.on("proxyReqWs", (_proxyReq, req, _socket, _head, _res) => {
              console.log(`[vite] Proxying WebSocket ${req.url} to backend`);
            });
          }
        },
      },
    },
  },
});
