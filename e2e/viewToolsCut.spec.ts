// The room's cut plane, in two browsers in one room — task 08a.
//
// WHAT THIS CHECKS THAT A UNIT TEST CANNOT. lib/scene/__tests__/cutPlane.test.ts asserts,
// against a real Raycaster and real materials, that the plane is resolved correctly and that
// every material a model can be drawn with ends up holding it. What it cannot assert is that
// a shader compiled with the cap in it actually DRAWS a section, and it cannot assert that the
// section one browser drags arrives on another browser's screen. Both are claims about a GPU
// and a websocket, and both are the reason this task exists.
//
// So the assertions here are about pixels and about two contexts agreeing:
//
//   • a model on screen leaves ink on the canvas, and a cut removes some of it — which is a
//     statement about what was drawn, not about what a material was set to;
//   • the two browsers agree on how much ink, to within a tolerance that allows for two
//     independent cameras settling and nothing else;
//   • moving the slider in one moves the section in the other, and the other's own control
//     says the new value without anybody touching it;
//   • turning the cut off gives both of them the whole model back.
//
// NOT PART OF `npm run test:e2e`. That suite runs against a built preview on 4173 talking to
// whatever room server is on 1999, and this check needs a `partykit dev` of the WORKING TREE
// — a room server that does not understand VIEW_TOOLS would relay nothing and the two
// contexts would silently disagree for a reason that has nothing to do with the cut. So it is
// opt-in, and the header says how to run it:
//
//     npx partykit dev --port 1998
//     VITE_PARTYKIT_HOST=localhost:1998 npx vite --port 5199 --strictPort
//     VP_VIEWTOOLS_E2E=1 npx playwright test e2e/viewToolsCut.spec.ts --project=chromium
//
// Both servers are started by hand rather than by a `webServer` entry because the repo's
// playwright.config.ts already owns 4173 and 1999, and 1999 is a developer's own room server:
// a check that restarted it would be a check that closed somebody's meeting.

import { test, expect, type Browser, type Page } from "@playwright/test";

/** Where the app under test is. A dev server of the working tree, not the built preview. */
const APP = process.env.VP_VIEWTOOLS_APP ?? "http://localhost:5199";

/**
 * How far apart two browsers' colour counts may be, as a fraction of the larger.
 *
 * Generous on purpose: the counts are small and antialiased, and what this file is really
 * asserting is presence and absence — the part on the cut side gone on both screens, the part
 * on the kept side there on both — which the zero-and-nonzero expectations beside each `agree`
 * do exactly. The tolerance is the backstop against the two browsers silently cutting
 * different sections.
 */
const INK_TOLERANCE = 0.35;

/**
 * Two measurements of the same thing on two screens, which is most of what this file is for.
 *
 * Relative, with a floor in pixels: the counts are small — a few dozen pixels of a saturated
 * colour at 320×180 — so a difference of two pixels on a count of four is antialiasing and
 * not a disagreement, while the same two pixels on a count of two hundred is one.
 */
function agree(actual: number, expected: number, what: string) {
  const floor = 6;
  const spread = Math.abs(actual - expected) / Math.max(actual, expected, floor);
  expect(spread, `${what}: ${actual} against ${expected}`).toBeLessThan(INK_TOLERANCE);
}

