// e2e/perf/glow.perf.spec.ts
//
// Task 04c's probe: what does an orbit cost while the WHOLE model is selected, and what does
// that selection look like?
//
// The orbit scenario in orbit.perf.spec.ts never selects anything, so it cannot answer either
// question — and a whole-model selection is exactly the case MAX_OVERLAY_PARTS caps. This file
// imports the same fixture through the same file input, clicks the Model Tree's top row (which
// selects the model's root node and inherits downward, so every part of it is selected), takes
// a picture of the result and then orbits for the same ten seconds the benchmark does.
//
// NOT PART OF `npm run perf` UNLESS PERF_GLOW IS SET, and that is deliberate rather than tidy:
// orbit.perf.spec.ts explains at the top of itself that playwright.config.ts sets
// `fullyParallel: false` PER FILE and pins no worker count, so a second perf spec that runs
// would run in a second worker and the two would measure each other's CPU. Skipped by default,
// this file is picked up by the perf project's `testMatch` and still costs the benchmark
// nothing.
//
//   PERF_GLOW=1 PERF_GLOW_LABEL=before PERF_GLOW_PARTS=3200,10000 npm run perf
//
// The label is in the filenames because the point of the run is a pair: the same probe over the
// same fixture before and after the change it is measuring.

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PerfRecording } from "../../components/Scene/PerfProbe";

const REPO_ROOT = process.cwd();
const FIXTURE_DIR = join(REPO_ROOT, "perf", "fixtures");
/** Where the task asks for the pictures, and where the probe writes its own numbers. */
const REPORT_DIR = join(REPO_ROOT, ".qwen-tasks", "reports", "04c");

/** Must match `viewport` on the perf project in playwright.config.ts. */
const VIEWPORT = { width: 1600, height: 900 };
const ORBIT_MS = 10_000;
const POINTER_INTERVAL_MS = 8;
const IMPORT_TIMEOUT_MS = 12 * 60_000;
const MODEL_VISIBLE_TRIANGLES = 1000;

const LABEL = process.env.PERF_GLOW_LABEL ?? "run";
const SIZES = (process.env.PERF_GLOW_PARTS ?? "3200,10000")
  .split(",")
  .map((raw) => Number.parseInt(raw.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const fixturePath = (parts: number) => join(FIXTURE_DIR, `assembly-${parts}.glb`);
const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Admit a fresh room and import one fixture through the real file input.
 *
 * orbit.perf.spec.ts's `importFixture`, copied rather than imported: importing it would run
 * that file's top-level `test.describe` blocks inside this one, and the two files would then
 * each measure the other's fixtures. Copied without its reporting, because what this probe
 * reports is a selection and not an arrival.
 */
async function importFixture(page: Page, parts: number): Promise<void> {
  const fixture = fixturePath(parts);
  expect(existsSync(fixture), `${fixture} is missing — run scripts/perf/make-assembly.mjs`).toBe(true);

  const room = `glow-${parts}-${Date.now()}`;
  await page.context().addInitScript(
    ([roomId, name]) => {
      localStorage.setItem("vp_user", JSON.stringify({ name, color: "#4F8EF7" }));
      sessionStorage.setItem("vp_enteredRoom", roomId);
    },
    [room, "Glow Probe"],
  );

  await page.goto(`/room/${room}?perf=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__vpPerf !== "undefined", undefined, {
    timeout: 120_000,
  });

  await page.setInputFiles('input[type="file"]', fixture);

  const beside = page.locator('[data-testid="import-choice-beside"]');
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  const trianglesNow = () =>
    page.evaluate(() => window.__vpPerf?.renderer().triangles ?? 0).catch(() => 0);
  let onScreen = false;
  while (Date.now() < deadline && !onScreen) {
    if (await beside.isVisible().catch(() => false)) {
      await beside.click();
    } else if ((await trianglesNow()) > MODEL_VISIBLE_TRIANGLES) {
      onScreen = true;
    } else {
      await page.waitForTimeout(250);
    }
  }
  expect(onScreen, `the ${parts}-part fixture never reached the renderer`).toBe(true);
  await page.waitForTimeout(3000);
}

/**
 * Select the model's own row in the Model Tree, which is the click that selects every part.
 *
 * Through the UI rather than through the store, because the store is not published on
 * `window` and because this is the click the bug report is about: the top row of the tree
 * selects the model's root node, selection inherits downward, and every part of a 3 200-part
 * assembly becomes selected at once.
 */
async function selectWholeModel(page: Page): Promise<void> {
  // The tree is collapsed until its own button is pressed — components/UI/Interface.tsx.
  await page.getByRole("button", { name: /Model Tree/i }).click();
  const row = page.locator('[data-testid^="scene-model-row-"]').first();
  await row.waitFor({ state: "visible", timeout: 60_000 });
  await row.click();
  // The selection travels store → room server → registry, and the parts that answer it are
  // the overlays and flags this probe is here to look at. Given a moment rather than raced.
  await page.waitForTimeout(4000);
}

const describeGlow = process.env.PERF_GLOW ? test.describe : test.describe.skip;

describeGlow("orbit a large assembly with every part of it selected", () => {
  for (const parts of SIZES) {
    test(`${parts} parts`, async ({ page, browserName }) => {
      test.setTimeout(20 * 60_000);
      mkdirSync(REPORT_DIR, { recursive: true });

      await importFixture(page, parts);
      await selectWholeModel(page);

      const still = await page.evaluate(() => window.__vpPerf?.renderer());
      await page.screenshot({ path: join(REPORT_DIR, `${LABEL}-${parts}-selected.png`) });

      const cx = VIEWPORT.width / 2;
      const cy = VIEWPORT.height / 2;
      const radiusX = VIEWPORT.width * 0.28;
      const radiusY = VIEWPORT.height * 0.18;

      await page.evaluate(() => window.__vpPerf?.start());
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      const endsAt = Date.now() + ORBIT_MS;
      let moves = 0;
      while (Date.now() < endsAt) {
        const angle = (moves / 120) * Math.PI * 2;
        await page.mouse.move(cx + Math.cos(angle) * radiusX, cy + Math.sin(angle) * radiusY);
        moves += 1;
        await page.waitForTimeout(POINTER_INTERVAL_MS);
      }
      await page.mouse.up();

      const rec = (await page.evaluate(() => window.__vpPerf?.stop())) as PerfRecording;
      expect(rec, "the perf probe went away mid-orbit").toBeDefined();

      const frames = [...rec.frameTimesMs].sort((a, b) => a - b);
      const median = percentile(frames, 0.5);
      const p95 = percentile(frames, 0.95);
      const line =
        `[perf:glow:${LABEL}] ${parts} parts, whole model selected — ` +
        `median ${median.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms  ` +
        `fps ${(1000 / median).toFixed(1)} over ${frames.length} frames  ` +
        `calls ${rec.renderer.calls} (was ${still?.calls})  ` +
        `tris ${rec.renderer.triangles.toLocaleString("en-US")}  ` +
        `programs ${rec.renderer.programs} (was ${still?.programs})  ` +
        `textures ${rec.renderer.textures} (was ${still?.textures})  ` +
        `gpu ${rec.gpu.renderer}  browser ${browserName}`;
      console.log(`\n${line}\n`);

      // The picture is the deliverable this run exists for; the numbers go in the report by
      // hand rather than into perf/results/, which holds the two committed scenarios' tables
      // and would read a whole-model-selection row as an orbit one.
      expect(frames.length).toBeGreaterThan(0);
    });
  }
});
