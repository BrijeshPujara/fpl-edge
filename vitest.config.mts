import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Must precede the "@" alias — Vite matches these in order.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Coverage is only meaningful for the deterministic engine. UI and I/O
      // are excluded so the number means something.
      include: [
        "lib/engine/**",
        "lib/fpl/gameweek.ts",
        "lib/format.ts",
        "lib/cron/**",
      ],
    },
  },
});
