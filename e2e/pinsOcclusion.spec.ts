// Comment bubbles and pins: under the panels, and behind the model — task 09a.
//
// WHAT THIS CHECKS THAT A UNIT TEST CANNOT. lib/scene/__tests__/markerLayers.test.ts reads
// the z-indexes back out of pages/RoomPage.tsx and components/UI/Interface.tsx and asserts
// the markers' range is under both, and lib/scene/__tests__/markerOcclusion.test.ts asserts
// the occlusion answer against a real Raycaster over real geometry. What neither can assert
// is that a browser actually PAINTS the panel over the bubble — which is a question about
// stacking contexts, drei's imperative element and the R3F canvas's own overflow — or that a
// bubble on the far side of a real model comes back faded from a real camera orbit.
//
// So the assertions here are about what is on screen:
//
//   • the z-index the browser wrote on each marker is a number under the room overlay's, and
//     `document.elementFromPoint` at the centre of a marker parked under the Model Tree
//     answers the Model Tree and not the marker — which is the bug the user reported, in the
//     only terms a browser will answer it in;
//   • of two comments, one placed on the face the camera can see and one on the face it
//     cannot, the hidden one is faded to the marker opacity and stopped taking clicks, and
//     the visible one is neither;
//   • the button on the call bar takes both off the canvas and puts both back, and the
//     Comments tab lists them the whole time.
//
// Review PINS are not placed here. Dropping one needs a curated review, the edit lock and the
// amber strip's pin mode, which is three more systems between this spec and the thing it is
// about; the pin's label is drawn by the same `useMarkerOccluded` and the same
// `MARKER_Z_RANGE` as the bubble, and components/Scene/__tests__/sceneMarkersHidden.test.tsx
// renders one and asserts both. What is here is the browser's answer for the family.
//
// NOT PART OF `npm run test:e2e`, for the reason e2e/viewToolsCut.spec.ts gives: that suite
// runs against a built preview on 4173 with no room server, and a room does not mount its
// scene until the room server admits it (lib/usePartyPresence.ts), so this check needs a
// `partykit dev` of the WORKING TREE. It is opt-in, and the header says how to run it:
//
//     npx partykit dev --port 1998
//     VITE_PARTYKIT_HOST=localhost:1998 npx vite --port 5199 --strictPort
//     VP_PINS_E2E=1 npx playwright test e2e/pinsOcclusion.spec.ts --project=chromium
//
// Port 1999 is a developer's own Docker partykit and is deliberately not touched.

import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Where the app under test is. A dev server of the working tree, not the built preview. */
const APP = process.env.VP_PINS_APP ?? "http://localhost:5199";

/** The report's own directory, which is where the task asks for the pictures. */
const SHOT_DIR = join(process.cwd(), "test-results", "pins-occlusion");

/**
 * The opacity a marker the model is hiding is faded to.
 *
 * A copy of lib/scene/markerLayers.ts's `MARKER_OCCLUDED_OPACITY` rather than an import of
// it: a Playwright spec runs in Node against a browser, and importing the app's module would
 * pull the store — and with it localStorage, PartyKit and the lot — into the spec's process
 * for one number. Asserted as a range rather than as equality because the browser composes
 * the marker's own 0.15 with the 0.92 the pin label carries, and because what the picture
// has to show is "faint", not "exactly this float".
 */
const OCCLUDED_OPACITY = 0.15;

/** Where the free canvas is, away from the Model Tree (x<300), the side panel (x>1100) and
 *  the bottom row (y>800). Every drag below starts here so it lands on the canvas and not on
 *  a panel that would swallow it. */
const CANVAS = { x: 620, y: 620 };

