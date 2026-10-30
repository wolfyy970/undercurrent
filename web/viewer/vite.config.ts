import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The viewer is a client-only SPA (ssr:false). In dev it talks to the
// Headlong-TS data-layer server over /api — proxied here so the browser
// sees a single origin. Override the target with HEADLONG_API_URL.
const API_TARGET = process.env.HEADLONG_API_URL ?? "http://localhost:8787";

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    port: Number(process.env.VIEWER_PORT ?? 5273),
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  resolve: {
    // BUILD ONLY: pin the node build of react-dom's server renderer so the
    // SPA-shell prerender at the end of `react-router build` has
    // renderToPipeableStream (upstream needed this under bun). In DEV this
    // alias must NOT apply — server.node.js is CJS (`require`) and Vite's
    // ESM SSR module-runner chokes on it, 500ing the dev shell.
    alias:
      command === "build"
        ? [{ find: /^react-dom\/server$/, replacement: "react-dom/server.node" }]
        : [],
  },
}));
