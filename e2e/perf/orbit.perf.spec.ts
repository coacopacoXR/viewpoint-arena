// e2e/perf/orbit.perf.spec.ts
//
// The benchmark every later perf task is measured against: how fast does the
// review scene orbit a large assembly, and what does one frame cost to draw?
//
// NOT part of `npm run test:e2e`. playwright.config.ts gives it its own project
// (`npm run perf`) because it takes minutes, because its numbers mean nothing
// next to numbers from a different machine, and because a red row on a slow CI
// runner would say nothing was wrong. It is run on purpose, by a person who is
// about to change the renderer and wants the before-and-after.
//
// WHAT IT DRIVES. A real room, admitted by a real room server, against a real
// model api — scripts/perf/serve.mjs runs both, and playwright.config.ts starts
// it. The fixture goes in through the same hidden <input type="file"> that the
// "Import 3D Model" button opens, so the whole client path is measured:
// validate, upload, hash, parse, store, broadcast, download, mount. The orbit is
// a real mouse drag on the canvas, so OrbitControls and everything that listens
// to a pointer move are inside the numbers too.
//
// WHAT IT REPORTS. Frame times come from components/Scene/PerfProbe.tsx, which
// the page mounts only for ?perf=1. Draw calls and triangles come from the
// WebGLRenderer's own counters — the two numbers a test cannot see from outside,
// and the two that say whether batching or instancing actually did anything.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import type { PerfRecording } from "../../components/Scene/PerfProbe";

// Resolved from the working directory rather than from import.meta: `npm run
// perf` runs from the repo root, which is where playwright.config.ts points
// testDir and where its webServer command runs `npm run build`.
const REPO_ROOT = process.cwd();
const FIXTURE_DIR = join(REPO_ROOT, "perf", "fixtures");
const RESULTS_DIR = join(REPO_ROOT, "perf", "results");
const GENERATOR = join(REPO_ROOT, "scripts", "perf", "make-assembly.mjs");

/** The generator's three presets. */
const ALL_PART_COUNTS = [800, 3200, 10000];

/**
 * `PERF_PARTS=800` narrows a run to one size.
 *
 * Not a convenience for impatience: importing the largest fixture is minutes on
 * its own, and somebody checking that a batching change moved the draw-call
 * count does not need to wait for it to prove that.
 */
const requested = (process.env.PERF_PARTS ?? "")
  .split(",")
  .map((raw) => Number.parseInt(raw.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const SIZES = requested.length > 0 ? requested : ALL_PART_COUNTS;

/** How long the camera is dragged for. */
const ORBIT_MS = 10_000;
/**
 * Pointer moves are paced rather than sent flat out. A drag arriving faster than
 * a real mouse can report would spend the frame budget on event dispatch instead
 * of on drawing, and the result would measure Playwright. Each move is also a
 * round trip that the page answers between frames, so this is a floor on the
 * interval, not a guarantee of it.
 */
const POINTER_INTERVAL_MS = 8;
/** How long one size may take to get its model on screen. */
const IMPORT_TIMEOUT_MS = 12 * 60_000;
/** Must match `viewport` on the perf project in playwright.config.ts. */
const VIEWPORT = { width: 1600, height: 900 };

/**
 * An empty room already draws a handful of triangles, so "the model is up" is a
 * threshold well above that and far below the smallest fixture's first part.
 */
const MODEL_VISIBLE_TRIANGLES = 1000;

const fixturePath = (parts: number) => join(FIXTURE_DIR, `assembly-${parts}.glb`);

const git = (args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    // A run outside a clone still produces numbers; it just cannot say which
    // commit they belong to.
    return "unknown";
  }
};

const gitSha = git(["rev-parse", "--short", "HEAD"]);
const gitBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const gitDirty = git(["status", "--porcelain"]) !== "";

// One file per day per commit, merged by part count, so re-running one size
// updates its entry instead of leaving two contradictory ones for the same tree.
const runDate = new Date().toISOString().slice(0, 10);
const resultsFile = join(RESULTS_DIR, `${runDate}-${gitSha}.json`);

interface FixtureResult {
  parts: number;
  fixtureBytes: number;
  timeToVisibleMs: number;
  frameCount: number;
  frameTimesMs: number[];
  medianFrameMs: number;
  p95FrameMs: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  heapBytes: number | null;
  gpu: PerfRecording["gpu"];
}

interface RunRecord {
  runAt: string;
  gitSha: string;
  gitBranch: string;
  gitDirty: boolean;
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    totalMemoryBytes: number;
    node: string;
  };
  browser: string;
  viewport: { width: number; height: number };
  orbitMs: number;
  results: FixtureResult[];
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Write one size's numbers into the run's JSON and append its row to the table in
 * perf/results/README.md.
 *
 * Read-modify-write rather than overwrite: each size is its own test and they run
 * one after another in a single worker, so the second has to keep the first.
 */
function record(result: FixtureResult, browser: string): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const envelope = {
    runAt: new Date().toISOString(),
    gitSha,
    gitBranch,
    gitDirty,
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model?.trim() ?? "unknown",
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    browser,
    viewport: VIEWPORT,
    orbitMs: ORBIT_MS,
  };

  let run: RunRecord = { ...envelope, results: [] };
  if (existsSync(resultsFile)) {
    try {
      const previous = JSON.parse(readFileSync(resultsFile, "utf8")) as RunRecord;
      // This run's envelope wins and only the results are carried over: the file
      // describes the machine and browser the rows were measured on, and a row
      // appended now was measured now.
      run = {
        ...previous,
        ...envelope,
        results: previous.results.filter((entry) => entry.parts !== result.parts),
      };
    } catch {
      // A file half-written by a run somebody killed. Starting it again beats
      // failing every later size on an interrupted one.
    }
  }
  run.results.push(result);
  run.results.sort((a, b) => a.parts - b.parts);
  writeFileSync(resultsFile, `${JSON.stringify(run, null, 2)}\n`);

  // The GPU row is the short end of the renderer string: it is what makes two
  // rows comparable or not, and the full string is in the JSON beside it.
  const gpuShort = result.gpu.renderer
    .replace(/^ANGLE \(/, "")
    .replace(/\)$/, "")
    .split(",")
    .slice(0, 2)
    .join(",")
    .slice(0, 48);

  const row = [
    runDate,
    gitSha,
    String(result.parts),
    `${mb(result.fixtureBytes)} MB`,
    result.triangles.toLocaleString("en-US"),
    String(result.drawCalls),
    (result.timeToVisibleMs / 1000).toFixed(1),
    result.medianFrameMs.toFixed(2),
    result.p95FrameMs.toFixed(2),
    result.fps.toFixed(1),
    result.heapBytes === null ? "n/a" : mb(result.heapBytes),
    gpuShort,
  ].join(" | ");
  appendFileSync(join(RESULTS_DIR, "README.md"), `| ${row} |\n`);
}

