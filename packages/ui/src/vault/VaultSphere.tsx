import type { VaultEntityType } from "@noctis/contracts";
import { focusSubgraph } from "@noctis/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  corner,
  depth as depthTokens,
  identityAccent,
  material,
  semantic,
  spacing,
  typography,
} from "../tokens/index.js";
import type { LabelBox, SphereEdge } from "./sphere.js";
import {
  CONTENT_R,
  EDGE_SEGS,
  R,
  bezier,
  degreeOf,
  edgeControl,
  labelOpacity,
  placeLabels,
  radiusFor,
  slotFor,
  thinEdges,
  toWorld,
  uniqueLinks,
} from "./sphere.js";

/**
 * The dedicated Vault view: a rotating sphere-brain.
 *
 * Ported from `Jarvis-Sub-Agent-Dashboard` at commit `ee7b4527`,
 * `client/src/components/VaultSphere.tsx`. MIT licence, Copyright (c) 2026 -
 * Now, Son Nguyen. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * What differs from the donor:
 *
 * 1. There is no force simulation. Coordinates arrive settled from
 *    `vault_layout` and are drawn where they are, so Section 7's "remove
 *    continuous force wandering" is structural rather than a flag. That also
 *    makes every client's sphere identical, which a per-client solver could
 *    not promise.
 * 2. `SphereFx` is gone — engine scan/spark/birth flashes and hot edges are
 *    donor coupling with no Noctis event behind them. So is the crystal core
 *    and its rays, which read as a separate object rather than as the Vault.
 * 3. The sphere is quiet until something is focused. Every note is a soft grey
 *    orb with a hint of its type, the far side fades back, and colour, glow,
 *    pulses, and labels are spent only on the focused note and its links.
 *    With all of it on at once, a Vault of a few hundred densely linked notes
 *    was a white smear.
 * 4. Everything the canvas can do, the keyboard can do. The donor component has
 *    no `tabIndex`, `role`, or `aria-*` at all; the list below the globe is the
 *    same graph as a focusable tree, and the canvas is `aria-hidden` because it
 *    would otherwise announce as an unlabelled image of it.
 */

export interface VaultSphereNode {
  id: string;
  name: string;
  type: VaultEntityType;
  /** Absent while an entity has no persisted coordinate yet. */
  x?: number;
  y?: number;
  z?: number;
  /** Notes have one; a linked-but-unwritten target does not. */
  path?: string | null;
}

export type VaultSphereEdge = SphereEdge;

export interface VaultSphereProps {
  nodes: readonly VaultSphereNode[];
  edges: readonly VaultSphereEdge[];
  /** The node under discussion. The globe turns to face it and its label is pinned. */
  focusId?: string;
  onFocus?: (id: string | undefined) => void;
  /** "Open in Vault" arrives here with the note to open. */
  onOpen?: (node: VaultSphereNode) => void;
  heightPx?: number;
}

const TYPE_COLOUR: Readonly<Record<VaultEntityType, string>> = {
  person: identityAccent.vesper.primary,
  project: semantic.success,
  reference: semantic.approval,
  daily: semantic.warning,
  capture: identityAccent.jester.primary,
  agent: identityAccent.noir.structure,
  note: typography.color.muted,
};

const TYPE_ORDER = ["capture", "project", "person", "reference", "daily", "agent", "note"] as const;

const PALETTE: readonly THREE.Color[] = TYPE_ORDER.map(
  (type) => new THREE.Color(TYPE_COLOUR[type]),
);

/** A note at rest: mostly grey, with just enough of its type to tell clusters apart. */
const REST_PALETTE: readonly THREE.Color[] = PALETTE.map((colour) =>
  new THREE.Color(0.6, 0.62, 0.72).lerp(colour, 0.3),
);

const SHELL_OPACITY = 0.04;
const PULSE_OPACITY = 0.5;
const PULSE_SIZE = 1.9;

