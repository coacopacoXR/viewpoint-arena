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
//
// TWO SCENARIOS, AND THEY DO NOT MEASURE THE SAME THING. `orbit` drags the camera
// and asks what a frame costs to DRAW, which is what batching, instancing and LOD
// move. `laser` holds the pointing laser engaged and sweeps the pointer across the
// model, which puts a whole-scene raycast AND everything a hit triggers — a
// selection, a tree row, a highlight overlay — inside every frame. An orbit never
// shows any of it, because an orbit does not raycast. Task 05 measured the pair and
// found the laser's cost is linear in PART COUNT rather than in triangles, which is
// the signature of the React side and not of the raycast; this scenario is how that
// claim is checked and how the fix is measured.
// Each scenario writes its own results file and its own table under perf/results/,
// because a row that did not say which of the two it was would be read against the
// wrong baseline. Both live in THIS file on purpose: playwright.config.ts sets
// `fullyParallel: false` per file and nothing pins the worker count, so a second
// perf spec file would run in a second worker and the two would measure each
// other's CPU — exactly what that setting is there to prevent.

import { test, expect, type Page } from "@playwright/test";
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
/** How long the pointer is swept across the model with the laser engaged. */
const LASER_SWEEP_MS = 10_000;
/**
 * How long the laser sweeps BEFORE the recording, untimed.
 *
 * The first part a sweep names is also the first thing that makes the Model Tree
 * expand its ancestors (components/UI/SceneTree.tsx), and an expanded model row
 * renders one DOM row per part of it — thousands of them, once, on the frame the
 * laser first lands. Without this warm-up that one-time mount lands inside the
 * timed window and the row reports a tree being built rather than a laser being
 * swept. It also brings up every highlight overlay the model can raise, so the
 * recording starts on the scene a person is actually in when they are pointing at
 * parts and noticing how smooth it is.
 */
const LASER_WARM_UP_MS = 4_000;
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
 * How long the camera is left alone to see whether the scene still draws itself.
 *
 * The other half of "cheaper frames while the camera moves": a scene that renders on demand
 * costs NOTHING while nobody moves, and a scene that renders always costs a full frame every
 * interval whether or not one pixel of it changed. The orbit rows above cannot tell those two
 * apart — both are being dragged, so both draw every frame — so the orbit scenario also counts
 * the frames the renderer produces over this window with no input at all. It is a GPU-usage
 * proxy rather than a GPU measurement: `renderer.info.render.frame` is three's own count of
 * `WebGLRenderer.render` calls, which is the only thing this page can see from inside, and one
 * standard-view frame is exactly one of those.
 */
const IDLE_WINDOW_MS = 5_000;

/**
 * How long the pointer is left still before that count starts.
 *
 * OrbitControls runs with `enableDamping`, so a released drag keeps moving the camera — and
 * keeps asking for frames — for a few hundred milliseconds after `mouse.up()`. Counting those
 * would report the tail of the orbit as an idle scene. 1.5 s is well past a `dampingFactor` of
 * 0.1 converging and costs the run a second and a half.
 */
const IDLE_SETTLE_MS = 1_500;

/**
 * An empty room already draws a handful of triangles, so "the model is up" is a
 * threshold well above that and far below the smallest fixture's first part.
 */
const MODEL_VISIBLE_TRIANGLES = 1000;

/**
 * How many draw calls one orbiting frame may cost, at any fixture size.
 *
 * Chosen before the batched run was measured, from what the model should cost rather than
 * from what it did cost: task 04b stage 4 draws a model above BATCH_MIN_PARTS as one
 * BatchedMesh per material, and scripts/perf/make-assembly.mjs gives its parts six
 * finishes, so the product is a handful of calls and the rest is the room's own. Two
 * hundred leaves room for every material to differ, for the parts batching has to refuse,
 * and for the scene — and it still fails the pre-batching baseline (3 202 calls at 3 200
 * parts, 10 002 at 10 000) by more than an order of magnitude, which is the regression it
 * is here to catch.
 */
const DRAW_CALL_BUDGET = 200;

const fixturePath = (parts: number) => join(FIXTURE_DIR, `assembly-${parts}.glb`);

