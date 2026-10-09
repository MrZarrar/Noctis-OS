import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import type { CorePoint, IntelligenceProfile, IntelligenceState } from "./core.js";
import {
  buildCoreGeometry,
  buildJesterMarks,
  coreAppearance,
  JESTER_PROFILE,
  profileFor,
  shouldAnimateCore,
  VESPER_PROFILE,
} from "./core.js";

export interface IntelligenceRendererProps {
  identityId: ConversationalIdentityId;
  protocolIds?: readonly ProtocolId[];
  state?: IntelligenceState;
  profile?: IntelligenceProfile;
}

const CORE = buildCoreGeometry();
const JESTER = buildJesterMarks(CORE);
const JESTER_SHARDS = CORE.shards.map((shard, index) => {
  const offset = index === 2 || index === 7 || index === 11 ? 0.22 : 0;
  const angle = (index / CORE.shards.length) * Math.PI * 2;
  const tilt = offset === 0 ? 0 : index % 2 === 0 ? 0.16 : -0.18;
  const x = Math.cos(angle) * offset;
  const y = Math.sin(angle) * offset;
  const z = offset * 0.5;
  const cosine = Math.cos(tilt);
  const sine = Math.sin(tilt);
  return {
    x,
    y,
    z,
    tilt,
    points: shard.map<CorePoint>((point) => [
      point[0] * cosine - point[1] * sine + x,
      point[0] * sine + point[1] * cosine + y,
      point[2] + z,
    ]),
  };
});
/**
 * Points every `1 / steps` of the way along each segment, ends included once.
 * WebGL draws lines one pixel wide, so a mark that has to glow is a chain of
 * point lights rather than a thicker line.
 */
function along(
  segments: ReadonlyArray<readonly [CorePoint, CorePoint]>,
  steps: number,
): CorePoint[] {
  return segments.flatMap(([from, to], segment) =>
    Array.from({ length: steps + (segment === segments.length - 1 ? 1 : 0) }, (_, step) => {
      const t = step / steps;
      return [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ] as CorePoint;
    }),
  );
}
/** Points per grin segment: the grin jitters a whole segment at a time, so it reads jagged. */
const GRIN_STEPS = 5;
const GRIN = along(
  JESTER.grin.slice(1).map((point, index) => [JESTER.grin[index]!, point] as const),
  GRIN_STEPS,
);
const LABEL: Record<IntelligenceState, string> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  waiting_for_approval: "waiting for approval",
};

