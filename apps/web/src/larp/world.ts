import {
  CAPABILITY_OPERATION_CLASS,
  CapabilityGrantSchema,
  FileSearchConstraintsSchema,
  GrantNodeCapabilityCommandSchema,
  GrantStandingPermissionCommandSchema,
  ModelRefSchema,
  NodeDescriptorSchema,
  ResetSettingCommandSchema,
  RevokeStandingPermissionCommandSchema,
  RuntimeGrantConstraintsSchema,
  SetIdentityDefaultModelCommandSchema,
  SetSettingCommandSchema,
  StandingPermissionSchema,
  UnshareNodeFolderCommandSchema,
} from "@noctis/contracts";
import type {
  CapabilityGrant,
  ExternalSession,
  LiveEntry,
  LiveSession,
  ModelRef,
  NodeDescriptor,
  SessionExchange,
  StandingPermission,
} from "@noctis/contracts";
import { z } from "zod";

import type { AgentQuestion } from "../pages/AgentQuestions.js";
import type { ArtifactSchema } from "../pages/Artifacts.js";
import type { SettingView } from "../pages/CoreSettings.js";
import type { UsageLimitsView } from "../pages/usage-limits-view.js";
import type { CoreResponse } from "../transport/CoreTransport.js";
import type { LarpArea } from "./area.js";
import { ok, parsePath, rebase } from "./area.js";
import fixture from "./fixtures/world.json?raw";

interface WorldFixture {
  nodes: (NodeDescriptor & { connected: boolean })[];
  grants: CapabilityGrant[];
  catalogue: ModelRef[];
  defaults: { vesper: ModelRef; jester: ModelRef };
  permissions: StandingPermission[];
  configuration: { settings: SettingView[]; startUp: { name: string; value: string }[] };
  settingDefaults: Record<string, unknown>;
  limits: UsageLimitsView["limits"];
  artifacts: z.infer<typeof ArtifactSchema>[];
  liveSessions: LiveSession[];
  liveEntries: Record<string, LiveEntry[]>;
  sessions: { nodeId: string; rootGrantId: string; sessions: ExternalSession[] }[];
  history: Record<string, SessionExchange[]>;
  agentQuestions: AgentQuestion[];
  pushPublicKey: string;
}

// Vite bundles the committed JSON without requiring changes to the shared TS project.
const seed = rebase(JSON.parse(fixture) as WorldFixture);
const nodes = seed.nodes.map(({ connected, ...node }) => ({
  ...NodeDescriptorSchema.parse(node),
  connected,
}));
const grants = CapabilityGrantSchema.array().parse(seed.grants);
const permissions = StandingPermissionSchema.array().parse(seed.permissions);
const catalogue = ModelRefSchema.array().parse(seed.catalogue);
const defaults = {
  vesper: ModelRefSchema.parse(seed.defaults.vesper),
  jester: ModelRefSchema.parse(seed.defaults.jester),
};
const configuration = structuredClone(seed.configuration);

/** AskUserQuestion inputs for Claude's conversation fixture. There is no questions endpoint. */
export const worldQuestions = structuredClone(seed.agentQuestions);

const reply = (body: unknown): CoreResponse => ok(structuredClone(body));
const failure = (status: number, code: string, message: string): CoreResponse => ({
  status,
  body: { error: { code, message } },
});
const missing = (entity: string) => failure(404, "not_found", `${entity} was not found`);
const invalid = () => failure(400, "invalid_request", "That request has an invalid value");
const now = () => new Date().toISOString();
let sequence = 1000;
const nextId = () => `01a05c32-9000-7000-8000-${String(++sequence).padStart(12, "0")}`;
const replays = new Map<string, CoreResponse>();

function mutate<T extends { idempotencyKey: string }>(
  name: string,
  schema: z.ZodType<T>,
  body: unknown,
  apply: (command: T) => CoreResponse,
): CoreResponse {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalid();
  const key = `${name}:${parsed.data.idempotencyKey}`;
  const previous = replays.get(key);
  if (previous !== undefined) return structuredClone(previous);
  const response = apply(parsed.data);
  if (response.status === 200) replays.set(key, structuredClone(response));
  return response;
}

