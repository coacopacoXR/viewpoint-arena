// The light rig every canvas in this app draws a model under — batch BT.
//
// "it is not great at keeping the textures … perhaps the lights could be adjusted" is
// one complaint with two halves, and this file is the second. What the room had was
// `ambientLight 0.7` plus one point light plus a studio environment blurred to nothing:
// three flat sources that between them leave no shading on a curved surface, so a
// fillet and a chamfer read as the same thing and a model's own materials — which is
// what a design review is actually looking at — have nothing to say. The lobby's
// "Turn in 3D" viewer had a THIRD arrangement of its own (ambient 0.75, one directional,
// the same blurred studio), so the same bracket looked different in the lobby and in
// the room it was a preview of.
//
// Both now mount this. What it is:
//
//   the studio environment, less blurred and slightly dimmed — the main light. An
//     image-based light is the only source that gives a curved surface a gradient and a
//     metal something to reflect, which is what a product shot is made of. blur 0.4
//     rather than 1 because a fully blurred environment turns a polished chamfer into
//     the same matte grey as everything beside it.
//   ambient 0.25 — enough to lift the shadows off black without flattening them.
//   a directional key from above and in front, the one that casts a shadow.
//   a weak fill from the opposite side, so the side the key does not reach is readable
//     without being lit.
//
// ContactShadows and the grid stay where they are: they are stage furniture, and the
// room's and the lobby's differ on purpose (the lobby's is a smaller, softer pool under
// a model that is framed to fill a panel).

import React, { Suspense } from 'react';
import { Environment } from '@react-three/drei';
import * as THREE from 'three';

/**
 * The tone mapping every canvas here uses.
 *
 * `NeutralToneMapping`, which is three's Khronos PBR neutral curve and the one made
 * for this job: it holds hue and saturation up to the point where a channel actually
 * clips. The `ACESFilmicToneMapping` this replaces is a film curve — it desaturates
 * towards white as it rolls off, which on a bright red anodised part or a yellow
 * safety guard reads as washed out, and on a model whose colours are the point (a
 * colourway review, a printed enclosure) reads as wrong.
 *
 * A constant rather than a literal in two `gl={{ … }}` objects, so the room and the
 * lobby's preview cannot drift apart and a test can pin the choice: "the models keep
 * their look" is a claim about a number in a renderer.
 */
export const SCENE_TONE_MAPPING = THREE.NeutralToneMapping;

/** Exposure for it. 1 is three's default and the neutral curve is calibrated for it. */
export const SCENE_TONE_MAPPING_EXPOSURE = 1;

/**
 * The studio preset fetches a remote HDR, so it can fail — an install with no route to
 * the CDN, a proxy that blocks it — and it suspends while it loads. Fenced and
 * suspended here rather than in each caller, which is what World.tsx did before and
 * what the lobby's viewer did differently: an environment that cannot load must cost a
 * flatter model, not an empty canvas, and it must not hold back the lights beside it.
 */
class EnvErrorBoundary extends React.Component<{ children: React.ReactNode }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

const LightRig: React.FC = () => (
  <>
    <ambientLight intensity={0.25} />
    {/* Above and in front, the way a product is photographed. castShadow because the
        room's Canvas asks for shadows and this is the one light allowed to make them;
        a tight shadow camera keeps the map's resolution on the model rather than on
        twenty metres of empty floor. */}
    <directionalLight
      position={[4, 8, 6]}
      intensity={1.1}
      castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-bias={-0.0005}
      shadow-camera-near={0.5}
      shadow-camera-far={30}
      shadow-camera-left={-6}
      shadow-camera-right={6}
      shadow-camera-top={6}
      shadow-camera-bottom={-6}
    />
    {/* The fill: opposite, higher, and a fifth as strong. It exists so the faces the
        key misses are shapes rather than silhouettes. */}
    <directionalLight position={[-5, 3, -4]} intensity={0.25} />

    <EnvErrorBoundary>
      <Suspense fallback={null}>
        <Environment preset="studio" blur={0.4} environmentIntensity={0.9} />
      </Suspense>
    </EnvErrorBoundary>
  </>
);

export default LightRig;
