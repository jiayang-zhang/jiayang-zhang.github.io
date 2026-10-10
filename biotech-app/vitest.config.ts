import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