// Edge colours are added to the scene, so these are brightness, not tint.
const REST_EDGE = new THREE.Color(0.014, 0.018, 0.028);
const LIT_EDGE = new THREE.Color(0.36, 0.44, 0.68);
/** A focused hub names this many of its links; the rest stay unlabelled dots. */
const LABELLED_LINKS = 12;

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Donor: the faint lat/long wireframe globe that bounds the graph. */
function buildShell(): THREE.LineSegments {
  const points: number[] = [];
  const seg = 64;

  for (let lat = 1; lat < 8; lat += 1) {
    const phi = (lat / 8) * Math.PI;
    const y = R * Math.cos(phi);
    const radius = R * Math.sin(phi);

    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * Math.PI * 2;
      const b = ((i + 1) / seg) * Math.PI * 2;
      points.push(
        radius * Math.cos(a),
        y,
        radius * Math.sin(a),
        radius * Math.cos(b),
        y,
        radius * Math.sin(b),
      );
    }
  }

  for (let meridian = 0; meridian < 12; meridian += 1) {
    const theta = (meridian / 12) * Math.PI * 2;

    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * Math.PI;
      const b = ((i + 1) / seg) * Math.PI;
      points.push(
        R * Math.sin(a) * Math.cos(theta),
        R * Math.cos(a),
        R * Math.sin(a) * Math.sin(theta),
        R * Math.sin(b) * Math.cos(theta),
        R * Math.cos(b),
        R * Math.sin(b) * Math.sin(theta),
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));

  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x8ea6c8,
      transparent: true,
      opacity: SHELL_OPACITY,
      depthWrite: false,
    }),
  );
}

function buildStars(): THREE.Points {
  const count = 320;
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    // Only outside the shell: a star inside it is indistinguishable from a note.
    const point = new THREE.Vector3()
      .randomDirection()
      .multiplyScalar(R * (1.4 + Math.random() * 1.6));

    positions.set([point.x, point.y, point.z], i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xaabbdd,
      // A fixed pixel size: attenuated, the near ones grow into grey squares
      // as the camera zooms toward them.
      size: 1.5,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      sizeAttenuation: false,
    }),
  );
}

/** Donor: a radial falloff texture, drawn once and shared by every glow sprite. */
function radialTexture(size: number, stops: ReadonlyArray<[number, string]>): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;

  const context = canvas.getContext("2d");
  const half = size / 2;

  if (context !== null) {
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);

    for (const [offset, colour] of stops) {
      gradient.addColorStop(offset, colour);
    }

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

const ORB_STOPS: ReadonlyArray<[number, string]> = [
  [0, "rgba(255,255,255,1)"],
  [0.2, "rgba(255,255,255,0.6)"],
  [0.5, "rgba(255,255,255,0.16)"],
  [1, "rgba(255,255,255,0)"],
];

/** Shared by the orbs and their glow: a world-sized point that shrinks with distance. */
const POINT_VERTEX = `
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  uniform float uMax;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(size * uScale / -mv.z, uMax);
    gl_Position = projectionMatrix * mv;
  }`;

