// The view tools' cost — task 08b's half of the benchmark orbit.perf.spec.ts left open.
//
// WHAT IT MEASURES, per fixture size, in one arrival so an import is paid once:
//
//   · the orbit median with nothing on — the number every other row is read against;
//   · the orbit median with the cut on, with the explode at 0.6, and with both;
//   · the one-off hitch of turning the cut on, which is a shader recompile on every material
//     the model draws with and therefore a stall a person feels as the room freezing;
//   · the frame time of dragging the explode slider, which is the number that decides
//     whether a drag is one apply per tick or has to be coalesced to one per frame.
//
// The last of those is the one the task names. A slider step writes one matrix per part —
// three additions on a batched part's instance matrix, one position on an Object3D one — and
// then asks for a frame; what this measures is whether that whole round trip fits inside the
// frame the room was already drawing.
//
// HOW IT IS DRIVEN. Through the room's own control, by its test ids, the way a person drives
// it: the cut's switch, the explode's switch and slider. Not by calling `setExplode` from the
// page, because the thing being measured includes the store write, the component effect that
// turns it into registry calls, and the `invalidate()` that asks for the frame — and a number
// taken with any of those bypassed would be a number about none of them.
//
// WHERE THE NUMBERS GO. `perf/results/viewtools-<date>.json` and a row in
// `perf/results/viewtools.md`, beside the orbit and laser rows, so a change to the cut or the
// explode can be read against the machine's own history rather than against a memory of it.
//
// RUN. `npm run perf` picks this up by directory. On a machine where 4173 is somebody else's
// server, point it at your own built copy — the same one scripts/perf/serve.mjs serves:
//
//     VITE_PARTYKIT_HOST=localhost:1998 npm run build
//     PERF_PORT=4199 node --import tsx scripts/perf/serve.mjs
//     VP_PERF_APP=http://localhost:4199 npx playwright test e2e/perf/viewtools.perf.spec.ts \
//       --project=perf
//
// The override exists because playwright.config.ts owns 4173 and reuses whatever is already
// listening there, and a benchmark that measured a stale build would publish numbers about
// code nobody is running.

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Where the app under test is. The benchmark's own server by default; overridable because the
 * config reuses whatever already listens on 4173, and a stale build is a stale measurement.
 */
test.use({ baseURL: process.env.VP_PERF_APP ?? "http://localhost:4173" });

const REPO_ROOT = process.cwd();
const FIXTURE_DIR = join(REPO_ROOT, "perf", "fixtures");
const GENERATOR = join(REPO_ROOT, "scripts", "perf", "make-assembly.mjs");
const RESULTS_DIR = join(REPO_ROOT, "perf", "results");
const SIZES = [3200, 10000] as const;

/** The benchmark's own viewport; fill rate is part of what is measured. */
const VIEWPORT = { width: 1600, height: 900 };
/** Shorter than orbit.perf.spec.ts's ten seconds: four windows per size, and one arrival. */
const ORBIT_MS = 4000;
const POINTER_INTERVAL_MS = 16;
/** How many slider steps one drag is, and how long between them. */
const DRAG_STEPS = 12;
const DRAG_INTERVAL_MS = 60;
const IMPORT_TIMEOUT_MS = 12 * 60_000;
const MODEL_VISIBLE_TRIANGLES = 1000;

interface Recording {
  frameTimesMs: number[];
}

const fixturePath = (parts: number) => join(FIXTURE_DIR, `assembly-${parts}.glb`);

