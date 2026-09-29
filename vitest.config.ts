import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules/**", "e2e/**"],
    // The full suite (215 files) saturates the CPU, and at that load a test that
    // spawns install.sh or waits for a lazily loaded chunk can overrun vitest's
    // 5s default with nothing wrong in it. Each passes alone in well under a
    // second; these limits only stop load from failing them at random.
    testTimeout: 20_000,
    // lib/supabase.ts calls createClient at import time and throws without a
    // URL. Placeholders make the suite independent of a developer's .env.local,
    // which CI does not have. Nothing is ever sent to this host in tests.
    env: {
      VITE_SUPABASE_URL: "https://placeholder.supabase.test",
      VITE_SUPABASE_ANON_KEY: "placeholder-anon-key",
    },
  },
});
