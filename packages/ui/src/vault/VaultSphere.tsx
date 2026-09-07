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
import type { SphereEdge } from "./sphere.js";
import {
  EDGE_SEGS,
  R,
  bezier,
  degreeOf,
  edgeControl,
  labelOpacity,
  radiusFor,
  slotFor,
  thinEdges,
  toWorld,
} from "./sphere.js";

/**
 * The dedicated Vault view: a rotating sphere-brain.
 *
 * Ported from `Jarvis-Sub-Agent-Dashboard` at commit `ee7b4527`,
 * `client/src/components/VaultSphere.tsx`. MIT licence, Copyright (c) 2026 -
 * Now, Son Nguyen. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * Three things differ from the donor, and only three:
 *
 * 1. There is no force simulation. Coordinates arrive settled from
 *    `vault_layout` and are drawn where they are, so Section 7's "remove
 *    continuous force wandering" is structural rather than a flag. That also
 *    makes every client's sphere identical, which a per-client solver could
 *    not promise.
 * 2. `SphereFx` is gone — engine scan/spark/birth flashes and hot edges are
 *    donor coupling with no Noctis event behind them.
 * 3. Everything the canvas can do, the keyboard can do. The donor component has
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
  /** The node under discussion. The camera flies to it and its label is pinned. */
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

const PALETTE: readonly THREE.Color[] = (
  ["capture", "project", "person", "reference", "daily", "agent", "note"] as const
).map((type) => new THREE.Color(TYPE_COLOUR[type]));