test.describe("the room's cut plane, in two browsers", () => {
  test.skip(
    process.env.VP_VIEWTOOLS_E2E !== "1",
    "needs a partykit dev of the working tree and a dev server on 5199 — see the header of this file",
  );
  // Two contexts, a websocket round trip, a shader compile and a sample model to mount. The
  // suite default is sized for a lobby page that loads and says its name.
  test.setTimeout(240_000);

  test("a cut one browser makes is the cut the other browser sees", async ({ browser }) => {
    const room = `viewtools-${Date.now()}`;
    const host = await enterRoom(browser, room, "Olga Host");
    const guest = await enterRoom(browser, room, "Ben Participant");

    try {
      // ── a model, and the second person in the room to see it cut ─────────────
      await putASampleInRoom(host);
      await shot(host, "whole-host");
      await hostGetsSomebodyIn(guest, host);
      await shot(guest, "whole-guest");

      // Settled like every later measurement: the camera is still flying in to frame the
      // sample here, and a reading mid-flight sees a bigger model than the one the cut is
      // later compared against.
      await settle(host, guest);
      const wholeOnHost = await palette(host);
      const wholeOnGuest = await palette(guest);
      // The sample's own colours, on both screens: the orange screen at the model's +X end
      // and the red knob at its −X end. These are the two things a cut along X decides
      // between, and they are saturated enough that nothing else in the room draws them.
      expect(wholeOnHost.orange, "the host's canvas has no model on it").toBeGreaterThan(0);
      expect(wholeOnHost.red).toBeGreaterThan(0);
      expect(wholeOnGuest.orange).toBeGreaterThan(0);
      expect(wholeOnGuest.red).toBeGreaterThan(0);
      expect(wholeOnHost.guide, "the plane guide is drawn before anybody cut").toBe(0);

      // ── the cut, made on one screen ─────────────────────────────────────────
      await host.page.locator('[data-testid="view-tools-toggle"]').click();
      await host.page.locator('[data-testid="view-tools-cut-toggle"]').click();

      // The guest was not touched and its control says the room is cutting. This is the
      // relay, and it is the assertion that fails first if the room server does not
      // understand VIEW_TOOLS — before any pixel does.
      await expect(guest.page.locator('[data-testid="view-tools-badge"]')).toHaveText(/^x50$/, {
        timeout: 15_000,
      });
      await expect(host.page.locator('[data-testid="view-tools-badge"]')).toHaveText(/^x50$/);
      // Pictures first, numbers second: when a number is wrong, the picture is what says
      // whether the cut drew at all — and a test that only screenshots past a passing
      // assertion keeps that diagnosis for the runs that did not need it.
      await shot(host, "cut-on-host");
      await shot(guest, "cut-on-guest");

      await settle(host, guest);
      const cutOnHost = await palette(host);
      const cutOnGuest = await palette(guest);
      // The part on the cut side is gone on BOTH screens, and the part on the kept side is
      // still there on both. That pair is the whole feature: a cut that removed everything
      // would pass a "less ink" assertion, and a cut that removed nothing would pass a
      // "the guide is drawn" one.
      expect(cutOnHost.orange, "the host still draws the half the cut took away").toBe(0);
      expect(cutOnGuest.orange, "the guest still draws the half the cut took away").toBe(0);
      expect(cutOnHost.red, "the cut took the host's whole model").toBeGreaterThan(0);
      expect(cutOnGuest.red, "the cut took the guest's whole model").toBeGreaterThan(0);
      // The guide, saying where the section is, on both.
      expect(cutOnHost.guide).toBeGreaterThan(0);
      expect(cutOnGuest.guide).toBeGreaterThan(0);
      // And the two screens agree about how much of each colour is left, which is the claim
      // that they are looking at the SAME section rather than at two different ones.
      agree(cutOnGuest.red, cutOnHost.red, "the kept side's red, host against guest");

      // ── the section moves in both, from a drag in one ───────────────────────
      await openTools(host);
      const slider = host.page.locator('[data-testid="view-tools-position"]');
      await slider.fill("25");
      // The release, which is what flushes the throttled send: store.ts's `setViewTools`
      // puts ~15 values a second on the wire and always the last one.
      await slider.dispatchEvent("pointerup");

      await expect(guest.page.locator('[data-testid="view-tools-badge"]')).toHaveText(/^x25$/, {
        timeout: 15_000,
      });
      await settle(host, guest);
      const movedOnHost = await palette(host);
      const movedOnGuest = await palette(guest);
      // A section at a quarter of the model keeps less of the dark body than a section at
      // half of it did, on both screens — the section moved, in both.
      expect(movedOnHost.dark, "the section did not move on the host").not.toBe(cutOnHost.dark);
      expect(movedOnGuest.dark, "the section did not move on the guest").not.toBe(cutOnGuest.dark);
      expect(movedOnHost.red).toBeGreaterThan(0);
      expect(movedOnGuest.red).toBeGreaterThan(0);
      agree(movedOnGuest.dark, movedOnHost.dark, "the body left at a quarter, host against guest");
      await shot(host, "cut-moved-host");
      await shot(guest, "cut-moved-guest");

      // ── the axis, which is the other half of the control ────────────────────
      await openTools(host);
      await host.page.locator('[data-testid="view-tools-axis-y"]').click();
      await expect(guest.page.locator('[data-testid="view-tools-badge"]')).toHaveText(/^y25$/, {
        timeout: 15_000,
      });
      // Flipped, so the cut keeps the TOP three quarters: an unflipped Y cut keeps the
      // bottom, and the orange screen lies on top of the base, so it would be cut away too.
      await host.page.locator('[data-testid="view-tools-flip"]').click();
      await settle(host, guest);
      // Cutting across Y instead of X puts the plane through a different set of parts: the
      // orange screen at the +X end comes back, because X is no longer the axis being cut
      // and the flipped Y cut keeps the top of the model, where the screen is.
      const axisOnHost = await palette(host);
      const axisOnGuest = await palette(guest);
      expect(axisOnHost.orange).toBeGreaterThan(0);
      expect(axisOnGuest.orange).toBeGreaterThan(0);
      agree(axisOnGuest.orange, axisOnHost.orange, "the +X end under a Y cut, host against guest");
      await shot(host, "cut-axis-host");
      await shot(guest, "cut-axis-guest");

      // ── and off again, on both ──────────────────────────────────────────────
      await openTools(host);
      await host.page.locator('[data-testid="view-tools-cut-toggle"]').click();
      await expect(host.page.locator('[data-testid="view-tools-badge"]')).toHaveCount(0);
      await expect(guest.page.locator('[data-testid="view-tools-badge"]')).toHaveCount(0, {
        timeout: 15_000,
      });

      await settle(host, guest);
      await shot(host, "cut-off-host");
      await shot(guest, "cut-off-guest");
      const backOnHost = await palette(host);
      const backOnGuest = await palette(guest);
      // Whole again on both, and the guide gone from both — which is the claim that turning
      // the cut off gives the materials back what the file brought rather than leaving a
      // section, and a plane, in them.
      expect(backOnHost.orange).toBeGreaterThan(0);
      expect(backOnGuest.orange).toBeGreaterThan(0);
      expect(backOnHost.guide, "the host kept drawing the plane guide").toBe(0);
      expect(backOnGuest.guide, "the guest kept drawing the plane guide").toBe(0);
      agree(backOnHost.dark, wholeOnHost.dark, "the host's model put back together");
      agree(backOnGuest.dark, wholeOnGuest.dark, "the guest's model put back together");
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });

  test("says why there is nothing to cut, in a room with no model", async ({ browser }) => {
    const room = `viewtools-empty-${Date.now()}`;
    const lone = await enterRoom(browser, room, "Olga Host");
    try {
      await lone.page.waitForSelector('[data-testid="empty-scene-prompt"]', { timeout: 90_000 });
      await lone.page.click('[data-testid="view-tools-toggle"]');

      // A disabled control on its own is the one state a person cannot diagnose, so the
      // reason is on screen and not only in a title attribute.
      await expect(lone.page.locator('[data-testid="view-tools-unavailable"]')).toContainText(
        /no model/i,
      );
      await expect(lone.page.locator('[data-testid="view-tools-cut-toggle"]')).toBeDisabled();
    } finally {
      await lone.context.close();
    }
  });
});

/** Put one of the models that ship with the app on screen, through the room's own buttons. */
async function putASampleInRoom(host: Session) {
  await host.page.waitForSelector('[data-testid="empty-scene-prompt"]', { timeout: 90_000 });
  await host.page.getByRole("button", { name: /try a sample/i }).click();
  // Scoped to the prompt: the Model Tree offers the same samples beside the canvas, and an
  // unscoped role lookup finds both and refuses to guess between them.
  await host.page
    .getByTestId("empty-scene-prompt")
    .getByRole("button", { name: /synth assembly/i })
    .click();
  // The prompt goes when the scene stops being empty, and ink appears when the model is
  // actually being drawn — which is not the same moment, and the second is the one the
  // assertions below are about.
  await host.page.waitForFunction(
    () => document.querySelector('[data-testid="empty-scene-prompt"]') === null,
    undefined,
    { timeout: 60_000 },
  );
  await waitForInk(host, "the host's sample model");
}

/** The second arrival is a knock under the room's default policy; the host lets them in. */
async function hostGetsSomebodyIn(guest: Session, host: Session) {
  const admit = host.page.getByRole("button", { name: /^admit$/i }).first();
  await admit.waitFor({ state: "visible", timeout: 60_000 });
  await admit.click();
  await guest.page.waitForSelector('[data-testid="view-tools-toggle"]', { timeout: 60_000 });
  // Its own model, from its own read of the room's scene — not a picture the host sent.
  await waitForInk(guest, "the guest's copy of the model");
}

/** One browser, in one room, with the two things pages/RoomPage.tsx asks of an arrival. */
interface Session {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}

async function enterRoom(browser: Browser, room: string, name: string): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Written before any page script runs, the way lib/reviews/openLine.ts writes the mark on
  // the way in: a name, because nobody enters a room nameless, and the mark that says this
  // browser meant to come here, which is what stops the entry guard bouncing a direct
  // navigation back to the lobby.
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

/**
 * How many pixels of each colour the test cares about are on the canvas.
 *
 * Counts of distinctive colours rather than a count of "not the background", because the
 * room draws a floor grid that sits twenty steps from the background and aliases differently
 * on every frame of every camera — a threshold low enough to see the model's white body also
 * sees the grid, and then the measurement is of the grid's settling rather than of the
 * section. The sample model's own saturated colours are unambiguous: nothing else in the
 * room draws them.
 *
 *   orange — the screen at the model's +X end, which a cut along X at 0.5 takes away
 *   red    — the knob at its −X end, which that cut keeps
 *   dark   — the body between them, whose count says where the section is
 *   guide  — the amber rectangle the cut draws where the plane is
 *
 * `preserveDrawingBuffer` is on in components/Scene/ViewpointCanvas.tsx, so the canvas can be
 * read between frames.
 */
interface Palette {
  orange: number;
  red: number;
  dark: number;
  guide: number;
}

async function palette(session: Session): Promise<Palette> {
  // The popover shut first, if it is open: it is a white panel full of black buttons over the
  // canvas, and a pixel count cannot tell what it covers from what is not there. The
  // measurement guarantees its own preconditions rather than asking every caller to remember
  // them, because forgetting one is a number that is wrong for a reason the assertion cannot
  // name.
  const popover = session.page.locator('[data-testid="view-tools-popover"]');
  if (await popover.isVisible().catch(() => false)) {
    await session.page.locator('[data-testid="view-tools-toggle"]').click();
    await popover.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  }
  return session.page.evaluate(async () => {
    // The three.js canvas and not just any canvas: R3F stamps `data-engine` on the one it
    // made, and the room also mounts a drawing canvas and a marker canvas that would answer
    // a bare `querySelector('canvas')` depending on what is open.
    const source = document.querySelector<HTMLCanvasElement>("canvas[data-engine]");
    const empty = { orange: 0, red: 0, dark: 0, guide: 0 };
    if (!source) return empty;
    const url = source.toDataURL("image/png");
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    // At the canvas's own resolution, not a downscale: the colours being counted are a few
    // dozen pixels of a small sample model at 1440×900, and averaging them into a thumbnail
    // blends an orange into a pink the predicates cannot tell from the knob beside it.
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const scratch = document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext("2d");
    if (!ctx) return empty;
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const counts = { ...empty };
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // Sampled from a real screenshot of the room (not guessed): the screen at the model's
      // +X end draws about (208,128,96), the knob at its −X end about (240,176,176), the body
      // between them about (96,96,96), and the plane guide — amber at half opacity over the
      // background — about (242,199,125). The order matters: the orange is tested before the
      // red because the two share a warm hue and differ in their blue — and orange has more
      // green than blue where the shaded side of the red knob (≈200,100,105) does not — and the guide before
      // the red because a half-opacity amber over white is pinker than it looks.
      if (r - g > 60 && g < 150 && b < 110 && g > b + 20) counts.orange += 1;
      else if (r > 200 && g >= 150 && g < 215 && b < 150 && r - b > 90) counts.guide += 1;
      else if (r - g > 40 && b > 110) counts.red += 1;
      else if (r < 130 && g < 130 && b < 140) counts.dark += 1;
    }
    // In CSS pixels, not buffer pixels. The room drops its resolution while the camera moves
    // and restores it at rest (components/Scene/MotionQuality.tsx), so two measurements of
    // the same picture can come from buffers of different sizes. Zero stays zero.
    const scale = (source.clientWidth * source.clientHeight) / (width * height);
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[key] = Math.round(counts[key] * scale);
    }
    return counts;
  });
}