function roots() {
  const seen = new Set<string>();
  return grants.flatMap((grant) => {
    if (
      grant.capability !== "runtime.turn" ||
      grant.revokedAt !== undefined ||
      (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.now())
    )
      return [];
    const node = nodes.find((candidate) => candidate.id === grant.nodeId);
    if (node === undefined) return [];
    const constraints = RuntimeGrantConstraintsSchema.parse(grant.constraints);
    return constraints.roots.flatMap((root) => {
      const key = `${node.id}:${root.grantId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...root, nodeId: node.id, hostId: node.hostId, connected: node.connected }];
    });
  });
}

function command(name: string, body: unknown): CoreResponse | undefined {
  switch (name) {
    case "node.grant_capability":
      return mutate(name, GrantNodeCapabilityCommandSchema, body, (input) => {
        if (!nodes.some((node) => node.id === input.nodeId)) return missing("Node");
        const constraints =
          input.capability === "runtime.turn"
            ? RuntimeGrantConstraintsSchema.safeParse(input.constraints)
            : input.capability === "file.search"
              ? FileSearchConstraintsSchema.safeParse(input.constraints)
              : { success: true as const, data: input.constraints ?? {} };
        if (!constraints.success) return invalid();
        const grant = CapabilityGrantSchema.parse({
          id: nextId(),
          nodeId: input.nodeId,
          capability: input.capability,
          operationClass: CAPABILITY_OPERATION_CLASS[input.capability],
          constraintsVersion: 1,
          constraints: structuredClone(constraints.data),
          grantedAt: now(),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        });
        grants.push(grant);
        return reply(grant);
      });
    case "node.unshare_folder":
      return mutate(name, UnshareNodeFolderCommandSchema, body, (input) => {
        const node = nodes.find((candidate) => candidate.id === input.nodeId);
        const naming = grants.filter(
          (grant) =>
            grant.nodeId === input.nodeId &&
            grant.capability === "runtime.turn" &&
            grant.revokedAt === undefined &&
            (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > Date.now()) &&
            RuntimeGrantConstraintsSchema.parse(grant.constraints).roots.some(
              (root) => root.grantId === input.rootGrantId,
            ),
        );
        if (node === undefined || naming.length === 0) return missing("Folder");
        const revokedAt = now();
        for (const grant of naming) {
          const constraints = RuntimeGrantConstraintsSchema.parse(grant.constraints);
          const remaining = constraints.roots.filter((root) => root.grantId !== input.rootGrantId);
          grant.revokedAt = revokedAt;
          if (remaining.length > 0) {
            const replacement = {
              ...grant,
              id: nextId(),
              grantedAt: revokedAt,
              constraints: { ...constraints, roots: remaining },
            };
            delete replacement.revokedAt;
            grants.push(replacement);
          }
        }
        return reply(
          NodeDescriptorSchema.parse(
            Object.fromEntries(Object.entries(node).filter(([key]) => key !== "connected")),
          ),
        );
      });
    case "authority.grant_permission":
      return mutate(name, GrantStandingPermissionCommandSchema, body, (input) => {
        const permission = StandingPermissionSchema.parse({
          ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "idempotencyKey")),
          id: nextId(),
          grantedAt: now(),
          grantedBy: "owner",
        });
        permissions.push(permission);
        return reply(permission);
      });
    case "authority.revoke_permission":
      return mutate(name, RevokeStandingPermissionCommandSchema, body, (input) => {
        const permission = permissions.find((row) => row.id === input.permissionId);
        if (permission === undefined) return missing("Permission");
        if (permission.revokedAt === undefined) {
          permission.revokedAt = now();
          permission.revokedReason = input.reason;
        }
        return reply(permission);
      });
    case "settings.set":
      return mutate(
        name,
        SetSettingCommandSchema.pipe(
          z.object({ idempotencyKey: z.string(), key: z.string(), value: z.unknown() }),
        ),
        body,
        (input) => {
          const setting = configuration.settings.find((row) => row.key === input.key);
          if (setting === undefined) return missing("Setting");
          setting.value = structuredClone(input.value);
          setting.source = "ui";
          return reply({ key: input.key });
        },
      );
    case "settings.reset":
      return mutate(name, ResetSettingCommandSchema, body, (input) => {
        const index = configuration.settings.findIndex((row) => row.key === input.key);
        const original = seed.configuration.settings.find((row) => row.key === input.key);
        if (index < 0 || original === undefined) return missing("Setting");
        configuration.settings[index] = {
          ...structuredClone(original),
          value: structuredClone(seed.settingDefaults[input.key]),
          source: "default",
        };
        return reply({ key: input.key });
      });
    case "identity.set_default_model":
      return mutate(name, SetIdentityDefaultModelCommandSchema, body, (input) => {
        defaults[input.identityId] = structuredClone(input.model);
        return reply(input.model);
      });
    default:
      return undefined;
  }
}

export const worldArea: LarpArea = {
  request(method, path, body) {
    const { segments, query } = parsePath(path);
    const [collection, id, sub] = segments;
    if (method === "POST") {
      if (segments.length === 2 && collection === "commands" && id !== undefined)
        return command(id, body);
      if (
        segments.length === 2 &&
        ((collection === "push" && id === "subscribe") ||
          (collection === "session" && id === "logout"))
      )
        return reply({ ok: true });
      return undefined;
    }
    if (method !== "GET") return undefined;
    if (segments.length === 1) {
      switch (collection) {
        case "nodes":
          return reply({ nodes });
        case "models":
          return reply({ catalogue, defaults, roots: roots() });
        case "permissions":
          return reply({ permissions });
        case "configuration":
          return reply(configuration);
        case "limits":
          return reply({ limits: seed.limits });
        case "artifacts":
          return reply({ artifacts: seed.artifacts });
        case "live-sessions":
          return reply({ sessions: seed.liveSessions });
        case "sessions":
          return reply({
            sessions:
              seed.sessions.find(
                (folder) =>
                  folder.nodeId === query.get("node") &&
                  folder.rootGrantId === query.get("root") &&
                  roots().some(
                    (root) => root.nodeId === folder.nodeId && root.grantId === folder.rootGrantId,
                  ),
              )?.sessions ?? [],
          });
      }
    }
    if (segments.length === 2) {
      if (collection === "remote" && id === "hosts") return reply({ hosts: [] });
      if (collection === "push" && id === "key") return reply({ publicKey: seed.pushPublicKey });
      if (collection === "nodes") {
        const node = nodes.find((candidate) => candidate.id === id);
        return node === undefined
          ? missing("Node")
          : reply({ ...node, grants: grants.filter((grant) => grant.nodeId === id) });
      }
    }
    if (segments.length === 3 && collection === "live-sessions" && sub === "entries") {
      const entries = Object.hasOwn(seed.liveEntries, id ?? "")
        ? seed.liveEntries[id ?? ""]
        : undefined;
      return entries === undefined ? missing("Live session") : reply({ entries });
    }
    // BeforeNoctis alone owns this read; all other thread paths belong to Claude.
    if (segments.length === 3 && collection === "threads" && sub === "history") {
      const exchanges = Object.hasOwn(seed.history, id ?? "") ? seed.history[id ?? ""] : undefined;
      return exchanges === undefined ? undefined : reply({ exchanges });
    }
    return undefined;
  },
  contentUrl: () => undefined,
};