/**
 * Move the pointer across the model for `ms` and say how many moves that took.
 *
 * A Lissajous rather than a circle, so the sweep covers an area of the model instead of
 * tracing one ring through it: a ray that never leaves the same few parts would report the
 * best case of whatever it is being measured against and not its ordinary one.
 */
async function sweep(
  page: Page,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  ms: number,
): Promise<number> {
  const endsAt = Date.now() + ms;
  let moves = 0;
  while (Date.now() < endsAt) {
    const t = moves / 70;
    await page.mouse.move(cx + Math.sin(t * 2.0) * radiusX, cy + Math.sin(t * 3.1) * radiusY);
    moves += 1;
    await page.waitForTimeout(POINTER_INTERVAL_MS);
  }
  return moves;
}

/** What the idle window saw: how many frames the renderer drew, and over how long. */
interface IdleMeasurement {
  frames: number;
  windowMs: number;
  /**
   * The triangles in the last frame the renderer drew before it went quiet.
   *
   * Which, on a scene that renders on demand and hides small parts while the camera moves, is the
   * frame the SETTLE drew — and so is the proof the parts came back. A cull that never restored
   * would leave this at the moving frame's count and the orbit's own numbers would look better
   * than the room does: a benchmark that quietly stopped drawing a third of the model is exactly
   * the kind that flatters itself, and this is the number that stops it.
   */
  triangles: number;
}

/**
 * Count the frames the scene draws with no input at all.
 *
 * Read off the renderer's own counter rather than off a `requestAnimationFrame` in the page:
 * rAF keeps ticking under `frameloop="demand"` for as long as anything invalidates, and what
 * the number is meant to say is how much GPU work an untouched room does, which is the count
 * of actual `render()` calls. Two samples of `renderer.info.render.frame` around a wait, with
 * nothing in between them but time.
 */
async function measureIdle(page: Page): Promise<IdleMeasurement> {
  await page.waitForTimeout(IDLE_SETTLE_MS);
  const probe = () =>
    page.evaluate(() => {
      const renderer = window.__vpPerf?.renderer();
      return { frame: renderer?.frame ?? 0, triangles: renderer?.triangles ?? 0 };
    });
  const before = await probe();
  const startedAt = Date.now();
  await page.waitForTimeout(IDLE_WINDOW_MS);
  const after = await probe();
  return {
    frames: Math.max(0, after.frame - before.frame),
    windowMs: Date.now() - startedAt,
    triangles: after.triangles,
  };
}

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

/**
 * Which of the two measurements a row is.
 *
 * Kept apart in the FILENAME and not in a column, so that the orbit results a previous task
 * committed stay exactly where they were and still merge by part count on a re-run. Two
 * scenarios in one file would have needed a column the existing five rows do not have.
 */
type Scenario = "orbit" | "laser";

// One file per day per commit per scenario, merged by part count, so re-running one size
// updates its entry instead of leaving two contradictory ones for the same tree. The orbit
// name is the one this file has always written, unchanged, so the runs already in
// perf/results/ are still the ones a new orbit run merges into.
const runDate = new Date().toISOString().slice(0, 10);
const resultsFileFor = (scenario: Scenario) =>
  join(RESULTS_DIR, scenario === "orbit" ? `${runDate}-${gitSha}.json` : `${runDate}-${gitSha}-${scenario}.json`);
/** The markdown table a scenario appends its rows to. */
const tableFor = (scenario: Scenario) =>
  join(RESULTS_DIR, scenario === "orbit" ? "README.md" : `${scenario}.md`);

/**
 * The head of `laser.md`, written by `record` the first time the file is missing.
 *
 * Not hand-kept the way README.md's table is: the orbit table is the one this benchmark has
 * always written and its prose has grown around five committed rows, while the laser table
 * is new enough that a scenario which could not create it would append its rows to nothing
 * at all.
 */
const LASER_TABLE_HEADER = `# Laser sweep — what pointing at a large assembly costs

Appended by the second scenario in
[../../e2e/perf/orbit.perf.spec.ts](../../e2e/perf/orbit.perf.spec.ts): the same fixtures
with the pointing laser held up and the pointer swept across the model's own projected box,
so that everything a hit triggers — the raycast, the selection it writes, the tree rows and
highlight overlays that follow it — lands inside the frame times.

Do not compare a row here with one in [README.md](./README.md): that table orbits, which
never raycasts and never selects, so its frames are what a picture costs to DRAW and these
are what one costs to POINT AT. Same machine, same browser, close in time, or the pair means
nothing.

| date | git sha | parts | tris | calls | visible s | median ms | p95 ms | FPS | heap MB | gpu |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
`;

