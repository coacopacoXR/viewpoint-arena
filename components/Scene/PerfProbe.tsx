import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/**
 * The `?perf=1` probe that e2e/perf/orbit.perf.spec.ts reads.
 *
 * Why it lives in the page rather than in Playwright: the benchmark has to
 * report draw calls and triangles, and those only exist on the WebGLRenderer's
 * `info` counters inside the R3F loop. A test can count frames from outside with
 * `requestAnimationFrame`, but it cannot see that one orbit of the assembly cost
 * 3,200 draw calls — which is the number that decides whether the batching and
 * instancing tasks worked. So the page publishes what only it knows, and the
 * test does the arithmetic.
 *
 * It is deliberately inert rather than tree-shaken. `?perf=1` is a runtime URL
 * parameter, so no build-time flag can remove it, and the honest alternative was
 * a separate bundle that would drift from the one being measured. What "inert"
 * buys is that without the parameter nothing mounts: ViewpointCanvas does not
 * render this component at all, so no frame callback is registered, no `useFrame`
 * subscriber is added to the render loop, and the only cost the shipped app
 * carries is this module's few hundred bytes.
 */

export interface PerfRendererInfo {
  /** Draw calls in the last rendered frame — the number batching attacks. */
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  /** three's own frame counter; two samples of it say how many frames really ran. */
  frame: number;
}

export interface PerfMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface PerfRecording {
  /** One entry per frame, in ms, measured frame start to frame start. */
  frameTimesMs: number[];
  startedAt: number;
  durationMs: number;
  renderer: PerfRendererInfo;
  /** null everywhere `performance.memory` is missing (Firefox, Safari). */
  memory: PerfMemoryInfo | null;
  /** The GL implementation behind the canvas — see PerfGpuInfo. */
  gpu: PerfGpuInfo;
}

/**
 * Which GPU — or which software rasteriser — actually drew the frame.
 *
 * Recorded because a frame time without it is not comparable to anything. The
 * same assembly runs at 6 s a frame under headless SwiftShader and at a few
 * milliseconds on a discrete GPU, and both are honest measurements of the
 * machine they were taken on.
 */
export interface PerfGpuInfo {
  renderer: string;
  vendor: string;
  version: string;
}

export interface VpPerf {
  enabled: true;
  renderer(): PerfRendererInfo;
  memory(): PerfMemoryInfo | null;
  gpu(): PerfGpuInfo;
  start(): void;
  stop(): PerfRecording;
  isRecording(): boolean;
}

declare global {
  interface Window {
    __vpPerf?: VpPerf;
  }
}

/**
 * Whether this page was opened with `?perf=1`.
 *
 * Exported for the mount site rather than used inside the component, because a
 * hook cannot be called conditionally: the answer has to decide whether this
 * component exists at all, not what it does once it does.
 */
export const perfProbeEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('perf') === '1';
};

// `performance.memory` is a Chrome extension that lib.dom.d.ts does not declare.
type MemoryCapablePerformance = Performance & { memory?: PerfMemoryInfo };

const readMemory = (): PerfMemoryInfo | null => {
  const memory = (performance as MemoryCapablePerformance).memory;
  if (!memory) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
};

const PerfProbe: React.FC = () => {
  const gl = useThree(state => state.gl);

  const recording = useRef(false);
  const frameTimes = useRef<number[]>([]);
  const previous = useRef(0);
  const startedAt = useRef(0);

  // Priority 2, after SceneRenderer's priority 1. That component renders by hand
  // (gl.render, with scissor for the split view), and `renderer.info` is reset at
  // the top of every render() call, so a callback running before it would report
  // the counters of the frame before last. Running after it reports the frame
  // that was just drawn.
  useFrame(() => {
    if (!recording.current) return;
    const now = performance.now();
    // The first tick only establishes the baseline: there is no previous frame
    // start to measure from, and counting it would add one bogus interval that
    // includes however long the model took to load.
    if (previous.current !== 0) frameTimes.current.push(now - previous.current);
    previous.current = now;
  }, 2);

  // The functions below close over `gl` and are published once, so what
  // window.__vpPerf reports is read at the moment Playwright asks rather than at
  // the moment this component last rendered — the same reason SceneRenderer
  // publishes its view capture as a function on the store.
  useEffect(() => {
    const renderer = (): PerfRendererInfo => {
      const info = gl.info;
      return {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        frame: info.render.frame,
      };
    };

    const gpu = (): PerfGpuInfo => {
      const context = gl.getContext();
      // The unmasked pair is what says "SwiftShader" rather than "ANGLE", and
      // telling those apart is the whole reason this is recorded. It is an
      // extension a browser may withhold, so the masked answers are the fallback.
      const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
      const string = (which: number): string => {
        const value = context.getParameter(which);
        return typeof value === 'string' ? value : 'unknown';
      };
      return {
        renderer: string(debugInfo?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER),
        vendor: string(debugInfo?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR),
        version: string(context.VERSION),
      };
    };

    window.__vpPerf = {
      enabled: true,
      renderer,
      memory: readMemory,
      gpu,
      isRecording: () => recording.current,
      start: () => {
        frameTimes.current = [];
        previous.current = 0;
        startedAt.current = performance.now();
        recording.current = true;
      },
      stop: () => {
        recording.current = false;
        return {
          frameTimesMs: frameTimes.current,
          startedAt: startedAt.current,
          durationMs: performance.now() - startedAt.current,
          renderer: renderer(),
          memory: readMemory(),
          gpu: gpu(),
        };
      },
    };

    return () => {
      delete window.__vpPerf;
    };
  }, [gl]);

  return null;
};

export default PerfProbe;