test.describe("comment markers under the panels and behind the model", () => {
  test.skip(
    process.env.VP_PINS_E2E !== "1",
    "needs a partykit dev of the working tree and a dev server on 5199 — see the header of this file",
  );
  test.setTimeout(300_000);

  test("a marker behind the model fades, a panel covers a marker, and one button hides them all", async ({
    browser,
  }) => {
    const room = `pins-${Date.now()}`;
    const host = await enterRoom(browser, room, "Olga Host");
    mkdirSync(SHOT_DIR, { recursive: true });

    try {
      await putASampleInRoom(host);
      await settle(host);
      await zoomIn(host);
      await settle(host);

      // ── two comments, one on each face ──────────────────────────────────────
      //
      // The bundled sample is a flat plate, so a horizontal orbit never puts a top-face
      // comment behind it — the plate's top face points at the sky from every azimuth. The
      // face that goes away is the one the camera leaves: the orbit below swings the camera
      // under the plate, which is what turns the first comment's face into the far one.
      const at = await modelCentre(host);
      await placeComment(host, "top face, hidden once the camera goes under", at);
      expect(await markerIds(host), "the first comment did not reach the canvas").toHaveLength(1);

      await orbitUnder(host, (await markerIds(host))[0]);
      await settle(host);
      // The same point on screen, which after the orbit is the plate's UNDERSIDE: the face
      // the camera is now looking at, while the first comment's face is the one it is not.
      await placeComment(host, "underside, visible", at);
      expect(await markerIds(host)).toHaveLength(2);
      await settle(host);

      const [first, second] = await markers(host);
      const hidden = first.occluded === "1" ? first : second;
      const shown = first.occluded === "1" ? second : first;
      // The pair is the whole feature. A check that only measured the faded one would pass
      // on a room where every marker faded, and one that only measured the visible one
      // would pass on a room where nothing did.
      expect(hidden.occluded, "neither comment ended up behind the model").toBe("1");
      expect(shown.occluded, "the comment in front of the model faded too").toBe("0");
      expect(hidden.opacity).toBeLessThanOrEqual(OCCLUDED_OPACITY + 0.01);
      expect(Number(shown.opacity)).toBeGreaterThan(0.9);
      // And not clickable: a faded bubble you can still open is the original complaint one
      // click further in.
      expect(hidden.pointerEvents).toBe("none");
      expect(shown.pointerEvents).not.toBe("none");
      await shot(host, "occluded");

      // ── under the panels ────────────────────────────────────────────────────
      //
      // The z-index is the mechanism and `elementFromPoint` is the consequence, and both are
      // asserted because each on its own has a hole: a number under 10 says nothing if the
      // marker turned out to be in a different stacking context, and a hit test says nothing
      // about WHY the panel won.
      for (const marker of await markers(host)) {
        const z = Number(marker.zIndex);
        expect(Number.isFinite(z), `a marker has no z-index: ${marker.zIndex}`).toBe(true);
        expect(z, "a marker is painted above the room's UI overlay").toBeLessThan(ROOM_OVERLAY_Z);
        expect(z, "a marker is painted behind the canvas it annotates").toBeGreaterThan(0);
      }
      expect(Number(await overlayZ(host))).toBe(ROOM_OVERLAY_Z);

      // Parked under the Model Tree, which is `pointer-events-auto` and therefore the one
      // panel a hit test can answer for: the side panel's own background is
      // `pointer-events-none`, so `elementFromPoint` looks straight through it and would
      // answer "the marker" however the two were painted.
      await parkUnderModelTree(host, hidden.commentId);
      const covering = await elementAtMarkerCentre(host, hidden.commentId);
      expect(covering.inModelTree, `the Model Tree did not cover the marker: ${covering.tag}`).toBe(
        true,
      );
      expect(covering.isMarker, "the marker is still on top of the Model Tree").toBe(false);
      await shot(host, "under-panel");

      // ── the button that hides them all ──────────────────────────────────────
      await host.page.getByTestId("toggle-scene-markers").click();
      await expect(host.page.getByTestId("comment-marker")).toHaveCount(0);
      await settle(host);
      await shot(host, "hidden");

      // The markers are a picture of the comments and the tab is the comments: hiding the
      // picture has to leave the list alone, or the switch reads as "delete them".
      await expect(host.page.getByText("top face, hidden once the camera goes under")).toBeVisible();
      await expect(host.page.getByText("underside, visible")).toBeVisible();

      await host.page.getByTestId("toggle-scene-markers").click();
      await expect(host.page.getByTestId("comment-marker")).toHaveCount(2);
      await settle(host);
      await shot(host, "shown-again");
    } finally {
      await host.context.close();
    }
  });
});