function buffer(points: readonly CorePoint[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  return geometry;
}

function shardGeometry(shards: readonly CorePoint[][]): THREE.BufferGeometry {
  const triangles: CorePoint[] = [];
  const colors: number[] = [];
  shards.forEach((shard, index) => {
    const center = shard.reduce<CorePoint>(
      (sum, point) => [
        sum[0] + point[0] / shard.length,
        sum[1] + point[1] / shard.length,
        sum[2] + point[2] / shard.length,
      ],
      [0, 0, 0],
    );
    shard.forEach((point, face) => {
      triangles.push(point, shard[(face + 1) % shard.length]!, [
        center[0],
        center[1],
        center[2] + 0.015,
      ]);
      const value = 0.38 + ((index * 7 + face * 3) % 11) * 0.054;
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(value * 0.82, value * 0.85, value);
    });
  });
  const geometry = buffer(triangles);
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function lights(
  points: readonly CorePoint[],
  size: number,
  color: string,
): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  return new THREE.Points(
    buffer(points),
    new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(color) },
        size: { value: size },
        intensity: { value: 1 },
        pixelRatio: { value: 1 },
        sparkle: { value: size < 80 ? 1 : 0 },
      },
      vertexShader: `
      uniform float size;
      uniform float pixelRatio;
      void main() {
        vec4 point = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * pixelRatio;
        gl_Position = projectionMatrix * point;
      }`,
      fragmentShader: `
      uniform vec3 color;
      uniform float intensity;
      uniform float sparkle;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        float halo = pow(max(0.0, 1.0 - d * 2.0), mix(2.0, 4.0, sparkle));
        float center = 1.0 - smoothstep(0.015, 0.055, d);
        float cross = exp(-abs(p.x) * 110.0) * exp(-abs(p.y) * 11.0)
                    + exp(-abs(p.y) * 110.0) * exp(-abs(p.x) * 11.0);
        gl_FragColor = vec4(mix(color, vec3(0.94, 0.89, 1.0), center * sparkle), (halo * 0.7 + (center + cross * 0.2) * sparkle) * intensity);
        #include <colorspace_fragment>
      }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}

interface CoreScene {
  update: (state: IntelligenceState, profile: IntelligenceProfile) => void;
  dispose: () => void;
}

function createScene(host: HTMLDivElement, onUnavailable: () => void): CoreScene | undefined {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    return undefined;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
  camera.position.set(0, 0, 9.2);
  const world = new THREE.Group();
  scene.add(world);
  const networkMaterial = new THREE.LineBasicMaterial({
    color: VESPER_PROFILE.violet,
    transparent: true,
    opacity: 0.23,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const network = new THREE.LineSegments(
    buffer(CORE.edges.flatMap(([a, b]) => [CORE.points[a]!, CORE.points[b]!])),
    networkMaterial,
  );
  world.add(network);
  const glassMaterial = new THREE.MeshPhongMaterial({
    color: VESPER_PROFILE.glass,
    vertexColors: true,
    transparent: true,
    opacity: 0.19,
    side: THREE.DoubleSide,
    depthWrite: false,
    shininess: 140,
    specular: 0x8f85b4,
    flatShading: true,
  });
  const shell = new THREE.Group();
  const shellShards = CORE.shards.map((shard) => {
    const mesh = new THREE.Mesh(shardGeometry([shard]), glassMaterial);
    shell.add(mesh);
    return mesh;
  });
  world.add(shell);
  const shardLines: CorePoint[] = [];
  const shardBorderOffsets: number[] = [];
  for (const shard of CORE.shards) {
    shardBorderOffsets.push(shardLines.length);
    const center = shard.reduce<CorePoint>(
      (sum, point) => [
        sum[0] + point[0] / shard.length,
        sum[1] + point[1] / shard.length,
        sum[2] + point[2] / shard.length,
      ],
      [0, 0, 0],
    );
    shard.forEach((point, index) => {
      shardLines.push(point, shard[(index + 1) % shard.length]!, point, center);
    });
  }
  const borderMaterial = new THREE.LineBasicMaterial({
    color: 0xc4bdf1,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
  });
  const borders = new THREE.LineSegments(buffer(shardLines), borderMaterial);
  const borderPositions = borders.geometry.getAttribute("position") as THREE.BufferAttribute;
  const baseBorderPositions = new Float32Array(borderPositions.array);
  shell.add(borders);
  const fragmentMaterial = new THREE.MeshBasicMaterial({
    color: VESPER_PROFILE.violet,
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const fragments = new THREE.Mesh(shardGeometry(CORE.fragments), fragmentMaterial);
  const heart = new THREE.Group();
  heart.add(fragments);
  world.add(heart);
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.23),
    new THREE.MeshPhongMaterial({
      color: 0xb08cff,
      emissive: 0x6b2bd4,
      emissiveIntensity: 1.1,
      shininess: 110,
      flatShading: true,
    }),
  );
  crystal.scale.setScalar(1.05);
  crystal.rotation.set(0.2, 0.4, 0.18);
  heart.add(crystal);
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xd4bcff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  heart.add(
    new THREE.Mesh(
      buffer(CORE.fragments.filter((_, index) => index % 5 === 0).flat()),
      highlightMaterial,
    ),
  );
  const junctions = lights(
    CORE.points.filter((_, index) => index % 4 === 0),
    23,
    VESPER_PROFILE.violet,
  );
  const dust = lights(CORE.points, 4, "#b9a0ff");
  const glow = lights(
    [
      [0, 0.25, 0.5],
      [0, -0.25, 0.5],
    ],
    150,
    VESPER_PROFILE.violet,
  );
  world.add(junctions, dust, glow);
  const sparks = lights(
    Array.from({ length: 18 }, () => [0, 0, 0] as CorePoint),
    12,
    VESPER_PROFILE.violet,
  );
  world.add(sparks);
  const pedestal = lights([[0, -2.32, 0]], 48, VESPER_PROFILE.violet);
  scene.add(pedestal);
  const coreLights = [junctions, glow, dust, pedestal, sparks];

  const jesterColors = JESTER_PROFILE.jester!;
  const faultEdges = JESTER.faults.flatMap((chain) =>
    chain.slice(1).map((point, index) => [chain[index]!, point] as const),
  );
  const faultMaterial = new THREE.LineBasicMaterial({
    color: jesterColors.lime,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const faultLines = new THREE.LineSegments(
    buffer(faultEdges.flatMap(([a, b]) => [CORE.points[a]!, CORE.points[b]!])),
    faultMaterial,
  );
  const faultLights = lights(
    along(
      faultEdges.map(([a, b]) => [CORE.points[a]!, CORE.points[b]!] as const),
      6,
    ),
    11,
    jesterColors.lime,
  );
  const redSparks = lights(
    Array.from({ length: 6 }, () => [0, 0, 0] as CorePoint),
    15,
    jesterColors.red,
  );
  const redSparkPositions = redSparks.geometry.getAttribute("position") as THREE.BufferAttribute;
  const faults = new THREE.Group();
  faults.add(faultLines, faultLights, redSparks);
  faults.visible = false;
  network.add(faults);

  const dripMaterial = new THREE.LineBasicMaterial({
    color: jesterColors.lime,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // A drip hangs from a shard or from a fault point, and must turn with it:
  // the shell sways while the network spins.
  const faultPoints = new Set(JESTER.faults.flat().map((index) => CORE.points[index]));
  const dripLines = (fromFault: boolean): THREE.LineSegments =>
    new THREE.LineSegments(
      buffer(
        JESTER.drips
          .filter(([top]) => faultPoints.has(top) === fromFault)
          .flatMap(([top, bottom]) => [top, bottom]),
      ),
      dripMaterial,
    );
  const dripGlow = (fromFault: boolean): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> =>
    lights(
      JESTER.drips
        .filter(([top]) => faultPoints.has(top) === fromFault)
        .flatMap(([top, bottom]) => along([[top, bottom]], 4)),
      9,
      jesterColors.lime,
    );
  const drips = new THREE.Group();
  const shardDripGlow = dripGlow(false);
  const faultDripGlow = dripGlow(true);
  drips.add(dripLines(false), shardDripGlow);
  drips.visible = false;
  shell.add(drips);
  faults.add(dripLines(true), faultDripGlow);

  const redEye = lights([JESTER.redEye], 150, jesterColors.red);
  const redEyeCore = lights([JESTER.redEye], 34, jesterColors.red);
  const grinLights = lights(GRIN, 16, jesterColors.lime);
  const grinMaterial = new THREE.LineBasicMaterial({
    color: jesterColors.lime,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const grin = new THREE.Line(buffer(GRIN), grinMaterial);
  const grinPositions = grin.geometry.getAttribute("position") as THREE.BufferAttribute;
  const grinLightPositions = grinLights.geometry.getAttribute("position") as THREE.BufferAttribute;
  const faceMarks = new THREE.Group();
  faceMarks.add(redEye, redEyeCore, grin, grinLights);
  faceMarks.visible = false;
  world.add(faceMarks);
  const jesterLights = [
    faultLights,
    shardDripGlow,
    faultDripGlow,
    redSparks,
    redEye,
    redEyeCore,
    grinLights,
  ];

  scene.add(new THREE.AmbientLight(0xc3bcdd, 0.8));
  const key = new THREE.DirectionalLight(0xbbb6d4, 1.4);
  key.position.set(-3, 4, 5);
  scene.add(key);

  let state: IntelligenceState = "idle";
  let profile = VESPER_PROFILE;
  let visible = false;
  let disposed = false;
  let lost = false;
  let frame = 0;
  let frames = 0;
  let totalDraw = 0;
  let maxDraw = 0;
  let lastTime = 0;
  let elapsed = 0;
  let energy = 0;
  let face = 0;
  let fault = 0;
  let jesterBorders = false;
  const heartColor = new THREE.Color(VESPER_PROFILE.violet);
  const targetHeartColor = new THREE.Color(VESPER_PROFILE.violet);
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const canDraw = (): boolean => !disposed && !lost && visible && !document.hidden;
  const animate = (): boolean =>
    canDraw() && shouldAnimateCore(state, motion.matches, visible, document.hidden);
  const render = (now: number): void => {
    const started = performance.now();
    const appearance = coreAppearance(state, profile);
    const jester = profile.jester;
    const moving = animate();
    const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const smoothing = moving ? 1 - Math.exp(-delta * 5) : 1;
    energy = THREE.MathUtils.lerp(
      energy,
      state === "speaking" ? 1 : state === "thinking" ? 0.7 : 0.35,
      smoothing,
    );
    face = THREE.MathUtils.lerp(face, appearance.face, smoothing);
    fault = THREE.MathUtils.lerp(fault, appearance.fault, smoothing);
    if (moving) elapsed += delta * (0.65 + energy * 0.65);
    const beat = moving ? Math.sin(elapsed * (appearance.approval ? 2 : 4.2)) : 0;
    world.rotation.set(
      moving ? Math.sin(elapsed * 0.4) * 0.12 : 0,
      moving ? Math.sin(elapsed * 0.32) * 0.24 : 0,
      0,
    );
    world.scale.setScalar(appearance.expansion + beat * (0.009 + energy * 0.018));
    network.rotation.y = moving ? elapsed * 0.23 : 0;
    junctions.rotation.copy(network.rotation);
    dust.rotation.copy(network.rotation);
    shell.rotation.z = moving ? Math.sin(elapsed * 0.3) * 0.12 : 0;
    for (let index = 0; index < shellShards.length; index += 1) {
      const shard = shellShards[index]!;
      const displaced = JESTER_SHARDS[index]!;
      const drift =
        (moving ? Math.sin(elapsed * 1.2 + index * 1.7) * (0.025 + energy * 0.055) : 0) +
        (moving && jester !== undefined
          ? Math.sin(elapsed * (3.7 + index * 0.13) + index * 2.1) *
            (0.012 + energy * 0.02) *
            (0.45 + (index % 4) * 0.2)
          : 0);
      const angle = (index / shellShards.length) * Math.PI * 2;
      shard.position.set(
        Math.cos(angle) * drift + (jester === undefined ? 0 : displaced.x),
        Math.sin(angle) * drift + (jester === undefined ? 0 : displaced.y),
        drift * 1.6 + (jester === undefined ? 0 : displaced.z),
      );
      shard.rotation.z = drift * 0.4 + (jester === undefined ? 0 : displaced.tilt);
      if (jester !== undefined) {
        const cosine = Math.cos(shard.rotation.z);
        const sine = Math.sin(shard.rotation.z);
        const end = shardBorderOffsets[index + 1] ?? borderPositions.count;
        for (let vertex = shardBorderOffsets[index]!; vertex < end; vertex += 1) {
          const x = baseBorderPositions[vertex * 3]!;
          const y = baseBorderPositions[vertex * 3 + 1]!;
          borderPositions.setXYZ(
            vertex,
            x * cosine - y * sine + shard.position.x,
            x * sine + y * cosine + shard.position.y,
            baseBorderPositions[vertex * 3 + 2]! + shard.position.z,
          );
        }
      }
    }
    // Vesper keeps its original border motion; Jester's borders follow its shards.
    if (jester !== undefined) {
      borderPositions.needsUpdate = true;
    } else if (jesterBorders) {
      borderPositions.copyArray(baseBorderPositions);
      borderPositions.needsUpdate = true;
    }
    jesterBorders = jester !== undefined;
    const heartFace = jester === undefined ? 0 : face;
    heart.position.set(
      JESTER.violetEye[0] * heartFace,
      JESTER.violetEye[1] * heartFace,
      JESTER.violetEye[2] * heartFace,
    );
    glow.position.copy(heart.position);
    heart.rotation.set(
      moving ? Math.sin(elapsed * 0.7) * 0.3 : 0,
      moving ? elapsed * 0.65 : 0,
      moving ? Math.sin(elapsed * 0.6) * 0.25 : 0,
    );
    heart.scale.setScalar(1 + beat * (appearance.approval ? 0.08 : 0.045 + energy * 0.06));
    fragments.rotation.z = moving ? -elapsed * 0.45 : 0;
    networkMaterial.color.set(appearance.color);
    networkMaterial.opacity = 0.28 * appearance.light + beat * 0.025;
    glassMaterial.color.set(profile.glass);
    targetHeartColor.set(appearance.coreColor);
    heartColor.lerp(targetHeartColor, moving ? 1 - Math.exp(-delta * 8) : 1);
    fragmentMaterial.color.copy(heartColor);
    highlightMaterial.color.copy(heartColor);
    crystal.material.color.copy(heartColor);
    crystal.material.emissive.copy(heartColor);
    crystal.material.emissiveIntensity = 0.65 + appearance.light * 0.35 + beat * 0.18;
    fragmentMaterial.opacity = Math.min(0.92, 0.68 + appearance.light * 0.12 + beat * 0.05);
    const sparkPositions = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < sparkPositions.count; index += 1) {
      const edge = CORE.edges[(index * 31) % CORE.edges.length]!;
      const from = CORE.points[edge[0]]!;
      const to = CORE.points[edge[1]]!;
      const travel = (elapsed * 0.95 + index * 0.137) % 1;
      sparkPositions.setXYZ(
        index,
        THREE.MathUtils.lerp(from[0], to[0], travel),
        THREE.MathUtils.lerp(from[1], to[1], travel),
        THREE.MathUtils.lerp(from[2], to[2], travel),
      );
    }
    sparkPositions.needsUpdate = true;
    sparks.rotation.copy(network.rotation);
    sparks.visible = moving;
    const dpr = renderer.getPixelRatio();
    for (const points of coreLights) {
      points.material.uniforms.pixelRatio!.value = dpr;
      (points.material.uniforms.color!.value as THREE.Color).set(
        points === glow ? heartColor : appearance.color,
      );
      points.material.uniforms.intensity!.value =
        appearance.light + beat * (points === glow ? 0.28 : 0.16);
    }

    faults.visible = jester !== undefined;
    drips.visible = jester !== undefined;
    faceMarks.visible = jester !== undefined && face > 0;
    redSparks.visible = jester !== undefined && moving && faultEdges.length > 0;
    if (jester !== undefined) {
      faultMaterial.color.set(jester.lime);
      faultMaterial.opacity = fault * 0.85;
      dripMaterial.color.set(jester.lime);
      dripMaterial.opacity = fault * 0.75;
      grinMaterial.color.set(jester.lime);
      const faceLight =
        face *
        (state === "speaking"
          ? 1.5
          : moving && state === "thinking"
            ? 0.85 + Math.sin(elapsed * 31) * 0.15
            : 1);
      grinMaterial.opacity = Math.min(1, faceLight);
      for (const points of jesterLights) {
        points.material.uniforms.pixelRatio!.value = dpr;
        (points.material.uniforms.color!.value as THREE.Color).set(
          points === redEye || points === redEyeCore || points === redSparks
            ? jester.red
            : jester.lime,
        );
        points.material.uniforms.intensity!.value =
          points === redEye || points === redEyeCore
            ? face * 1.6
            : points === grinLights
              ? faceLight * 1.3
              : fault * 1.4;
      }
      for (let index = 0; index < GRIN.length; index += 1) {
        const point = GRIN[index]!;
        const segment = Math.round(index / GRIN_STEPS);
        const jitter =
          moving && state === "thinking" && segment % 2 === 1
            ? Math.sin(elapsed * 27 + segment * 2.3) * 0.035
            : 0;
        grinPositions.setXYZ(index, point[0], point[1] + jitter, point[2]);
        grinLightPositions.setXYZ(index, point[0], point[1] + jitter, point[2]);
      }
      grinPositions.needsUpdate = true;
      grinLightPositions.needsUpdate = true;
      if (redSparks.visible) {
        for (let index = 0; index < redSparkPositions.count; index += 1) {
          const edge = faultEdges[(index * 3) % faultEdges.length]!;
          const from = CORE.points[edge[0]]!;
          const to = CORE.points[edge[1]]!;
          const travel = (elapsed * 1.6 + index * 0.217) % 1;
          redSparkPositions.setXYZ(
            index,
            THREE.MathUtils.lerp(from[0], to[0], travel),
            THREE.MathUtils.lerp(from[1], to[1], travel),
            THREE.MathUtils.lerp(from[2], to[2], travel),
          );
        }
        redSparkPositions.needsUpdate = true;
      }
    }

    renderer.render(scene, camera);
    const duration = performance.now() - started;
    frames += 1;
    totalDraw += duration;
    maxDraw = Math.max(maxDraw, duration);
    host.dataset.coreFrames = String(frames);
    host.dataset.coreDrawMs = duration.toFixed(3);
    host.dataset.coreTotalDrawMs = totalDraw.toFixed(3);
    host.dataset.coreMaxDrawMs = maxDraw.toFixed(3);
    host.dataset.coreHeartColor = `#${heartColor.getHexString()}`;
  };
  const tick = (now: number): void => {
    frame = 0;
    if (!animate()) return;
    render(now);
    frame = requestAnimationFrame(tick);
  };
  const reconcile = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    const active = animate();
    host.dataset.coreRunning = String(active);
    host.dataset.coreVisible = String(canDraw());
    lastTime = performance.now();
    if (canDraw()) render(lastTime);
    if (active) frame = requestAnimationFrame(tick);
  };
  const resize = (): void => {
    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0 || disposed || lost) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = Math.max(8.6, 6.2 / camera.aspect);
    camera.updateProjectionMatrix();
    reconcile();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting === true;
    reconcile();
  });
  intersectionObserver.observe(host);
  document.addEventListener("visibilitychange", reconcile);
  motion.addEventListener("change", reconcile);
  const contextLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    renderer.domElement.style.display = "none";
    reconcile();
    onUnavailable();
  };
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  resize();

  return {
    update(nextState, nextProfile) {
      state = nextState;
      profile = nextProfile;
      reconcile();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      host.dataset.coreRunning = "false";
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", reconcile);
      motion.removeEventListener("change", reconcile);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.Points
        ) {
          const drawable = object as THREE.Mesh<
            THREE.BufferGeometry,
            THREE.Material | THREE.Material[]
          >;
          drawable.geometry.dispose();
          const materials = Array.isArray(drawable.material)
            ? drawable.material
            : [drawable.material];
          for (const material of materials) material.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

const project = ([x, y, z]: CorePoint): readonly [number, number] => {
  const perspective = 9.2 / (9.2 - z);
  return [180 + x * perspective * 58, 183 - y * perspective * 58];
};

function StaticCore({
  state,
  profile,
}: {
  state: IntelligenceState;
  profile: IntelligenceProfile;
}): JSX.Element {
  const appearance = coreAppearance(state, profile);
  const jester = profile.jester;
  const violetEye = project(JESTER.violetEye);
  const redEye = project(JESTER.redEye);
  const heartTransform =
    appearance.face > 0
      ? `translate(${((violetEye[0] - 180) * appearance.face).toFixed(1)} ${(
          (violetEye[1] - 183) *
          appearance.face
        ).toFixed(1)})`
      : undefined;
  return (
    <svg
      viewBox="0 0 360 380"
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      <g stroke={profile.violet} strokeWidth="0.45" opacity={0.32 * appearance.light}>
        {CORE.edges.map(([a, b], index) => {
          const from = project(CORE.points[a]!);
          const to = project(CORE.points[b]!);
          return <line key={index} x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />;
        })}
      </g>
      {CORE.shards.map((shard, index) => (
        <polygon
          key={index}
          points={(jester === undefined ? shard : JESTER_SHARDS[index]!.points)
            .map((point) => project(point).join(","))
            .join(" ")}
          fill={profile.glass}
          fillOpacity={0.11 + (index % 3) * 0.04}
          stroke={profile.glass}
          strokeWidth="0.65"
          strokeOpacity="0.7"
        />
      ))}
      {jester !== undefined && (
        <>
          {JESTER.faults.map((chain, index) => (
            <polyline
              key={index}
              data-jester-fault="true"
              points={chain.map((point) => project(CORE.points[point]!).join(",")).join(" ")}
              fill="none"
              stroke={jester.lime}
              strokeWidth="1.25"
              opacity={appearance.fault}
            />
          ))}
          {JESTER.faults.flat().map((point, index) => {
            const [x, y] = project(CORE.points[point]!);
            return (
              <g key={index} opacity={appearance.fault}>
                <circle cx={x} cy={y} r="3.2" fill={jester.lime} opacity="0.18" />
                <circle cx={x} cy={y} r="1.1" fill={jester.lime} />
              </g>
            );
          })}
          {JESTER.drips.map(([top, bottom], index) => {
            const from = project(top);
            const to = project(bottom);
            return (
              <line
                key={index}
                data-jester-drip="true"
                x1={from[0]}
                y1={from[1]}
                x2={to[0]}
                y2={to[1]}
                stroke={jester.lime}
                strokeWidth="1"
                opacity={appearance.fault}
              />
            );
          })}
        </>
      )}
      <g data-core-heart="true" transform={heartTransform}>
        {CORE.fragments.map((shard, index) => (
          <polygon
            key={index}
            points={shard.map((point) => project(point).join(",")).join(" ")}
            fill={appearance.coreColor}
            fillOpacity={Math.min(0.95, 0.5 * appearance.light)}
            stroke={appearance.coreColor}
            strokeWidth="0.5"
          />
        ))}
        <polygon
          points="180,165 169,183 180,201 191,183"
          fill={appearance.coreColor}
          stroke={appearance.coreColor}
          strokeWidth="0.7"
        />
      </g>
      {CORE.points
        .filter((_, index) => index % 7 === 0)
        .map((point, index) => {
          const [x, y] = project(point);
          return (
            <g key={index}>
              <circle cx={x} cy={y} r="3.6" fill={profile.violet} opacity="0.15" />
              <circle cx={x} cy={y} r="0.95" fill="#c8abff" />
            </g>
          );
        })}
      {jester !== undefined && appearance.face > 0 && (
        <>
          <polyline
            data-jester-grin="true"
            points={JESTER.grin.map((point) => project(point).join(",")).join(" ")}
            fill="none"
            stroke={jester.lime}
            strokeWidth="1.8"
            opacity={appearance.face}
          />
          {JESTER.grin.map((point, index) => {
            const [x, y] = project(point);
            return (
              <g key={index} opacity={appearance.face}>
                <circle cx={x} cy={y} r="3.5" fill={jester.lime} opacity="0.2" />
                <circle cx={x} cy={y} r="1.3" fill={jester.lime} />
              </g>
            );
          })}
          <circle
            cx={redEye[0]}
            cy={redEye[1]}
            r="14"
            fill={jester.red}
            opacity={appearance.face * 0.2}
          />
          <circle
            cx={redEye[0]}
            cy={redEye[1]}
            r="5.8"
            fill={jester.red}
            opacity={appearance.face}
          />
        </>
      )}
      <path d="M160 343h40 M180 339v8" stroke={profile.violet} strokeWidth="1.2" />
    </svg>
  );
}

export function IntelligenceRenderer({
  identityId,
  protocolIds = [],
  state = "idle",
  profile = profileFor(identityId),
}: IntelligenceRendererProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CoreScene>();
  const [webgl, setWebgl] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const scene = createScene(host, () => {
      setWebgl(false);
    });
    sceneRef.current = scene;
    setWebgl(scene !== undefined);
    return () => {
      scene?.dispose();
      sceneRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.update(state, profile);
  }, [state, profile]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={`${identityId} intelligence, ${LABEL[state]}${protocolIds.includes("noir") ? ", NOIR active" : ""}`}
      className="noctis-intelligence"
      data-core-state={state}
      data-core-profile={profile.name}
      data-core-renderer={webgl ? "webgl" : "static"}
      data-core-frames="0"
      data-core-running="false"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {!webgl && <StaticCore state={state} profile={profile} />}
    </div>
  );
}