/** A round orb with a soft edge, lit a little from above so it is not a flat disc. */
const ORB_FRAGMENT = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float shade = 0.8 + 0.25 * (1.0 - smoothstep(0.0, 1.0, length(c + vec2(0.0, 0.18)) * 1.8));
    gl_FragColor = vec4(vColor * shade, vAlpha * (1.0 - smoothstep(0.78, 1.0, d)));
  }`;

const GLOW_FRAGMENT = `
  uniform sampler2D map;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor * vAlpha, 1.0) * texture2D(map, gl_PointCoord);
  }`;

interface DrawNode {
  id: string;
  name: string;
  type: VaultEntityType;
  degree: number;
  written: boolean;
  /** Donor: a per-node offset so the breathing does not pulse in unison. */
  phase: number;
  position: THREE.Vector3;
}

interface DrawEdge {
  a: DrawNode;
  b: DrawNode;
  /** Survived thinning, so it is drawn faintly even when nothing is focused. */
  resting: boolean;
}

interface Scene {
  rebuild: (nodes: readonly VaultSphereNode[], edges: readonly VaultSphereEdge[]) => void;
  dispose: () => void;
}

interface SceneCallbacks {
  focusId: () => string | undefined;
  onSelect: (id: string | undefined) => void;
  onIsolate: (id: string) => void;
}

function pointsGeometry(count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(count), 1));
  geometry.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(count), 1));

  return geometry;
}

/**
 * Everything imperative, kept out of the component body so the React half is
 * only props, state, and the accessible tree.
 *
 * Returns `undefined` when there is no WebGL — headless test runners and
 * machines without a GPU still get the working list below, which is the whole
 * reason that list is the real control surface and not a fallback.
 */
function createScene(
  mount: HTMLDivElement,
  labelCanvas: HTMLCanvasElement,
  callbacks: SceneCallbacks,
): Scene | undefined {
  let renderer: THREE.WebGLRenderer;

  try {
    // Opaque: on a transparent canvas, additive lines still write alpha, and
    // an unlit one shows up as a black streak over the page behind it.
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch {
    return undefined;
  }

  renderer.setClearColor(new THREE.Color(depthTokens.layers[0]));

  const reduceMotion = prefersReducedMotion();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  renderer.setPixelRatio(dpr);
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  // Under the labels, which let the pointer through to it.
  mount.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  camera.position.set(0, 55, 255);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.minDistance = 7;
  controls.maxDistance = 460;
  controls.enablePan = false;

  const world = new THREE.Group();
  scene.add(world);
  world.add(buildShell());
  scene.add(buildStars());

  const orbTexture = radialTexture(64, ORB_STOPS);

  let drawNodes: DrawNode[] = [];
  let drawEdges: DrawEdge[] = [];
  let byId = new Map<string, DrawNode>();
  let neighbours = new Map<string, Set<string>>();

  let orbs: THREE.Points | null = null;
  let glows: THREE.Points | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let pulses: THREE.Points | null = null;
  /** What the edge colours were last written for; they only change with it. */
  let edgesLitFor: string | undefined;
  /** The focus the named links were chosen for; `null` after a rebuild. */
  let labelledFor: string | undefined | null = null;
  let labelledLinks = new Set<string>();

  // Capped on screen, so zooming toward a note does not fill the view with one disc.
  const scale = { value: 600 };
  const orbUniforms = { uScale: scale, uMax: { value: 64 } };
  const glowUniforms = { uScale: scale, uMax: { value: 192 }, map: { value: orbTexture } };
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  const disposeGraph = (): void => {
    for (const object of [orbs, glows, edgeLines, pulses]) {
      if (object !== null) {
        world.remove(object);
      }
    }

    for (const item of disposables.splice(0)) {
      item.dispose();
    }

    orbs = glows = edgeLines = pulses = null;
  };

  const rebuild = (
    nextNodes: readonly VaultSphereNode[],
    nextEdges: readonly VaultSphereEdge[],
  ): void => {
    const degree = degreeOf(uniqueLinks(nextEdges));

    byId = new Map();
    drawNodes = nextNodes
      .filter((node) => node.x !== undefined && node.y !== undefined && node.z !== undefined)
      .map((node) => {
        const world3 = toWorld({ x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 });
        const entry: DrawNode = {
          id: node.id,
          name: node.name,
          type: node.type,
          degree: degree.get(node.id) ?? 0,
          written: node.path != null,
          // Derived from the id, not `Math.random()`: a rebuild must not
          // resynchronise the breathing of every node on screen.
          phase: (node.id.charCodeAt(0) % 32) * 0.196,
          position: new THREE.Vector3(world3.x, world3.y, world3.z),
        };

        byId.set(node.id, entry);

        return entry;
      });

    const present = uniqueLinks(
      nextEdges.filter((edge) => byId.has(edge.source) && byId.has(edge.target)),
    );

    neighbours = new Map();

    for (const edge of present) {
      if (!neighbours.has(edge.source)) {
        neighbours.set(edge.source, new Set());
      }
      if (!neighbours.has(edge.target)) {
        neighbours.set(edge.target, new Set());
      }

      neighbours.get(edge.source)?.add(edge.target);
      neighbours.get(edge.target)?.add(edge.source);
    }

    // Every link is drawn, so a focused hub shows all of its links; thinning
    // only decides which ones are visible when nothing is focused.
    const resting = new Set(thinEdges(present).map((edge) => edge.id));

    drawEdges = present.map((edge) => ({
      a: byId.get(edge.source) as DrawNode,
      b: byId.get(edge.target) as DrawNode,
      resting: resting.has(edge.id),
    }));
    edgesLitFor = undefined;
    labelledFor = null;

    disposeGraph();

    if (drawNodes.length === 0) {
      return;
    }

    // Glow first, so the orbs draw over their own light.
    const glowGeometry = pointsGeometry(drawNodes.length);
    const glowMaterial = new THREE.ShaderMaterial({
      uniforms: glowUniforms,
      vertexShader: POINT_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    glows = new THREE.Points(glowGeometry, glowMaterial);
    disposables.push(glowGeometry, glowMaterial);
    world.add(glows);

    // Normal blending, not additive: overlapping orbs must stay orbs rather
    // than stacking into a white clump.
    const orbGeometry = pointsGeometry(drawNodes.length);
    const orbMaterial = new THREE.ShaderMaterial({
      uniforms: orbUniforms,
      vertexShader: POINT_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    orbs = new THREE.Points(orbGeometry, orbMaterial);
    disposables.push(orbGeometry, orbMaterial);
    world.add(orbs);

    // Edge geometry is written once, not every frame: the nodes do not move, so the
    // only thing that can change about an edge is its colour.
    const edgeGeometry = new THREE.BufferGeometry();
    const edgeVertices = drawEdges.length * EDGE_SEGS * 2;
    const edgePositions = new Float32Array(edgeVertices * 3);
    let vertex = 0;

    for (const edge of drawEdges) {
      const control = edgeControl(edge.a.position, edge.b.position);

      for (let segment = 0; segment < EDGE_SEGS; segment += 1) {
        for (const t of [segment / EDGE_SEGS, (segment + 1) / EDGE_SEGS]) {
          const point = bezier(edge.a.position, control, edge.b.position, t);
          edgePositions.set([point.x, point.y, point.z], vertex * 3);
          vertex += 1;
        }
      }
    }

    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(edgeVertices * 3), 3),
    );

    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    disposables.push(edgeGeometry, edgeMaterial);
    world.add(edgeLines);

    if (!reduceMotion && drawEdges.length > 0) {
      const pulseGeometry = new THREE.BufferGeometry();
      pulseGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(drawEdges.length * 3), 3),
      );
      pulseGeometry.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(drawEdges.length * 3), 3),
      );

      const pulseMaterial = new THREE.PointsMaterial({
        size: PULSE_SIZE,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        // Without an explicit opacity these render at full strength and
        // additive blending stacks them into white clumps wherever edges
        // converge — exactly where the nodes need to read.
        opacity: PULSE_OPACITY,
        depthWrite: false,
        sizeAttenuation: true,
      });

      pulses = new THREE.Points(pulseGeometry, pulseMaterial);
      disposables.push(pulseGeometry, pulseMaterial);
      world.add(pulses);
    }
  };

  const resize = (): void => {
    const rect = mount.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    scale.value = (height * dpr) / Math.tan((camera.fov * Math.PI) / 360);
    orbUniforms.uMax.value = 64 * dpr;
    glowUniforms.uMax.value = 192 * dpr;
    labelCanvas.width = Math.floor(width * dpr);
    labelCanvas.height = Math.floor(height * dpr);
  };

  resize();

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(mount);

  // Donor picking: screen-space with a generous hit radius, which behaves far
  // better on small glowing dots than a raycaster against 1-unit spheres.
  const scratch = new THREE.Vector3();
  const project = (node: DrawNode): { x: number; y: number; behind: boolean; depth: number } => {
    scratch.copy(node.position).applyMatrix4(world.matrixWorld).project(camera);

    const rect = renderer.domElement.getBoundingClientRect();

    return {
      x: ((scratch.x + 1) / 2) * rect.width,
      y: ((1 - scratch.y) / 2) * rect.height,
      behind: scratch.z > 1,
      depth: scratch.z,
    };
  };

  const nodeAt = (clientX: number, clientY: number): DrawNode | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: DrawNode | null = null;
    let bestDistance = Infinity;
    let bestDepth = Infinity;

    for (const node of drawNodes) {
      const screen = project(node);

      if (screen.behind) {
        continue;
      }

      const distance = Math.hypot(screen.x - px, screen.y - py);

      if (distance < 14 && (distance < bestDistance || screen.depth < bestDepth)) {
        best = node;
        bestDistance = distance;
        bestDepth = screen.depth;
      }
    }

    return best;
  };

  let hover: DrawNode | null = null;
  let pointerDownAt: { x: number; y: number } | null = null;

  const onPointerMove = (event: PointerEvent): void => {
    if (event.buttons > 0) {
      return;
    }

    hover = nodeAt(event.clientX, event.clientY);
    renderer.domElement.style.cursor = hover === null ? "grab" : "pointer";
  };

  const onPointerDown = (event: PointerEvent): void => {
    pointerDownAt = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent): void => {
    const start = pointerDownAt;
    pointerDownAt = null;

    // A drag that ends over a node is an orbit, not a click.
    if (start === null || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      return;
    }

    callbacks.onSelect(nodeAt(event.clientX, event.clientY)?.id);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    const node = nodeAt(event.clientX, event.clientY);

    if (node !== null) {
      callbacks.onIsolate(node.id);
    }
  };

  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("dblclick", onDoubleClick);

  let flownTo: string | undefined;
  let flying = false;
  let userBusyUntil = 0;
  controls.addEventListener("start", () => {
    userBusyUntil = Infinity;
    // Grabbing the globe mid-turn hands it to the user.
    flying = false;
  });
  controls.addEventListener("end", () => {
    userBusyUntil = performance.now() + 2500;
  });

  const labelContext = labelCanvas.getContext("2d");
  const colour = new THREE.Color();
  const edgeColour = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const toCamera = new THREE.Vector3();
  const toNode = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const step = new THREE.Quaternion();
  /** Front of the globe, as each node was last drawn: 1 facing the camera, 0 behind. */
  const front = new Map<string, number>();

  /**
   * How lit each node is, eased toward its target so focus changes fade:
   * 1 focused or hovered, 0.85 linked to the focus, 0.5 at rest, 0.15 dimmed.
   */
  const level = new Map<string, number>();
  let frame = 0;
  let last = performance.now();

  const draw = (): void => {
    frame = requestAnimationFrame(draw);

    const now = performance.now();
    const delta = Math.min(50, now - last);
    last = now;

    const focusId = callbacks.focusId();

    if (!reduceMotion && now > userBusyUntil && focusId === undefined) {
      world.rotation.y += delta * 0.00005;
    }

    world.updateMatrixWorld();
    toCamera.copy(camera.position).normalize();

    // A hub's links fade as they multiply, so focusing one reads as a fan
    // of threads rather than a solid white starburst.
    const share = (id: string | undefined): number =>
      Math.min(1, 2.5 / Math.sqrt(Math.max(1, neighbours.get(id ?? "")?.size ?? 1)));

    const fan = share(focusId ?? hover?.id);
    const hoverSet = hover === null ? null : neighbours.get(hover.id);
    const focusSet = focusId === undefined ? null : neighbours.get(focusId);

    if (orbs !== null && glows !== null) {
      const attribute = (points: THREE.Points, name: string): THREE.BufferAttribute =>
        points.geometry.getAttribute(name) as THREE.BufferAttribute;
      const orbPosition = attribute(orbs, "position");
      const orbColour = attribute(orbs, "color");
      const orbSize = attribute(orbs, "size");
      const orbAlpha = attribute(orbs, "alpha");
      const glowPosition = attribute(glows, "position");
      const glowColour = attribute(glows, "color");
      const glowSize = attribute(glows, "size");
      const glowAlpha = attribute(glows, "alpha");

      for (let index = 0; index < drawNodes.length; index += 1) {
        const node = drawNodes[index] as DrawNode;
        const isKey = hover?.id === node.id || focusId === node.id;
        const isLinked = (hoverSet?.has(node.id) ?? false) || (focusSet?.has(node.id) ?? false);
        // Hover lights a neighbourhood without dimming the rest, so sweeping
        // the pointer across the globe does not make it flicker.
        const target = isKey ? 1 : isLinked ? 0.85 : focusId !== undefined ? 0.15 : 0.5;
        const previous = level.get(node.id) ?? 0.5;
        const eased = reduceMotion ? target : previous + (target - previous) * 0.15;
        level.set(node.id, eased);

        const lit = THREE.MathUtils.clamp((eased - 0.5) / 0.35, 0, 1);
        const key = THREE.MathUtils.clamp((eased - 0.85) / 0.15, 0, 1);
        const presence = 0.3 + 0.7 * THREE.MathUtils.clamp((eased - 0.15) / 0.35, 0, 1);

        toNode.copy(node.position).applyMatrix4(world.matrixWorld);
        const facing = (toNode.dot(toCamera) / CONTENT_R + 1) / 2;
        front.set(node.id, facing);

        const slot = slotFor(node.type) - 1;
        const typeColour = PALETTE[slot] ?? white;

        colour
          .copy(REST_PALETTE[slot] ?? white)
          .lerp(typeColour, lit * 0.8)
          .lerp(white, key * 0.6)
          .multiplyScalar(0.55 + 0.45 * facing);

        const resting = (0.15 + 0.7 * facing) * (node.written ? 1 : 0.55);
        const alpha = (resting + (0.65 + 0.35 * facing - resting) * lit) * presence;

        let radius = radiusFor(node.degree) * (1 + 0.25 * key);

        if (!reduceMotion) {
          radius *= 1 + 0.04 * Math.sin(now / 1100 + node.phase);
        }

        const { x, y, z } = node.position;
        orbPosition.setXYZ(index, x, y, z);
        orbColour.setXYZ(index, colour.r, colour.g, colour.b);
        orbSize.setX(index, radius);
        orbAlpha.setX(index, alpha);

        colour.copy(typeColour).lerp(white, key * 0.4);
        glowPosition.setXYZ(index, x, y, z);
        glowColour.setXYZ(index, colour.r, colour.g, colour.b);
        glowSize.setX(index, radius * (2.5 + 2.5 * key));
        glowAlpha.setX(index, lit * (0.35 * fan + 0.65 * key) * (0.5 + 0.5 * facing));
      }

      for (const changed of [
        orbPosition,
        orbColour,
        orbSize,
        orbAlpha,
        glowPosition,
        glowColour,
        glowSize,
        glowAlpha,
      ]) {
        changed.needsUpdate = true;
      }
    }

    const touches = (edge: DrawEdge): boolean =>
      hover?.id === edge.a.id ||
      hover?.id === edge.b.id ||
      focusId === edge.a.id ||
      focusId === edge.b.id;

    const litFor = `${hover?.id ?? ""}|${focusId ?? ""}`;

    if (edgeLines !== null && litFor !== edgesLitFor) {
      edgesLitFor = litFor;
      const colours = edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
      let vertex = 0;

      for (const edge of drawEdges) {
        if (touches(edge)) {
          const end = focusId === edge.a.id || focusId === edge.b.id ? focusId : hover?.id;
          edgeColour.copy(LIT_EDGE).multiplyScalar(share(end));
        } else if (edge.resting) {
          edgeColour.copy(REST_EDGE).multiplyScalar(focusId === undefined ? 1 : 0.35);
        } else {
          edgeColour.setRGB(0, 0, 0);
        }

        for (let point = 0; point < EDGE_SEGS * 2; point += 1) {
          colours.setXYZ(vertex, edgeColour.r, edgeColour.g, edgeColour.b);
          vertex += 1;
        }
      }

      colours.needsUpdate = true;
    }

    if (pulses !== null) {
      const positions = pulses.geometry.getAttribute("position") as THREE.BufferAttribute;
      const colours = pulses.geometry.getAttribute("color") as THREE.BufferAttribute;

      drawEdges.forEach((edge, index) => {
        // Pulses show which way the focus reaches, so only its links carry them.
        if (!touches(edge)) {
          colours.setXYZ(index, 0, 0, 0);
          return;
        }

        const t = (now / 4200 + index * 0.618) % 1;
        const point = bezier(
          edge.a.position,
          edgeControl(edge.a.position, edge.b.position),
          edge.b.position,
          t,
        );
        const end = focusId === edge.a.id || focusId === edge.b.id ? focusId : hover?.id;
        const fade = Math.sin(t * Math.PI) * 0.7 * share(end);

        positions.setXYZ(index, point.x, point.y, point.z);
        colours.setXYZ(index, 0.55 * fade, 0.8 * fade, fade);
      });

      positions.needsUpdate = true;
      colours.needsUpdate = true;
    }

    if (focusId !== flownTo) {
      flownTo = focusId;
      flying = focusId !== undefined;
    }

    // Turn the globe to face the focused note, at whatever zoom the user chose.
    // Diving inside the sphere to reach it hid the very context it sits in.
    const selected = flying && flownTo !== undefined ? byId.get(flownTo) : undefined;

    if (selected !== undefined) {
      toNode.copy(selected.position).applyMatrix4(world.matrixWorld).normalize();

      if (toCamera.angleTo(toNode) < 0.01) {
        flying = false;
      } else {
        turn.setFromUnitVectors(toCamera, toNode);
        step.identity().slerp(turn, reduceMotion ? 1 : 0.07);
        camera.position.applyQuaternion(step);
      }
    }

    controls.update();
    renderer.render(scene, camera);

    if (labelContext !== null) {
      const rect = renderer.domElement.getBoundingClientRect();
      labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      labelContext.clearRect(0, 0, rect.width, rect.height);
      labelContext.textAlign = "left";
      labelContext.textBaseline = "middle";

      if (focusId !== labelledFor) {
        labelledFor = focusId;
        labelledLinks = new Set(
          [...(focusSet ?? [])]
            .sort((a, b) => (byId.get(b)?.degree ?? 0) - (byId.get(a)?.degree ?? 0))
            .slice(0, LABELLED_LINKS),
        );
      }

      const halfHeight = rect.height / 2;
      const tanFov = Math.tan((camera.fov * Math.PI) / 360);
      const candidates: Array<
        LabelBox & { rank: number; size: number; opacity: number; text: string; key: boolean }
      > = [];

      for (const node of drawNodes) {
        const screen = project(node);
        const isKey = hover?.id === node.id || focusId === node.id;
        const isLinked = labelledLinks.has(node.id);
        const facing = front.get(node.id) ?? 1;

        // A name on the far side of the globe floats over the notes in front of it.
        if (screen.behind || (!isKey && facing < 0.45)) {
          continue;
        }

        const distance = scratch
          .copy(node.position)
          .applyMatrix4(world.matrixWorld)
          .distanceTo(camera.position);
        const onScreenRadius = (radiusFor(node.degree) * halfHeight) / (distance * tanFov);
        const opacity = isLinked
          ? 0.8
          : labelOpacity(onScreenRadius, isKey) * (focusId !== undefined && !isKey ? 0.4 : 1);

        if (opacity === 0) {
          continue;
        }

        const text = node.name.length > 32 ? `${node.name.slice(0, 31)}…` : node.name;
        labelContext.font = isKey ? `600 13px ${typography.family}` : `12px ${typography.family}`;

        candidates.push({
          id: node.id,
          x: screen.x + Math.min(onScreenRadius, 32) + 6,
          y: screen.y - 8,
          width: labelContext.measureText(text).width,
          height: 16,
          rank: isKey ? 0 : isLinked ? 1 : 2,
          size: onScreenRadius,
          opacity: opacity * (0.5 + 0.5 * facing),
          text,
          key: isKey,
        });
      }

      candidates.sort((a, b) => a.rank - b.rank || b.size - a.size);

      const shown = placeLabels(candidates);

      labelContext.shadowColor = "rgba(5, 6, 12, 0.9)";
      labelContext.shadowBlur = 4;

      for (const label of candidates) {
        if (!shown.has(label.id)) {
          continue;
        }

        labelContext.font = label.key
          ? `600 13px ${typography.family}`
          : `12px ${typography.family}`;
        labelContext.fillStyle = label.key
          ? `rgba(244, 240, 255, ${String(label.opacity)})`
          : `rgba(200, 210, 232, ${String(label.opacity)})`;
        labelContext.fillText(label.text, label.x, label.y + label.height / 2);
      }

      labelContext.shadowBlur = 0;
    }
  };

  frame = requestAnimationFrame(draw);

  return {
    rebuild,
    dispose() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      controls.dispose();
      disposeGraph();
      orbTexture.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = mesh.material as THREE.Material | THREE.Material[] | undefined;

        if (Array.isArray(materials)) {
          for (const item of materials) {
            item.dispose();
          }
        } else {
          materials?.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export function VaultSphere({
  nodes,
  edges,
  focusId,
  onFocus,
  onOpen,
  heightPx = 560,
}: VaultSphereProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene>();
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  const [isolated, setIsolated] = useState<string>();

  // Isolation is the donor's double-click "focus its neighbourhood", and it is
  // the one thing Section 7 calls focus isolation: a focused view opens only
  // the relevant subgraph, never a miniature full Vault.
  const visible = useMemo(() => focusSubgraph(edges, isolated), [edges, isolated]);

  const shownNodes = useMemo(
    () =>
      nodes.filter(
        (node) =>
          node.x !== undefined &&
          node.y !== undefined &&
          node.z !== undefined &&
          (visible === undefined || visible.has(node.id)),
      ),
    [nodes, visible],
  );

  const shownEdges = useMemo(
    () =>
      edges.filter(
        (edge) => visible === undefined || (visible.has(edge.source) && visible.has(edge.target)),
      ),
    [edges, visible],
  );

  useEffect(() => {
    const mount = mountRef.current;
    const labelCanvas = labelRef.current;

    if (mount === null || labelCanvas === null) {
      return;
    }

    const scene = createScene(mount, labelCanvas, {
      focusId: () => focusRef.current,
      onSelect: (id) => {
        onFocusRef.current?.(id);
      },
      onIsolate: (id) => {
        setIsolated((current) => (current === id ? undefined : id));
        onFocusRef.current?.(id);
      },
    });

    sceneRef.current = scene;

    return () => {
      scene?.dispose();
      sceneRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.rebuild(shownNodes, shownEdges);
  }, [shownNodes, shownEdges]);

  const degree = useMemo(() => degreeOf(shownEdges), [shownEdges]);
  const focused = nodes.find((node) => node.id === focusId);

  return (
    <div style={{ display: "grid", gap: spacing.sm, minWidth: 0 }}>
      <div
        role="group"
        aria-label="Vault view controls"
        style={{ display: "flex", gap: spacing.xs }}
      >
        <Control
          label={isolated === undefined ? "Isolate the focused note" : "Show the whole Vault"}
          disabled={isolated === undefined && focusId === undefined}
          onAct={() => {
            setIsolated((current) => (current === undefined ? focusId : undefined));
          }}
        />
        <Control
          label="Clear focus"
          disabled={focusId === undefined && isolated === undefined}
          onAct={() => {
            setIsolated(undefined);
            onFocus?.(undefined);
          }}
        />
        {focused !== undefined && focused.path != null && onOpen !== undefined && (
          <Control
            label={`Open ${focused.name}`}
            onAct={() => {
              onOpen(focused);
            }}
          />
        )}
      </div>

      <div
        ref={mountRef}
        // The canvas is decoration for this data, and the data is the list
        // below it. Announcing both would read the Vault out twice, once as an
        // unlabelled image.
        aria-hidden="true"
        style={{
          position: "relative",
          height: heightPx,
          background: depthTokens.layers[0],
          border: `1px solid ${material.border}`,
          borderRadius: corner.lg,
          overflow: "hidden",
          cursor: "grab",
        }}
      >
        <canvas
          ref={labelRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      </div>

      <ul
        aria-label={
          isolated === undefined
            ? `Vault notes, ${String(shownNodes.length)}`
            : `Focused subgraph, ${String(shownNodes.length)} notes`
        }
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: spacing.xs,
          maxHeight: 160,
          overflowY: "auto",
        }}
      >
        {shownNodes.map((node) => {
          const isFocus = node.id === focusId;

          return (
            <li key={node.id}>
              <button
                type="button"
                aria-pressed={isFocus}
                onClick={() => {
                  onFocus?.(isFocus ? undefined : node.id);
                }}
                onDoubleClick={() => {
                  setIsolated((current) => (current === node.id ? undefined : node.id));
                }}
                onKeyDown={(event) => {
                  // `o` opens the note, matching the control above it; the
                  // canvas has no equivalent, which is the point.
                  if (event.key === "o" && node.path != null) {
                    event.preventDefault();
                    onOpen?.(node);
                  }
                }}
                style={{
                  minHeight: 44,
                  font: `${String(typography.scale.xs)}px ${typography.family}`,
                  background: isFocus ? material.fillElevated : material.fill,
                  color: "inherit",
                  border: `1px solid ${isFocus ? TYPE_COLOUR[node.type] : material.border}`,
                  borderRadius: corner.sm,
                  padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
                  cursor: "pointer",
                }}
              >
                <span aria-hidden="true" style={{ color: TYPE_COLOUR[node.type] }}>
                  ●{" "}
                </span>
                {node.name}
                {/* Type and unwritten-ness are words, never only a colour. */}
                <span style={{ color: typography.color.muted }}>
                  {" "}
                  · {node.type}
                  {node.path == null ? " · not written yet" : ""} ·{" "}
                  {String(degree.get(node.id) ?? 0)} links
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ControlProps {
  label: string;
  onAct: () => void;
  disabled?: boolean;
}

function Control({ label, onAct, disabled = false }: ControlProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onAct}
      disabled={disabled}
      style={{
        minHeight: 44,
        font: `${String(typography.scale.xs)}px ${typography.family}`,
        background: material.fill,
        color: "inherit",
        border: `1px solid ${material.border}`,
        borderRadius: corner.sm,
        padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