/**
 * The z-index pages/RoomPage.tsx lifts the whole UI overlay to.
 *
 * Repeated here rather than imported for the reason `OCCLUDED_OPACITY` is, and asserted
 * against the page below so the copy cannot drift: `overlayZ` reads the wrapper the Interface
 * is actually mounted in.
 */
const ROOM_OVERLAY_Z = 10;

/** What the browser painted on one marker, read off the elements drei built around it. */
interface Painted {
  commentId: string;
  occluded: string;
  opacity: number;
  zIndex: string;
  pointerEvents: string;
}

// ─── page-side helpers ────────────────────────────────────────────────────────

/**
 * The z-index the room's UI overlay is lifted to, from the element itself.
 *
 * Read from the DOM rather than out of the source file because the claim is about what the
 * browser built, and a class the build dropped would still be in the source.
 */
async function overlayZ(session: Session): Promise<string> {
  return session.page.evaluate(() => {
    // The overlay is the only absolutely positioned, full-bleed, pointer-transparent layer
    // the room mounts over the canvas; its z-index is the one a marker has to stay under.
    const candidates = [...document.querySelectorAll<HTMLElement>("body *")].filter(
      (el) => el.className === "absolute inset-0 z-10 pointer-events-none",
    );
    return candidates.length ? getComputedStyle(candidates[0]).zIndex : "";
  });
}

/** Every comment marker on screen, with what the browser painted on it. */
async function markers(session: Session): Promise<Painted[]> {
  return session.page.evaluate(() => {
    const read = (el: HTMLElement) => {
      // Walked up rather than read off one element because the marker's own div is React's
      // and the two around it are drei's, built imperatively and never reachable from a prop:
      // the middle one carries the opacity and the pointer-events this task writes, and the
      // outer one carries the z-index drei's own frame callback computes.
      //
      // The NEAREST inline value of each wins, not the outermost: `pointer-events` and
      // `opacity` are inherited and the marker div sets neither itself, so the outermost
      // would be some ancestor's default and would say nothing about the marker. `z-index`
      // is not inherited and only drei's element carries it, so nearest finds that too.
      let opacity = "";
      let zIndex = "auto";
      let pointerEvents = "";
      for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
        const style = node.style;
        if (!style) continue;
        if (opacity === "" && style.opacity !== "") opacity = style.opacity;
        if (zIndex === "auto" && style.zIndex !== "") zIndex = style.zIndex;
        if (pointerEvents === "" && style.pointerEvents !== "") pointerEvents = style.pointerEvents;
      }
      return {
        commentId: el.dataset.commentId ?? "",
        occluded: el.dataset.occluded ?? "",
        opacity: Number(opacity === "" ? 1 : opacity),
        zIndex,
        pointerEvents,
      };
    };
    return [...document.querySelectorAll<HTMLElement>('[data-testid="comment-marker"]')].map(read);
  });
}

async function markerIds(session: Session): Promise<string[]> {
  return (await markers(session)).map((marker) => marker.commentId);
}

/** What is topmost at the centre of one marker, and whether the Model Tree is it. */
async function elementAtMarkerCentre(
  session: Session,
  commentId: string,
): Promise<{ tag: string; inModelTree: boolean; isMarker: boolean }> {
  return session.page.evaluate((id) => {
    const marker = document.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
    if (!marker) return { tag: "no marker", inModelTree: false, isMarker: false };
    const box = marker.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!hit) return { tag: "nothing", inModelTree: false, isMarker: false };
    // The Model Tree's own column, found by the text its toggle button carries rather than
    // by a class the build may have hashed.
    const tree = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
      /model tree/i.test(button.textContent ?? ""),
    )?.parentElement;
    return {
      tag: hit.tagName.toLowerCase() + (hit.className ? `.${String(hit.className).slice(0, 40)}` : ""),
      inModelTree: Boolean(tree && tree.contains(hit)),
      isMarker: Boolean(hit.closest('[data-testid="comment-marker"]')),
    };
  }, commentId);
}