interface FixtureResult {
  scenario: Scenario;
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
  /**
   * Frames drawn with no input, over IDLE_WINDOW_MS — the orbit scenario only.
   *
   * Null rather than absent on the rows written before it existed, and null on a laser row
   * because that scenario never stops moving the pointer: a laser sweep has no idle half to
   * measure, and a zero there would read as "the scene went quiet" when it was swept the
   * whole time.
   */
  idle: IdleMeasurement | null;
}

interface RunRecord {
  runAt: string;
  scenario: Scenario;
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
  /**
   * How long the measured window ran, in ms. Was `orbitMs`, renamed when the laser scenario
   * joined: a laser run does not orbit, and a field called `orbitMs` holding ten seconds of
   * pointer sweep would be a small lie in a file whose whole purpose is to be re-read later.
   * The orbit runs committed before the rename still say `orbitMs` and still mean this.
   */
  windowMs: number;
  results: FixtureResult[];
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Write one size's numbers into its scenario's JSON and append its row to that scenario's
 * table under perf/results/.
 *
 * Read-modify-write rather than overwrite: each size is its own test and they run
 * one after another in a single worker, so the second has to keep the first.
 */
function record(result: FixtureResult, browser: string): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const resultsFile = resultsFileFor(result.scenario);

  const envelope = {
    runAt: new Date().toISOString(),
    scenario: result.scenario,
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
    windowMs: result.scenario === "orbit" ? ORBIT_MS : LASER_SWEEP_MS,
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

  const tail = [
    result.medianFrameMs.toFixed(2),
    result.p95FrameMs.toFixed(2),
    result.fps.toFixed(1),
    result.heapBytes === null ? "n/a" : mb(result.heapBytes),
    gpuShort,
  ];
  // README.md's orbit table predates the laser scenario and its committed rows stay exactly
  // as they were written, so the two tables differ in one column: an orbit says how big the
  // FILE was, a laser says how many triangles were drawn. Neither carries the other's, and a
  // laser row has no fixture column because the fixture is the same file the orbit row named.
  const row =
    result.scenario === "laser"
      ? [
          runDate,
          gitSha,
          String(result.parts),
          result.triangles.toLocaleString("en-US"),
          String(result.drawCalls),
          (result.timeToVisibleMs / 1000).toFixed(1),
          ...tail,
        ].join(" | ")
      : [
          runDate,
          gitSha,
          String(result.parts),
          `${mb(result.fixtureBytes)} MB`,
          result.triangles.toLocaleString("en-US"),
          String(result.drawCalls),
          (result.timeToVisibleMs / 1000).toFixed(1),
          ...tail,
          // LAST rather than beside the frame times, so the five committed rows above it stay
          // exactly as they were written and simply read as one cell short. The column is the
          // idle half of the run — frames drawn with no input — and it belongs to the orbit
          // table alone.
          result.idle ? String(result.idle.frames) : "",
        ].join(" | ");

  const table = tableFor(result.scenario);
  if (result.scenario === "laser" && !existsSync(table)) writeFileSync(table, LASER_TABLE_HEADER);
  appendFileSync(table, `| ${row} |\n`);
  return resultsFile;
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

/**
 * Admit a fresh room, import the fixture through the real file input, and wait for its
 * triangles to reach the renderer. Answers the seconds from picking the file to the model
 * being drawn.
 *
 * Shared by both scenarios because both need the same arrival, and because the arrival is
 * most of a test's runtime: the whole client path (validate, upload, hash, parse, store,
 * broadcast, download, mount) into a room no earlier run left a model in.
 */
async function importFixture(page: Page, parts: number): Promise<number> {
  const fixture = fixturePath(parts);

  // A room of its own per run. The room server persists its scene, so a room an earlier
  // benchmark left a model in would come back with that model already mounted — a second
  // import into a non-empty scene, and a first frame that is not a first frame. The scenario
  // is in the id too, so the two runs of one size cannot land in the same room even if the
  // clock ticks over between them.
  const room = `perf-${parts}-${Date.now()}`;

  // The two things pages/RoomPage.tsx asks of an arrival before it admits it: a name
  // (nobody enters a room nameless) and the mark saying this browser meant to come here,
  // which is what stops the entry guard bouncing a direct navigation back to the lobby.
  // Written before any page script runs, the way lib/reviews/openLine.ts writes the mark on
  // the way in.
  await page.context().addInitScript(
    ([roomId, name]) => {
      localStorage.setItem("vp_user", JSON.stringify({ name, color: "#4F8EF7" }));
      sessionStorage.setItem("vp_enteredRoom", roomId);
    },
    [room, "Perf Benchmark"],
  );

  await page.goto(`/room/${room}?perf=1`, { waitUntil: "domcontentloaded" });
  // The probe lives inside the review canvas, so it appearing at all says the room was
  // admitted and its scene mounted — a room stuck in its waiting room has no canvas and
  // would otherwise fail later with a much vaguer message.
  await page.waitForFunction(() => typeof window.__vpPerf !== "undefined", undefined, {
    timeout: 120_000,
  });

  // ── import through the real file input ────────────────────────────────────
  const pickedAt = Date.now();
  await page.setInputFiles('input[type="file"]', fixture);

  // An empty scene imports straight in; the chooser appears only when the scene already
  // holds a model. Answering it is part of the user's path, so it is answered rather than
  // waited away. Polled rather than raced: two Playwright waits in a Promise.race leave the
  // loser to reject on its own, and that rejection lands after the race has been won and
  // settled.
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

  // Let the first frames settle: buffers and textures upload on the frames just after a
  // model mounts, and timing those would report the upload rather than the scenario.
  await page.waitForTimeout(3000);
  return timeToVisibleMs;
}

/**
 * Turn one recording into a row, write it where its scenario's rows go, and say what was
 * written.
 *
 * Shared for the same reason the import is: the two scenarios differ in what they DRIVE, not
 * in what they report, and two copies of a percentile calculation are two chances to publish
 * a p95 that is not one.
 */
function summarise(
  scenario: Scenario,
  parts: number,
  fixtureBytes: number,
  timeToVisibleMs: number,
  moves: number,
  rec: PerfRecording,
  browser: string,
  idle: IdleMeasurement | null = null,
): FixtureResult {
  const frames = [...rec.frameTimesMs].sort((a, b) => a - b);
  expect(
    frames.length,
    `recorded no frames over ${moves} pointer moves — the render loop never turned`,
  ).toBeGreaterThan(0);

  const medianFrameMs = percentile(frames, 0.5);
  const p95FrameMs = percentile(frames, 0.95);
  // Rounded for the file rather than left as the floating point the sort produced:
  // 10.699999999254942 ms is 10.7 ms, and a diff between two runs should show a change in
  // the scene and not in the last eleven digits.
  const round3 = (n: number) => Number(n.toFixed(3));
  const result: FixtureResult = {
    scenario,
    parts,
    fixtureBytes,
    timeToVisibleMs,
    frameCount: frames.length,
    // Kept: a median and a p95 hide a stall, and the whole point of storing the run is that
    // somebody can re-read it without re-running it.
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
    idle,
  };
  const resultsFile = record(result, browser);

  console.log(
    `\n[perf:${scenario}] ${parts} parts — ` +
      `${result.triangles.toLocaleString("en-US")} triangles, ` +
      `${result.drawCalls} draw calls, on screen after ${(timeToVisibleMs / 1000).toFixed(1)}s\n` +
      `[perf:${scenario}]   median ${medianFrameMs.toFixed(2)} ms  p95 ${result.p95FrameMs.toFixed(2)} ms  ` +
      `${result.fps.toFixed(1)} FPS over ${frames.length} frames\n` +
      `[perf:${scenario}]   heap ${result.heapBytes === null ? "n/a" : `${mb(result.heapBytes)} MB`}  ` +
      `gpu ${rec.gpu.renderer}\n` +
      (idle
        ? `[perf:${scenario}]   idle: ${idle.frames} frames drawn in ${(idle.windowMs / 1000).toFixed(1)}s of no input\n`
        : "") +
      `[perf:${scenario}]   → ${resultsFile}\n`,
  );
  return result;
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

      const fixtureBytes = statSync(fixturePath(parts)).size;
      const timeToVisibleMs = await importFixture(page, parts);

      // ── orbit ─────────────────────────────────────────────────────────────
      // Viewport coordinates rather than the canvas's bounding box. Asking
      // Playwright for a box round-trips through the page's main thread, which is
      // busy drawing, and on a heavy frame that call times out before it is
      // answered. The canvas is position:absolute inset 0, so it IS the viewport.
      const cx = VIEWPORT.width / 2;
      const cy = VIEWPORT.height / 2;
      const radiusX = VIEWPORT.width * 0.28;
      const radiusY = VIEWPORT.height * 0.18;

      // What one frame draws with the camera standing still and nothing culled, which is the
      // number the settle has to come back to. Sampled outside the recording on purpose: the
      // recording's own last sample is a moving frame, and on a scene that hides small parts
      // while the camera moves the two are not the same number any more.
      const stillTriangles = await page.evaluate(
        () => window.__vpPerf?.renderer().triangles ?? 0,
      );

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

      // ── idle ──────────────────────────────────────────────────────────────
      // After the recording is stopped rather than inside it: the probe's own frame-time
      // samples would otherwise include five seconds of nothing happening, which would drag
      // a median towards whatever the wait cost and make the orbit number unreadable.
      const idle = await measureIdle(page);

      // ── report ────────────────────────────────────────────────────────────
      const result = summarise(
        "orbit",
        parts,
        fixtureBytes,
        timeToVisibleMs,
        moves,
        rec,
        `${browserName} ${page.context().browser()?.version() ?? ""}`.trim(),
        idle,
      );

      // ── the cull gave the parts back ──────────────────────────────────────
      // Three numbers from one run: what a frame drew standing still, what it drew while the
      // camera moved, and what the frame the SETTLE drew afterwards. The first and the last are
      // the same picture with nothing hidden and the middle one is not, which is the point of the
      // run. If the last ever equals the middle, the motion cull has stopped restoring, and every
      // orbit row below it is a flattering picture of a model with a third of its parts missing —
      // so this is asserted rather than only printed.
      console.log(
        `[perf:orbit]   triangles: ${stillTriangles.toLocaleString("en-US")} still, ` +
          `${rec.renderer.triangles.toLocaleString("en-US")} while moving, ` +
          `${idle.triangles.toLocaleString("en-US")} after the settle\n`,
      );
      expect(
        rec.renderer.triangles,
        `a frame drawn while orbiting the ${parts}-part fixture cost no fewer triangles than one ` +
          `drawn standing still (${stillTriangles}), so nothing was culled and the orbit's frame ` +
          `times are not measuring the motion work at all`,
      ).toBeLessThan(stillTriangles);
      expect(
        idle.triangles,
        `the frame the settle drew had ${idle.triangles.toLocaleString("en-US")} triangles and the ` +
          `one before the orbit had ${stillTriangles.toLocaleString("en-US")}: the motion cull did ` +
          `not give every part back when the camera stopped, so the room is sitting there with ` +
          `pieces of the model missing and the frame times above are describing that`,
      ).toBe(stillTriangles);

      // CHANGED BY TASK 04b STAGE 4, and the change is the point of the task rather than a
      // convenience. This asserted `geometries >= parts` — "every part is its own mesh with
      // its own geometry, so nothing is shared and nothing is batched" — which was a check
      // that the fixture was a fair thing to measure. Batching is what stage 4 adds, so that
      // is now exactly what must NOT hold: a model above BATCH_MIN_PARTS is drawn as one
      // BatchedMesh per material, its source geometries are merged into a few buffers and
      // freed, and `geometries` collapses towards the batch count. The baseline this replaced
      // is recorded in perf/results/2026-10-15-8481b9b.json — 10 013 geometries at 10 000
      // parts, one per part plus the room's own.
      //
      // What replaces it is the assertion the fixture was always really for: that a big
      // assembly costs a big-model NUMBER of draw calls and not one per part. Still read off
      // the renderer rather than off anything the app knows about itself, so it fails if
      // batching silently stops happening — and unlike a geometry count it cannot be satisfied
      // by frustum culling, which legitimately hides parts from an orbit.
      expect(result.drawCalls).toBeLessThan(DRAW_CALL_BUDGET);
      expect(result.triangles).toBeGreaterThan(MODEL_VISIBLE_TRIANGLES);
    });
  }
});