// Donor visual balance. The nodes are the data; edges and pulses are context,
// and keeping the context translucent is what lets the clusters read.
const SHELL_OPACITY = 0.05;
const EDGE_OPACITY = 0.11;
const PULSE_OPACITY = 0.5;
const PULSE_SIZE = 1.9;

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
  const count = 420;
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const point = new THREE.Vector3()
      .randomDirection()
      .multiplyScalar(R * (0.3 + Math.random() * 1.8));

    positions.set([point.x, point.y, point.z], i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xaabbdd,
      size: 0.9,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      sizeAttenuation: true,
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

const CORE_STOPS: ReadonlyArray<[number, string]> = [
  [0, "rgba(255, 235, 240, 1)"],
  [0.25, "rgba(255, 190, 205, 0.55)"],
  [0.6, "rgba(200, 120, 160, 0.14)"],
  [1, "rgba(0, 0, 0, 0)"],
];

interface DrawNode {
  id: string;
  name: string;
  type: VaultEntityType;
  degree: number;
  /** Donor: a per-node offset so the breathing does not pulse in unison. */
  phase: number;
  position: THREE.Vector3;
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
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return undefined;
  }

  const reduceMotion = prefersReducedMotion();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  renderer.setPixelRatio(dpr);
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  mount.appendChild(renderer.domElement);

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
  const coreTexture = radialTexture(128, CORE_STOPS);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: coreTexture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  glow.scale.setScalar(38);
  world.add(glow);

  const crystal = new THREE.Mesh(
    new THREE.IcosahedronGeometry(5.2, 0),
    new THREE.MeshBasicMaterial({ color: 0xffd9e2, transparent: true, opacity: 0.92 }),
  );
  world.add(crystal);

  const cage = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(7.4, 0)),
    new THREE.LineBasicMaterial({
      color: 0xffc7d8,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
  );
  world.add(cage);

  let drawNodes: DrawNode[] = [];
  let drawEdges: Array<{ a: DrawNode; b: DrawNode }> = [];
  let byId = new Map<string, DrawNode>();
  let neighbours = new Map<string, Set<string>>();

  let nodeMesh: THREE.InstancedMesh | null = null;
  let haloPoints: THREE.Points | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  let rays: THREE.LineSegments | null = null;
  let pulses: THREE.Points | null = null;

  const haloUniforms = { uScale: { value: 600 }, map: { value: orbTexture } };
  const nodeGeometry = new THREE.SphereGeometry(1, 10, 8);
  const dummy = new THREE.Object3D();
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  const disposeGraph = (): void => {
    for (const object of [nodeMesh, haloPoints, edgeLines, rays, pulses]) {
      if (object !== null) {
        world.remove(object);
      }
    }

    for (const item of disposables.splice(0)) {
      item.dispose();
    }

    nodeMesh = haloPoints = edgeLines = rays = pulses = null;
  };

  const rebuild = (
    nextNodes: readonly VaultSphereNode[],
    nextEdges: readonly VaultSphereEdge[],
  ): void => {
    const degree = degreeOf(nextEdges);

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
          // Derived from the id, not `Math.random()`: a rebuild must not
          // resynchronise the breathing of every node on screen.
          phase: (node.id.charCodeAt(0) % 32) * 0.196,
          position: new THREE.Vector3(world3.x, world3.y, world3.z),
        };

        byId.set(node.id, entry);

        return entry;
      });

    const present = nextEdges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));

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

    drawEdges = thinEdges(present).map((edge) => ({
      a: byId.get(edge.source) as DrawNode,
      b: byId.get(edge.target) as DrawNode,
    }));

    disposeGraph();

    if (drawNodes.length === 0) {
      return;
    }

    const nodeMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, drawNodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    disposables.push(nodeMaterial);
    world.add(nodeMesh);

    // Glow sprites behind each node: the radial falloff is what makes them read
    // as light sources rather than beads.
    const haloGeometry = new THREE.BufferGeometry();
    haloGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(drawNodes.length * 3), 3),
    );
    haloGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(drawNodes.length * 3), 3),
    );
    haloGeometry.setAttribute(
      "size",
      new THREE.BufferAttribute(new Float32Array(drawNodes.length), 1),
    );

    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float uScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor;
        void main() {
          gl_FragColor = vec4(vColor, 1.0) * texture2D(map, gl_PointCoord);
        }`,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    haloPoints = new THREE.Points(haloGeometry, haloMaterial);
    disposables.push(haloGeometry, haloMaterial);
    world.add(haloPoints);

    // Edge geometry is written once, not every frame: the nodes do not move, so the
    // only thing a frame can change about an edge is its colour.
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
      opacity: EDGE_OPACITY,
      depthWrite: false,
    });

    edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    disposables.push(edgeGeometry, edgeMaterial);
    world.add(edgeLines);

    // Core rays: short filaments spilling from the crystal. Full lines to every
    // node read as a cluttered sunburst at Vault scale, not as a glow.
    const rayGeometry = new THREE.BufferGeometry();
    const rayPositions = new Float32Array(drawNodes.length * 2 * 3);

    drawNodes.forEach((node, index) => {
      rayPositions.set([0, 0, 0], index * 6);
      rayPositions.set(
        [node.position.x * 0.22, node.position.y * 0.22, node.position.z * 0.22],
        index * 6 + 3,
      );
    });

    rayGeometry.setAttribute("position", new THREE.BufferAttribute(rayPositions, 3));

    const rayMaterial = new THREE.LineBasicMaterial({
      color: 0xffe0ea,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    rays = new THREE.LineSegments(rayGeometry, rayMaterial);
    disposables.push(rayGeometry, rayMaterial);
    world.add(rays);

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
    haloUniforms.uScale.value = (height * dpr) / Math.tan((camera.fov * Math.PI) / 360);
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

  let userBusyUntil = 0;
  controls.addEventListener("start", () => {
    userBusyUntil = Infinity;
  });
  controls.addEventListener("end", () => {
    userBusyUntil = performance.now() + 2500;
  });

  const labelContext = labelCanvas.getContext("2d");
  const colour = new THREE.Color();
  const edgeColour = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const grey = new THREE.Color(0.32, 0.35, 0.4);
  const baseEdge = new THREE.Color(0.22, 0.32, 0.45);
  const litEdge = new THREE.Color(0.55, 0.78, 0.95);

  const glowLevel = new Map<string, number>();
  let flownTo: string | undefined;
  let flying = false;
  const flyTarget = new THREE.Vector3();
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

    const corePulse = reduceMotion ? 1 : 1 + 0.08 * Math.sin(now / 900);
    glow.scale.setScalar(38 * corePulse);
    crystal.rotation.y += delta * 0.0004;
    crystal.rotation.x += delta * 0.00013;
    cage.rotation.y -= delta * 0.00025;
    crystal.scale.setScalar(corePulse);

    const hoverSet = hover === null ? null : neighbours.get(hover.id);
    const focusSet = focusId === undefined ? null : neighbours.get(focusId);
    const dimming = hover !== null || focusId !== undefined;

    if (nodeMesh !== null) {
      const haloPosition = haloPoints?.geometry.getAttribute("position") as
        THREE.BufferAttribute | undefined;
      const haloColour = haloPoints?.geometry.getAttribute("color") as
        THREE.BufferAttribute | undefined;
      const haloSize = haloPoints?.geometry.getAttribute("size") as
        THREE.BufferAttribute | undefined;

      for (let index = 0; index < drawNodes.length; index += 1) {
        const node = drawNodes[index] as DrawNode;
        const isHover = hover?.id === node.id;
        const isFocus = focusId === node.id;
        const isNeighbour = (hoverSet?.has(node.id) ?? false) || (focusSet?.has(node.id) ?? false);
        const lit = isHover || isFocus || isNeighbour;
        const target = dimming && !lit ? 0.18 : 1;
        const level =
          (glowLevel.get(node.id) ?? 1) + (target - (glowLevel.get(node.id) ?? 1)) * 0.15;
        glowLevel.set(node.id, level);

        let scale = radiusFor(node.degree);

        if (!reduceMotion) {
          scale *= 1 + 0.07 * Math.sin(now / 1100 + node.phase);
        }

        // Dimmed nodes desaturate rather than only darken, so the lit set pops.
        const litAmount = THREE.MathUtils.clamp((level - 0.18) / 0.82, 0, 1);
        colour.copy(PALETTE[slotFor(node.type) - 1] ?? white).lerp(grey, 1 - litAmount);
        colour.multiplyScalar(0.3 + 0.7 * level);

        if (isHover || isFocus) {
          colour.lerp(white, 0.35);
        }

        haloPosition?.setXYZ(index, node.position.x, node.position.y, node.position.z);
        // Brighter than the node body: it has to read as the light source.
        haloColour?.setXYZ(index, colour.r * 1.35, colour.g * 1.35, colour.b * 1.35);
        haloSize?.setX(index, scale * 3.5);

        colour.lerp(white, 0.22);
        dummy.position.copy(node.position);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        nodeMesh.setMatrixAt(index, dummy.matrix);
        nodeMesh.setColorAt(index, colour);
      }

      nodeMesh.instanceMatrix.needsUpdate = true;

      if (nodeMesh.instanceColor !== null) {
        nodeMesh.instanceColor.needsUpdate = true;
      }

      for (const attribute of [haloPosition, haloColour, haloSize]) {
        if (attribute !== undefined) {
          attribute.needsUpdate = true;
        }
      }
    }

    if (edgeLines !== null) {
      const colours = edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
      let vertex = 0;

      for (const edge of drawEdges) {
        const touching =
          hover?.id === edge.a.id ||
          hover?.id === edge.b.id ||
          focusId === edge.a.id ||
          focusId === edge.b.id;

        edgeColour.copy(touching ? litEdge : baseEdge);

        if (!touching && dimming) {
          edgeColour.multiplyScalar(0.35);
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
        const t = (now / 4200 + index * 0.618) % 1;
        const point = bezier(
          edge.a.position,
          edgeControl(edge.a.position, edge.b.position),
          edge.b.position,
          t,
        );

        positions.setXYZ(index, point.x, point.y, point.z);

        const fade = Math.sin(t * Math.PI) * (dimming ? 0.25 : 0.7);
        colours.setXYZ(index, 0.55 * fade, 0.8 * fade, fade);
      });

      positions.needsUpdate = true;
      colours.needsUpdate = true;
    }

    if (focusId !== flownTo) {
      flownTo = focusId;
      const node = focusId === undefined ? undefined : byId.get(focusId);
      flyTarget.copy(
        node === undefined
          ? new THREE.Vector3()
          : node.position.clone().applyMatrix4(world.matrixWorld),
      );
      flying = true;
    }

    if (flying) {
      const selected = flownTo === undefined ? undefined : byId.get(flownTo);

      if (selected !== undefined) {
        flyTarget.copy(selected.position).applyMatrix4(world.matrixWorld);
      }

      controls.target.lerp(flyTarget, 0.08);

      if (selected !== undefined) {
        const want = Math.max(controls.minDistance, 62);
        const distance = camera.position.distanceTo(controls.target);
        camera.position
          .sub(controls.target)
          .multiplyScalar(1 + ((want - distance) / distance) * 0.08)
          .add(controls.target);
      }

      if (controls.target.distanceTo(flyTarget) < 0.5) {
        flying = false;
      }
    }

    controls.update();
    renderer.render(scene, camera);

    if (labelContext !== null) {
      const rect = renderer.domElement.getBoundingClientRect();
      labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      labelContext.clearRect(0, 0, rect.width, rect.height);
      labelContext.textAlign = "center";
      labelContext.font = `11px ${typography.family}`;

      const halfHeight = rect.height / 2;
      const tanFov = Math.tan((camera.fov * Math.PI) / 360);

      for (const node of drawNodes) {
        const screen = project(node);

        if (screen.behind) {
          continue;
        }

        const distance = scratch
          .copy(node.position)
          .applyMatrix4(world.matrixWorld)
          .distanceTo(camera.position);
        const onScreenRadius = (radiusFor(node.degree) * halfHeight) / (distance * tanFov);
        const opacity = labelOpacity(onScreenRadius, hover?.id === node.id || focusId === node.id);

        if (opacity === 0) {
          continue;
        }

        labelContext.fillStyle = `rgba(200, 218, 236, ${String(opacity * (glowLevel.get(node.id) ?? 1))})`;
        labelContext.fillText(node.name.slice(0, 30), screen.x, screen.y + onScreenRadius + 11);
      }
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
      nodeGeometry.dispose();
      orbTexture.dispose();
      coreTexture.dispose();
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
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
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