// ─── driving the room ─────────────────────────────────────────────────────────

/** Put one of the models that ship with the app on screen, through the room's own buttons. */
async function putASampleInRoom(session: Session) {
  await session.page.waitForSelector('[data-testid="empty-scene-prompt"]', { timeout: 90_000 });
  await session.page.getByRole("button", { name: /try a sample/i }).click();
  await session.page
    .getByTestId("empty-scene-prompt")
    .getByRole("button", { name: /synth assembly/i })
    .click();
  await session.page.waitForFunction(
    () => document.querySelector('[data-testid="empty-scene-prompt"]') === null,
    undefined,
    { timeout: 60_000 },
  );
  // The Comments tab is where a comment is armed and where its text is typed, so it has to be
  // the open tab before the first click on the model — the form renders inside it.
  await session.page.getByRole("button", { name: /^Comments/ }).first().click();
  await session.page.waitForSelector('[data-testid="toggle-scene-markers"]', { timeout: 30_000 });
}

/** Arm "Comment", click the model at `at`, and type the text into the form that appears. */
async function placeComment(session: Session, text: string, at: { x: number; y: number }) {
  await session.page.getByRole("button", { name: /^Comment$/ }).click();
  await session.page.waitForTimeout(300);
  await session.page.mouse.click(at.x, at.y);
  const box = session.page.getByPlaceholder(/Add a comment/);
  await box.waitFor({ state: "visible", timeout: 15_000 });
  await box.fill(text);
  await session.page.getByRole("button", { name: /Submit/ }).click();
  await session.page.waitForTimeout(400);
}

/**
 * Bring the model up to a size a screenshot can read.
 *
 * The room frames a two-unit model at a distance where it is a hundred pixels of a 1440×900
 * canvas, and a picture of a marker the size of a full stop is a picture of nothing. The same
 * wheel input e2e/viewToolsCut.spec.ts uses, at the middle of the free canvas.
 */
async function zoomIn(session: Session) {
  await session.page.mouse.move(720, 440);
  for (let step = 0; step < 8; step += 1) {
    await session.page.mouse.wheel(0, -240);
    await session.page.waitForTimeout(150);
  }
}

/**
 * Where the model's own pixels are on screen, as the centre of their bounding box.
 *
 * Measured from the canvas rather than assumed, because where a model lands depends on the
 * framing the room chose for it and on the zoom above. The predicate is "not the background
 * and not the floor grid": the room's background is a flat #f0f0f0 and the grid is two greys
 * near it, so anything warm or anything darker than both is the product.
 */
async function modelCentre(session: Session): Promise<{ x: number; y: number }> {
  const box = await session.page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>("canvas[data-engine]");
    if (!source) return null;
    return new Promise<{ x: number; y: number }>((resolve) => {
      const image = new Image();
      image.onload = () => {
        const scratch = document.createElement("canvas");
        scratch.width = image.naturalWidth;
        scratch.height = image.naturalHeight;
        const ctx = scratch.getContext("2d");
        if (!ctx) return resolve({ x: 0, y: 0 });
        ctx.drawImage(image, 0, 0);
        const px = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
        let minX = 1e9;
        let minY = 1e9;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < scratch.height; y += 2) {
          for (let x = 0; x < scratch.width; x += 2) {
            const i = (y * scratch.width + x) * 4;
            const r = px[i];
            const g = px[i + 1];
            const b = px[i + 2];
            const warm = r - b > 25;
            const dark = r < 150 && g < 150 && b < 160;
            if (!warm && !dark) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        const scale = source.clientWidth / scratch.width;
        resolve({ x: ((minX + maxX) / 2) * scale, y: ((minY + maxY) / 2) * scale });
      };
      image.src = source.toDataURL("image/png");
    });
  });
  if (!box || box.x <= 0) throw new Error("the model never reached the canvas");
  return { x: Math.round(box.x), y: Math.round(box.y) };
}

