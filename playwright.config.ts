import { defineConfig } from "@playwright/test";

// The perf benchmark is matched by its own directory rather than listed by name,
// so a spec added under e2e/perf/ later is picked up by `npm run perf` and kept
// out of `npm run test:e2e` without either project being edited.
const PERF_SPECS = "**/perf/**/*.perf.spec.ts";

/**
 * How the benchmark's browser is launched.
 *
 * Two separate problems, both invisible in the numbers until they are fixed:
 *
 * · Headless Chromium rasterises through SwiftShader unless it is told which GPU
 *   backend to use, and SwiftShader draws these assemblies at ~6 s a frame. That
 *   measures the software rasteriser, not the scene graph. On Windows,
 *   ANGLE-on-D3D11 is what gets a real GPU into headless.
 *
 * · With vsync on, a scene that draws in 4 ms reports a 16.7 ms frame, because
 *   that is the display's interval and not the frame's cost. The whole job of
 *   this benchmark is to tell a change that made rendering twice as fast from one
 *   that did nothing, and a number pinned to the refresh rate cannot. So the cap
 *   comes off and the median is the render loop's own cost.
 *
 * Overridable because both answers are per-machine: a Linux box with a GPU wants
 * `--use-angle=gl`, and a runner with no GPU at all wants nothing passed and
 * SwiftShader accepted. Whichever backend actually ran is recorded in the results
 * (components/Scene/PerfProbe.tsx reports it), so a row always says what drew it.
 */
const PERF_CHROMIUM_ARGS = process.env.PERF_CHROMIUM_ARGS
  ? process.env.PERF_CHROMIUM_ARGS.split(/\s+/).filter(Boolean)
  : [
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      ...(process.platform === "win32" ? ["--use-gl=angle", "--use-angle=d3d11"] : []),
    ];

/**
 * `npm run perf` is how this config learns it is being asked for the benchmark,
 * and the benchmark is the only thing that needs the two extra servers below.
 * Read off argv rather than an environment variable so the script in package.json
 * stays the plain `playwright test --project=perf`.
 */
const runningPerf = process.argv.some((arg) => arg.startsWith("--project=perf"));

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4173",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      // The benchmark is a measurement, not a test. It takes minutes, its numbers
      // only mean anything next to other numbers from the same machine, and a
      // slow CI runner would turn it red without anything being wrong.
      //
      // Two things keep it out of the default run, and both are needed. This
      // testIgnore stops the chromium project from picking the spec up; package.json's
      // `test:e2e` naming `--project=chromium` stops a bare `playwright test` from
      // running the perf project as well, which it otherwise would — Playwright runs
      // every project unless one is named.
      testIgnore: PERF_SPECS,
    },
    {
      name: "perf",
      testMatch: PERF_SPECS,
      use: {
        browserName: "chromium",
        launchOptions: { args: PERF_CHROMIUM_ARGS },
        // Fixed rather than whatever the developer's window happened to be: fill
        // rate is part of what is being measured, so two runs have to draw the
        // same number of pixels.
        viewport: { width: 1600, height: 900 },
      },
      // Importing a 100 MB assembly and then orbiting it for ten seconds, per
      // fixture size. The 60 s the smoke test needs is not enough for one size.
      timeout: 25 * 60_000,
      retries: 0,
      // Every spec in the file runs in order in one worker, which is what a
      // benchmark needs: two fixtures orbiting at once would each measure the
      // other's CPU. `fullyParallel` off keeps that true if the file grows.
      fullyParallel: false,
    },
  ],
  webServer: runningPerf
    ? [
        {
          // Not `vite preview`: an import does not reach the renderer without the
          // model api behind it, and preview answers /api/models with index.html.
          // See the comment at the top of scripts/perf/serve.mjs.
          command: "npm run build && node --import tsx scripts/perf/serve.mjs",
          port: 4173,
          timeout: 300_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          // A room is parked in its waiting room until the room server admits it
          // (lib/usePartyPresence.ts), and the scene — the thing being measured —
          // does not mount until then. Reused rather than restarted: partykit dev
          // keeps room state on disk and a benchmark wants a fresh room id, not a
          // fresh server.
          command: "npx --no-install partykit dev --port 1999",
          port: 1999,
          timeout: 180_000,
          reuseExistingServer: true,
        },
      ]
    : {
        command: "npm run build && npm run preview",
        port: 4173,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
});