function ensureFixture(parts: number): string {
  const file = fixturePath(parts);
  if (existsSync(file)) return file;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  execFileSync(process.execPath, [GENERATOR, "--parts", String(parts)], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  expect(existsSync(file), `make-assembly.mjs did not write ${file}`).toBe(true);
  return file;
}

/**
 * One arrival, one import, one settle — copied in shape from orbit.perf.spec.ts's, because an
 * import that has not reached the renderer is a benchmark of an empty room.
 */
async function arrive(page: Page, parts: number): Promise<void> {
  const room = `perf-viewtools-${parts}-${Date.now()}`;
  await page.context().addInitScript(
    ([roomId, name]) => {
      localStorage.setItem("vp_user", JSON.stringify({ name, color: "#4F8EF7" }));
      sessionStorage.setItem("vp_enteredRoom", roomId);
    },
    [room, "Perf Benchmark"],
  );
  await page.goto(`/room/${room}?perf=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__vpPerf !== "undefined", undefined, {
    timeout: 120_000,
  });

  await page.setInputFiles('input[type="file"]', fixturePath(parts));
  const beside = page.locator('[data-testid="import-choice-beside"]');
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  const trianglesNow = () =>
    page.evaluate(() => window.__vpPerf?.renderer().triangles ?? 0).catch(() => 0);
  let onScreen = false;
  while (Date.now() < deadline && !onScreen) {
    if (await beside.isVisible().catch(() => false)) await beside.click();
    else if ((await trianglesNow()) > MODEL_VISIBLE_TRIANGLES) onScreen = true;
    else await page.waitForTimeout(250);
  }
  expect(onScreen, `the ${parts}-part fixture never reached the renderer`).toBe(true);
  // First frames upload buffers and textures; timing those would report the upload.
  await page.waitForTimeout(3000);
}

const median = (frames: number[]) => {
  const sorted = [...frames].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const p95 = (frames: number[]) => {
  const sorted = [...frames].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
};
const max = (frames: number[]) => frames.reduce((a, b) => Math.max(a, b), 0);

/** Record whatever `drive` does, and hand back the frames it drew. */
async function record(page: Page, drive: () => Promise<void>): Promise<Recording> {
  await page.evaluate(() => window.__vpPerf?.start());
  await drive();
  const recording = await page.evaluate(() => window.__vpPerf?.stop());
  expect(recording, "the perf probe went away mid-measurement").toBeDefined();
  return recording as Recording;
}

/** An orbit of the model, the same shape orbit.perf.spec.ts drags. */
async function orbit(page: Page): Promise<Recording> {
  const cx = VIEWPORT.width / 2;
  const cy = VIEWPORT.height / 2;
  const radiusX = VIEWPORT.width * 0.28;
  const radiusY = VIEWPORT.height * 0.18;
  return record(page, async () => {
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
  });
}

/** Open the view-tools popover, or leave it open if a measurement shut it. */
async function openTools(page: Page) {
  const popover = page.locator('[data-testid="view-tools-popover"]');
  if (await popover.isVisible().catch(() => false)) return;
  await page.click('[data-testid="view-tools-toggle"]');
  await popover.waitFor({ state: "visible", timeout: 5_000 });
}

async function closeTools(page: Page) {
  const popover = page.locator('[data-testid="view-tools-popover"]');
  if (!(await popover.isVisible().catch(() => false))) return;
  await page.click('[data-testid="view-tools-toggle"]');
  await popover.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
}

interface Row {
  size: number;
  config: string;
  frames: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

const rows: Row[] = [];

function push(size: number, config: string, rec: Recording) {
  rows.push({
    size,
    config,
    frames: rec.frameTimesMs.length,
    medianMs: median(rec.frameTimesMs),
    p95Ms: p95(rec.frameTimesMs),
    maxMs: max(rec.frameTimesMs),
  });
}

test.describe("the view tools' cost", () => {
  test.beforeAll(() => {
    for (const parts of SIZES) ensureFixture(parts);
  });

  for (const parts of SIZES) {
    test(`${parts} parts`, async ({ page }) => {
      test.setTimeout(20 * 60_000);
      await arrive(page, parts);

      // ── baseline ─────────────────────────────────────────────────────────
      push(parts, "baseline", await orbit(page));

      // ── the cut's one-off hitch ──────────────────────────────────────────
      // Recorded across the click and the seconds after it: the recompile happens on the
      // first frame drawn with the cap in the shader, on every material the model draws
      // with, and the stall is the number a person feels. The median of the same window is
      // not the hitch — it is the frames after it, which are ordinary.
      await openTools(page);
      const hitch = await record(page, async () => {
        await page.click('[data-testid="view-tools-cut-toggle"]');
        await page.waitForTimeout(3000);
      });
      await closeTools(page);
      push(parts, "cut-on hitch window", hitch);

      // ── orbit with the cut on ────────────────────────────────────────────
      push(parts, "cut on", await orbit(page));

      // ── the explode slider, dragged ──────────────────────────────────────
      // One apply per step, which is what the store's throttle hands the component: a
      // pointer-move, not a frame. If this window's median is far above the orbit's, the
      // drag is doing more per tick than a frame can hold and the apply has to move to one
      // per frame.
      await openTools(page);
      const drag = await record(page, async () => {
        await page.click('[data-testid="view-tools-explode-toggle"]');
        const slider = page.locator('[data-testid="view-tools-explode"]');
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          await slider.fill(String(Math.round((step / DRAG_STEPS) * 60)));
          await slider.dispatchEvent("pointerup");
          await page.waitForTimeout(DRAG_INTERVAL_MS);
        }
      });
      await closeTools(page);
      push(parts, "explode slider drag to 0.6", drag);

      // ── orbit exploded, and orbit with both ──────────────────────────────
      push(parts, "explode 0.6", await orbit(page));
      push(parts, "cut on + explode 0.6", await orbit(page));

      // ── leave the room assembled ─────────────────────────────────────────
      await openTools(page);
      await page.click('[data-testid="view-tools-explode-toggle"]');
      await page.click('[data-testid="view-tools-cut-toggle"]');
      await closeTools(page);
    });
  }

  test.afterAll(() => {
    if (rows.length === 0) return;
    mkdirSync(RESULTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = join(RESULTS_DIR, `viewtools-${date}.json`);
    const previous = existsSync(file) && statSync(file).size > 0
      ? JSON.parse(readFileSync(file, "utf8"))
      : [];
    writeFileSync(file, `${JSON.stringify([...previous, ...rows], null, 2)}\n`);

    const table = join(RESULTS_DIR, "viewtools.md");
    if (!existsSync(table)) {
      writeFileSync(
        table,
        "# View tools — frame times\n\n" +
          "Appended by e2e/perf/viewtools.perf.spec.ts. Read beside README.md's orbit table:\n" +
          "same machine, same fixtures, same render loop, one more thing turned on.\n\n" +
          "| parts | configuration | frames | median ms | p95 ms | max ms |\n" +
          "|---|---|---:|---:|---:|---:|\n",
      );
    }
    appendFileSync(
      table,
      rows
        .map(
          (row) =>
            `| ${row.size} | ${row.config} | ${row.frames} | ${row.medianMs.toFixed(2)} | ` +
              `${row.p95Ms.toFixed(2)} | ${row.maxMs.toFixed(2)} |`,
        )
        .join("\n") + "\n",
    );
    for (const row of rows) {
      console.log(
        `[perf:viewtools] ${row.size} parts — ${row.config}: ` +
          `median ${row.medianMs.toFixed(2)} ms  p95 ${row.p95Ms.toFixed(2)} ms  ` +
          `max ${row.maxMs.toFixed(2)} ms  (${row.frames} frames)\n`,
      );
    }
  });
});
