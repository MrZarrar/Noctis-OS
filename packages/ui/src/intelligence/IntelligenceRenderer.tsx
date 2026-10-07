import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import type { CorePoint, IntelligenceProfile, IntelligenceState } from "./core.js";
import { buildCoreGeometry, coreAppearance, shouldAnimateCore, VESPER_PROFILE } from "./core.js";

export interface IntelligenceRendererProps {
  identityId: ConversationalIdentityId;
  protocolIds?: readonly ProtocolId[];
  state?: IntelligenceState;
  profile?: IntelligenceProfile;
}

const CORE = buildCoreGeometry();
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
  world.add(new THREE.Mesh(shardGeometry(CORE.shards), glassMaterial));
  const shardLines: CorePoint[] = [];
  for (const shard of CORE.shards) {
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
  world.add(new THREE.LineSegments(buffer(shardLines), borderMaterial));
  const fragmentMaterial = new THREE.MeshBasicMaterial({
    color: VESPER_PROFILE.violet,
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const fragments = new THREE.Mesh(shardGeometry(CORE.fragments), fragmentMaterial);
  world.add(fragments);
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
  crystal.scale.set(0.85, 1.35, 0.85);
  crystal.rotation.set(0.2, 0.4, 0.18);
  world.add(crystal);
  world.add(
    new THREE.Mesh(
      buffer(CORE.fragments.filter((_, index) => index % 5 === 0).flat()),
      new THREE.MeshBasicMaterial({
        color: 0xd4bcff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
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
  const approval = lights([[0.94, 0.1, 0.41]], 39, VESPER_PROFILE.approval);
  approval.visible = false;
  world.add(junctions, dust, glow, approval);
  const pedestal = lights([[0, -2.7, 0]], 48, VESPER_PROFILE.violet);
  scene.add(pedestal);
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
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const canDraw = (): boolean => !disposed && !lost && visible && !document.hidden;
  const animate = (): boolean =>
    canDraw() && shouldAnimateCore(state, motion.matches, visible, document.hidden);
  const render = (now: number): void => {
    const started = performance.now();
    const appearance = coreAppearance(state, profile);
    const moving = animate();
    const beat = moving ? Math.sin(now * (state === "thinking" ? 0.0028 : 0.0018)) : 0;
    world.rotation.set(
      moving ? Math.sin(now * 0.00022) * 0.025 : 0,
      moving ? Math.sin(now * 0.00028) * 0.065 : 0,
      0,
    );
    world.scale.setScalar(appearance.expansion + beat * (state === "speaking" ? 0.014 : 0.004));
    fragments.rotation.z = moving ? Math.sin(now * 0.0008) * 0.035 : 0;
    networkMaterial.color.set(appearance.color);
    networkMaterial.opacity = 0.28 * appearance.light + beat * 0.025;
    glassMaterial.color.set(profile.glass);
    fragmentMaterial.color.set(profile.violet);
    fragmentMaterial.opacity = Math.min(0.92, 0.68 + appearance.light * 0.12 + beat * 0.05);
    approval.visible = appearance.approval;
    const dpr = renderer.getPixelRatio();
    for (const points of [junctions, glow, dust, pedestal, approval]) {
      points.material.uniforms.pixelRatio!.value = dpr;
      (points.material.uniforms.color!.value as THREE.Color).set(
        points === approval ? appearance.approvalColor : appearance.color,
      );
      points.material.uniforms.intensity!.value =
        points === approval ? 1.2 : appearance.light + beat * 0.12;
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
    if (canDraw()) render(0);
    if (active) frame = requestAnimationFrame(tick);
  };
  const resize = (): void => {
    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0 || disposed || lost) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = Math.max(9.2, 5.8 / camera.aspect);
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
          object instanceof THREE.LineSegments ||
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
          points={shard.map((point) => project(point).join(",")).join(" ")}
          fill={profile.glass}
          fillOpacity={0.11 + (index % 3) * 0.04}
          stroke={profile.glass}
          strokeWidth="0.65"
          strokeOpacity="0.7"
        />
      ))}
      {CORE.fragments.map((shard, index) => (
        <polygon
          key={index}
          points={shard.map((point) => project(point).join(",")).join(" ")}
          fill={index % 3 === 0 ? "#e1cfff" : profile.violet}
          fillOpacity={Math.min(0.95, 0.5 * appearance.light)}
          stroke="#c9a9ff"
          strokeWidth="0.5"
        />
      ))}
      <polygon
        points="180,165 169,183 180,201 191,183"
        fill="#b08cff"
        stroke="#dfc8ff"
        strokeWidth="0.7"
      />
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
      <path d="M160 343h40 M180 339v8" stroke={profile.violet} strokeWidth="1.2" />
      {appearance.approval && (
        <g>
          <circle cx="239" cy="177" r="6" fill={profile.approval} opacity="0.2" />
          <circle cx="239" cy="177" r="1.9" fill={profile.approval} />
        </g>
      )}
    </svg>
  );
}

export function IntelligenceRenderer({
  identityId,
  protocolIds = [],
  state = "idle",
  profile = VESPER_PROFILE,
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