test.describe("sweep a laser across a large assembly", () => {
  test.beforeAll(() => {
    for (const parts of SIZES) ensureFixture(parts);
  });

  for (const parts of SIZES) {
    test(`${parts} parts`, async ({ page, browserName }) => {
      test.setTimeout(20 * 60_000);

      const fixtureBytes = statSync(fixturePath(parts)).size;
      const timeToVisibleMs = await importFixture(page, parts);

      /**
       * What components/Scene/UserLaser.tsx is doing, watched from inside the page.
       *
       * UserLaser draws a part-name label — one div, inline-styled — inside drei's <Html>,
       * and returns null entirely when the laser is down. So the div existing proves the
       * laser engaged, and text appearing in it proves a ray landed on a part AND a registry
       * named it. That second half is the assertion this scenario is really for: a sweep that
       * spent its ten seconds beside the model would still report a flattering frame rate
       * while pointing at nothing, and the row it wrote would be describing an idle scene.
       *
       * `hits` counts the samples that named one rather than only remembering the first, so
       * a sweep that grazed the model once in ten seconds says so instead of passing.
       *
       * Watched on the page's own clock rather than polled from Playwright, because when a
       * frame costs 200 ms the sweep manages a few dozen pointer moves in ten seconds and a
       * sample every 25th move is one or two chances to notice a label that was up the whole
       * time. 200 ms is 50 samples, and one `querySelectorAll` every 200 ms is inside the
       * noise of the frames being timed.
       */
      await page.evaluate(() => {
        const w = window as unknown as {
          __vpLaser?: { engaged: boolean; named: string; hits: number; scans: number };
          __vpLaserTimer?: ReturnType<typeof setInterval>;
        };
        const state = { engaged: false, named: "", hits: 0, scans: 0 };
        w.__vpLaser = state;
        w.__vpLaserTimer = setInterval(() => {
          state.scans += 1;
          const label = Array.from(document.querySelectorAll("div")).find(
            (d) => d.style.fontSize === "8px" && d.style.borderRadius === "3px",
          );
          if (!label) return;
          state.engaged = true;
          if (label.style.display === "none" || !label.textContent) return;
          state.hits += 1;
          if (state.named === "") state.named = label.textContent;
        }, 200);
      });
      const laserState = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __vpLaser?: { engaged: boolean; named: string; hits: number; scans: number };
              }
            ).__vpLaser ?? { engaged: false, named: "", hits: 0, scans: 0 },
        );

      // ── engage the laser ──────────────────────────────────────────────────
      // The P key rather than the mouse: UserLaser also engages on both buttons held
      // (its handler wants `e.buttons === 3` exactly), and a right-button press on
      // Windows brings a context menu that Playwright does not suppress.
      await page.keyboard.down("p");
      await expect
        .poll(async () => (await laserState()).engaged, {
          timeout: 20_000,
          message: "holding P did not engage the laser, so this run would time an idle scene",
        })
        .toBe(true);

      // ── aim at the model ──────────────────────────────────────────────────
      // WHERE THE SWEEP GOES, and why the answer is asked of the page instead of computed
      // from the viewport. The first version of this scenario swept a Lissajous of ±22% by
      // ±16% of the viewport around its centre and never named a part — not once, in ten
      // seconds and several hundred pointer moves. Nothing was wrong with the raycast. The
      // fixtures are normalised to two scene units on their longest axis (centerModel in
      // utils/modelLoader.ts) and rest on the floor, while the room's camera is fixed at
      // (8, 6, 8) looking at the origin, so the assembly is a sliver a hundred-odd pixels
      // across in the middle of a 1600 × 900 viewport and a few tens of pixels tall. A
      // sweep that wide spends nearly all of its moves on the floor beside the model, and a
      // ray that hits the floor costs nothing like a ray that hits a part — so the row it
      // wrote was measuring the empty half of the screen.
      //
      // `modelScreenRect` is the product's own projected box, measured the way the lobby
      // measures a thumbnail, so the sweep is inside the model by construction whatever the
      // fixture's proportions turn out to be. 0.42 rather than 0.5 of each half-axis
      // because the box is a silhouette: the model does not fill its own corners, and a
      // sweep that reached them would spend its extremes on empty space again.
      const rect = await page.evaluate(() => window.__vpPerf?.modelScreenRect() ?? null);
      expect(
        rect,
        "the room reported no product on screen, so there was nothing to sweep across",
      ).not.toBeNull();
      const box = rect!;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const radiusX = (box.width / 2) * 0.42;
      const radiusY = (box.height / 2) * 0.42;

      // ── warm up, untimed ──────────────────────────────────────────────────
      // See LASER_WARM_UP_MS. Counters are reset afterwards so what the row reports is the
      // timed sweep's answer and not the warm-up's.
      await sweep(page, cx, cy, radiusX, radiusY, LASER_WARM_UP_MS);
      await page.evaluate(() => {
        const state = (
          window as unknown as { __vpLaser?: { named: string; hits: number; scans: number } }
        ).__vpLaser;
        if (state) Object.assign(state, { named: "", hits: 0, scans: 0 });
      });

      // ── sweep ─────────────────────────────────────────────────────────────
      // THE CAMERA DOES NOT MOVE, AND CANNOT. components/Scene/ViewpointCanvas.tsx sets
      // `enabled={!isLaserActive && !drawingInteractionActive}` on its OrbitControls, so the
      // frame the laser engages is the frame a mouse drag stops orbiting: the app does not
      // let one drag both spin the camera and move the pointer, and a benchmark that did both
      // would be timing something no user can do. What runs instead is everything the laser
      // frame does — UserLaser's raycast, the selection it writes, the tree and the overlays
      // that follow — with the pointer swept across the model. Compare these rows with each
      // other, not with the orbit table.
      await page.evaluate(() => window.__vpPerf?.start());
      const moves = await sweep(page, cx, cy, radiusX, radiusY, LASER_SWEEP_MS);
      await page.keyboard.up("p");

      // Watcher stopped before the recording is, so what is read back is the sweep's own
      // answer and nothing scans the DOM during the teardown.
      const laser = await page.evaluate(() => {
        const w = window as unknown as {
          __vpLaser?: { engaged: boolean; named: string; hits: number; scans: number };
          __vpLaserTimer?: ReturnType<typeof setInterval>;
        };
        if (w.__vpLaserTimer) clearInterval(w.__vpLaserTimer);
        return w.__vpLaser ?? { engaged: false, named: "", hits: 0, scans: 0 };
      });

      const recording = await page.evaluate(() => window.__vpPerf?.stop());
      expect(recording, "the perf probe went away mid-sweep").toBeDefined();
      const rec = recording as PerfRecording;

      // ── report ────────────────────────────────────────────────────────────
      const result = summarise(
        "laser",
        parts,
        fixtureBytes,
        timeToVisibleMs,
        moves,
        rec,
        `${browserName} ${page.context().browser()?.version() ?? ""}`.trim(),
      );
      console.log(
        `[perf:laser]   model ${box.width.toFixed(0)}×${box.height.toFixed(0)} px at ` +
          `(${box.left.toFixed(0)}, ${box.top.toFixed(0)}), swept ±${radiusX.toFixed(0)}×±${radiusY.toFixed(0)}\n` +
          `[perf:laser]   named a part in ${laser.hits}/${laser.scans} samples ` +
          `over ${moves} pointer moves — first: ${laser.named || "(never)"}\n`,
      );

      expect(
        laser.named,
        `the laser swept ${moves} times across the ${parts}-part fixture and never named a part — ` +
          `the frame times above would be measuring a ray that hit nothing. It was aimed at a ` +
          `${box.width.toFixed(0)}×${box.height.toFixed(0)} px box at (${box.left.toFixed(0)}, ${box.top.toFixed(0)}).`,
      ).not.toBe("");
      expect(result.drawCalls).toBeLessThan(DRAW_CALL_BUDGET);
      expect(result.triangles).toBeGreaterThan(MODEL_VISIBLE_TRIANGLES);
    });
  }
});