/**
 * Wait until a browser is actually drawing the model.
 *
 * Polled from here rather than waited on inside the page, because the measurement is the same
 * one the assertions use: a page-side `waitForFunction` would need the counting code twice,
 * and two copies of a threshold is two chances for the wait to be satisfied by something the
 * assertion then disagrees with.
 */
async function waitForInk(session: Session, what: string) {
  const deadline = Date.now() + 90_000;
  let last: Palette = { orange: 0, red: 0, dark: 0, guide: 0 };
  while (Date.now() < deadline) {
    last = await palette(session);
    if (last.orange + last.red + last.dark > 0) return last;
    await session.page.waitForTimeout(500);
  }
  throw new Error(`${what} never reached the canvas (${JSON.stringify(last)})`);
}

/**
 * Give both canvases a moment to draw what the store just said.
 *
 * The badge is DOM and updates in the same React commit as the store write; the canvas is a
 * frame asked for by an effect after it, and this room renders on demand. Measuring the
 * moment the badge appears would read the frame BEFORE the cut on whichever browser applied
 * the value second.
 */
async function settle(...sessions: Session[]) {
  await Promise.all(sessions.map((session) => session.page.waitForTimeout(900)));
}

/**
 * Open the popover if `palette` shut it. Every measurement closes it, so every control
 * after a measurement has to ask for it back or wait forever for a slider that is not there.
 */
async function openTools(session: Session) {
  const popover = session.page.locator('[data-testid="view-tools-popover"]');
  if (await popover.isVisible().catch(() => false)) return;
  await session.page.locator('[data-testid="view-tools-toggle"]').click();
  await popover.waitFor({ state: "visible", timeout: 5_000 });
}

/** A picture of the moment, kept whether or not the assertions pass. */
async function shot(session: Session, name: string) {
  await session.page.screenshot({ path: `test-results/viewtools-${name}.png` });
}
