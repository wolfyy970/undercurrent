// Component tests run under vitest + jsdom, outside the react-router build
// (its vite plugin wants a full app context), so this config carries only
// the path alias the app code relies on.
//
// Run with `bun run test`. Not yet wired into CI: the viewer job in
// .github/workflows/ci.yml runs typecheck + build only, and workflow files
// can't be edited from this change — add `bun run test` there when touching
// CI next.
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