/**
 * Swing the camera under the model until the named marker reads as hidden.
 *
 * An UPWARD drag is OrbitControls' polar rotation the other way: the camera drops towards the
 * horizon and then below it, and a comment on the face the camera left goes behind the product
 * — which is the whole of what this spec is about, and the reason the loop stops on the
 * marker's own answer rather than on a fixed angle. The bundled sample is a flat plate, so a
 * horizontal orbit would never produce this: its top face points at the sky from every
 * azimuth.
 *
 * Bounded, because an orbit that cannot hide the marker has to fail the test rather than run
 * until the timeout does.
 */
async function orbitUnder(session: Session, commentId: string) {
  for (let step = 0; step < 8; step += 1) {
    await session.page.mouse.move(CANVAS.x, CANVAS.y);
    await session.page.mouse.down();
    await session.page.mouse.move(CANVAS.x, CANVAS.y - 60, { steps: 8 });
    await session.page.mouse.up();
    await session.page.waitForTimeout(1000);
    const hidden = (await markers(session)).find((marker) => marker.commentId === commentId);
    if (hidden?.occluded === "1") return;
  }
  throw new Error("eight orbits never put the first comment behind the model");
}

/**
 * Pan the model until one marker's centre is inside the Model Tree's box.
 *
 * Panned rather than assumed, because where a marker lands depends on the sample's shape, on
 * where the two clicks hit it and on how the camera framed it — none of which this spec
 * controls. A right drag is OrbitControls' pan, which moves the scene with the pointer, so
 * the delta to ask for is the delta measured. Bounded because a pan that cannot converge has
 * to fail the test rather than run until the timeout does.
 */
async function parkUnderModelTree(session: Session, commentId: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const geometry = await session.page.evaluate((id) => {
      const marker = document.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
      const tree = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
        /model tree/i.test(button.textContent ?? ""),
      )?.parentElement;
      if (!marker || !tree) return null;
      const a = marker.getBoundingClientRect();
      const b = tree.getBoundingClientRect();
      return {
        mx: a.x + a.width / 2,
        my: a.y + a.height / 2,
        // Just inside the tree's right edge rather than at its middle: a marker parked in
        // the middle of a 256px-wide panel drags the whole model off the left of the screen,
        // and a picture of an empty canvas with a panel on it shows nothing. Tucked under
        // the edge, the bubble is covered by the panel and the model it belongs to is still
        // in the shot.
        tx: b.right - 10,
        ty: b.y + b.height / 2,
      };
    }, commentId);
    if (!geometry) throw new Error("the marker or the Model Tree is not on screen");
    const dx = geometry.tx - geometry.mx;
    const dy = geometry.ty - geometry.my;
    // Tight, because the assertion that follows reads `elementFromPoint` at the marker's
    // centre and a marker parked four pixels proud of the panel edge is a marker the panel
    // is not covering.
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    // Clamped so one measurement error cannot throw the model off the canvas and out of the
    // picture the screenshot is for.
    const step = (value: number) => Math.max(-180, Math.min(180, value));
    await session.page.mouse.move(CANVAS.x, CANVAS.y);
    await session.page.mouse.down({ button: "right" });
    await session.page.mouse.move(CANVAS.x + step(dx), CANVAS.y + step(dy), { steps: 8 });
    await session.page.mouse.up({ button: "right" });
    await session.page.waitForTimeout(250);
  }
  throw new Error("could not park the marker under the Model Tree in twelve pans");
}

/** Give the canvas a moment to draw what the store just said. The room renders on demand. */
async function settle(session: Session) {
  await session.page.waitForTimeout(900);
}

/** A picture of the moment, in the report's own directory. */
async function shot(session: Session, name: string) {
  await session.page.screenshot({ path: join(SHOT_DIR, `pins-${name}.png`) });
}

interface Session {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}

/** One browser, in one room, with the two things pages/RoomPage.tsx asks of an arrival. */
async function enterRoom(browser: Browser, room: string, name: string): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ([roomId, who]) => {
      localStorage.setItem("vp_user", JSON.stringify({ name: who, color: "#4F8EF7" }));
      sessionStorage.setItem("vp_enteredRoom", roomId);
    },
    [room, name],
  );
  const page = await context.newPage();
  await page.goto(`${APP}/room/${room}`, { waitUntil: "domcontentloaded" });
  return { context, page };
}