/**
 * Build the fixture if it is not already there.
 *
 * The generator is seeded, so a file already at this path IS the file it would
 * write, and rebuilding 300 MB of GLB on every run would spend most of the
 * benchmark's time not measuring anything. Pass `--force` by hand to regenerate.
 */
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

test.describe("orbit a large assembly", () => {
  test.beforeAll(() => {
    // Built up front rather than inside each test: generating a fixture is
    // CPU-bound geometry work, and doing it while another size is being timed
    // would put the generator's load inside somebody's frame times.
    for (const parts of SIZES) ensureFixture(parts);
  });

  for (const parts of SIZES) {
    test(`${parts} parts`, async ({ page, browserName }) => {
      test.setTimeout(20 * 60_000);

      const fixture = fixturePath(parts);
      const fixtureBytes = statSync(fixture).size;

      // A room of its own per run. The room server persists its scene, so a room
      // an earlier benchmark left a model in would come back with that model
      // already mounted — a second import into a non-empty scene, and a first
      // frame that is not a first frame.
      const room = `perf-${parts}-${Date.now()}`;

      // The two things pages/RoomPage.tsx asks of an arrival before it admits it:
      // a name (nobody enters a room nameless) and the mark saying this browser
      // meant to come here, which is what stops the entry guard bouncing a direct
      // navigation back to the lobby. Written before any page script runs, the
      // way lib/reviews/openLine.ts writes the mark on the way in.
      await page.context().addInitScript(
        ([roomId, name]) => {
          localStorage.setItem("vp_user", JSON.stringify({ name, color: "#4F8EF7" }));
          sessionStorage.setItem("vp_enteredRoom", roomId);
        },
        [room, "Perf Benchmark"],
      );

      await page.goto(`/room/${room}?perf=1`, { waitUntil: "domcontentloaded" });
      // The probe lives inside the review canvas, so it appearing at all says the
      // room was admitted and its scene mounted — a room stuck in its waiting room
      // has no canvas and would otherwise fail later with a much vaguer message.
      await page.waitForFunction(() => typeof window.__vpPerf !== "undefined", undefined, {
        timeout: 120_000,
      });

      // ── import through the real file input ────────────────────────────────
      const pickedAt = Date.now();
      await page.setInputFiles('input[type="file"]', fixture);

      // An empty scene imports straight in; the chooser appears only when the
      // scene already holds a model. Answering it is part of the user's path, so
      // it is answered rather than waited away. Polled rather than raced: two
      // Playwright waits in a Promise.race leave the loser to reject on its own,
      // and that rejection lands after the race has been won and settled.
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
      expect(
        onScreen,
        `the ${parts}-part fixture never reached the renderer within ${IMPORT_TIMEOUT_MS / 60000} min`,
      ).toBe(true);
      const timeToVisibleMs = Date.now() - pickedAt;

      // Let the first frames settle: buffers and textures upload on the frames
      // just after a model mounts, and timing those would report the upload
      // rather than the orbit.
      await page.waitForTimeout(3000);

      // ── orbit ─────────────────────────────────────────────────────────────
      // Viewport coordinates rather than the canvas's bounding box. Asking
      // Playwright for a box round-trips through the page's main thread, which is
      // busy drawing, and on a heavy frame that call times out before it is
      // answered. The canvas is position:absolute inset 0, so it IS the viewport.
      const cx = VIEWPORT.width / 2;
      const cy = VIEWPORT.height / 2;
      const radiusX = VIEWPORT.width * 0.28;
      const radiusY = VIEWPORT.height * 0.18;

      await page.evaluate(() => window.__vpPerf?.start());
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      const orbitEndsAt = Date.now() + ORBIT_MS;
      let moves = 0;
      while (Date.now() < orbitEndsAt) {
        // Roughly three turns in ten seconds: an orbit somebody is looking at,
        // rather than one they are flicking through.
        const angle = (moves / 120) * Math.PI * 2;
        await page.mouse.move(cx + Math.cos(angle) * radiusX, cy + Math.sin(angle) * radiusY);
        moves += 1;
        await page.waitForTimeout(POINTER_INTERVAL_MS);
      }
      await page.mouse.up();

      const recording = await page.evaluate(() => window.__vpPerf?.stop());
      expect(recording, "the perf probe went away mid-orbit").toBeDefined();
      const rec = recording as PerfRecording;

      // ── report ────────────────────────────────────────────────────────────
      const frames = [...rec.frameTimesMs].sort((a, b) => a - b);
      expect(
        frames.length,
        `recorded no frames over ${moves} pointer moves — the render loop never turned`,
      ).toBeGreaterThan(0);

      const medianFrameMs = percentile(frames, 0.5);
      const p95FrameMs = percentile(frames, 0.95);
      // Rounded for the file rather than left as the floating point the sort
      // produced: 10.699999999254942 ms is 10.7 ms, and a diff between two runs
      // should show a change in the scene and not in the last eleven digits.
      const round3 = (n: number) => Number(n.toFixed(3));
      const result: FixtureResult = {
        parts,
        fixtureBytes,
        timeToVisibleMs,
        frameCount: frames.length,
        // Kept: a median and a p95 hide a stall, and the whole point of storing
        // the run is that somebody can re-read it without re-running it.
        frameTimesMs: rec.frameTimesMs.map(round3),
        medianFrameMs: round3(medianFrameMs),
        p95FrameMs: round3(p95FrameMs),
        fps: medianFrameMs > 0 ? round3(1000 / medianFrameMs) : 0,
        drawCalls: rec.renderer.calls,
        triangles: rec.renderer.triangles,
        geometries: rec.renderer.geometries,
        textures: rec.renderer.textures,
        programs: rec.renderer.programs,
        heapBytes: rec.memory?.usedJSHeapSize ?? null,
        gpu: rec.gpu,
      };
      record(result, `${browserName} ${page.context().browser()?.version() ?? ""}`.trim());

      console.log(
        `\n[perf] ${parts} parts — ${result.triangles.toLocaleString("en-US")} triangles, ` +
          `${result.drawCalls} draw calls, on screen after ${(timeToVisibleMs / 1000).toFixed(1)}s\n` +
          `[perf]   median ${medianFrameMs.toFixed(2)} ms  p95 ${result.p95FrameMs.toFixed(2)} ms  ` +
          `${result.fps.toFixed(1)} FPS over ${frames.length} frames\n` +
          `[perf]   heap ${result.heapBytes === null ? "n/a" : `${mb(result.heapBytes)} MB`}  ` +
          `gpu ${rec.gpu.renderer}\n` +
          `[perf]   → ${resultsFile}\n`,
      );

      // What makes this fixture the right thing to measure: every part is its own
      // mesh with its own geometry, so nothing is shared and nothing is batched.
      // Checked on the geometry count rather than the draw-call count, because
      // frustum culling legitimately hides parts from an orbit while it cannot
      // hide their geometries from the renderer's memory.
      expect(result.geometries).toBeGreaterThanOrEqual(parts);
      expect(result.triangles).toBeGreaterThan(MODEL_VISIBLE_TRIANGLES);
    });
  }
});
