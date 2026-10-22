import {
  CAPABILITY_OPERATION_CLASS,
  CapabilityGrantSchema,
  ModelRefSchema,
  NodeDescriptorSchema,
  StandingPermissionSchema,
} from "@noctis/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ArtifactSchema } from "../pages/Artifacts.js";
import { QuestionsSchema } from "../pages/AgentQuestions.js";
import { HistorySchema } from "../pages/BeforeNoctis.js";
import { SessionsSchema as ExternalSessionsSchema } from "../pages/Conversations.js";
import { ConfigurationSchema, allPagesChoice } from "../pages/CoreSettings.js";
import { EntriesSchema, SessionsSchema, sharedRootFor } from "../pages/LiveSessions.js";
import { GrantsSchema, HostsSchema, NodesSchema, RootIdsSchema } from "../pages/Nodes.js";
import { ModelsSchema, PermissionsSchema } from "../pages/Settings.js";
import { sharedFolders } from "../pages/folders-view.js";
import { UsageLimitsSchema } from "../pages/usage-limits-view.js";
import type { CoreMethod } from "../transport/CoreTransport.js";
import { LARP_IDS } from "./ids.js";
import { worldArea, worldQuestions } from "./world.js";

let area = worldArea;
beforeEach(async () => {
  vi.resetModules();
  area = (await import("./world.js")).worldArea;
});

function request(path: string, method: CoreMethod = "GET", body?: unknown) {
  const response = area.request?.(method, path, body);
  expect(response, `${method} ${path} is served`).toBeDefined();
  return response!;
}

function read<T>(path: string, schema: z.ZodType<T>): T {
  const response = request(path);
  expect(response.status).toBe(200);
  return schema.parse(response.body);
}

const command = (name: string, body: Record<string, unknown>, key = name) =>
  request(`/commands/${name}`, "POST", { idempotencyKey: key, ...body });

describe("LARP world", () => {
  it("serves connected fictional nodes with real grants and matching composer roots", () => {
    const { nodes } = read("/nodes?limit=20", NodesSchema);
    expect(nodes.map((node) => node.hostId)).toEqual(["Home PC", "Work PC", "Phone"]);
    expect(nodes.every((node) => node.connected)).toBe(true);
    const models = read("/models", ModelsSchema);
    RootIdsSchema.parse(request("/models").body);
    expect(models.catalogue.map((model) => model.providerId)).toEqual([
      "claude",
      "codex",
      "hermes",
      "local",
    ]);
    expect(models.roots.map((root) => root.grantId)).toEqual([
      LARP_IDS.homeProjectsGrant,
      LARP_IDS.workDocumentsGrant,
    ]);
    for (const node of nodes) {
      const detail = read(
        `/nodes/${node.id}?details=1`,
        NodesSchema.shape.nodes.element.extend({ grants: z.array(CapabilityGrantSchema) }),
      );
      GrantsSchema.parse(detail);
      expect(
        detail.grants.every(
          (grant) =>
            grant.operationClass ===
            CAPABILITY_OPERATION_CLASS[grant.capability as keyof typeof CAPABILITY_OPERATION_CLASS],
        ),
      ).toBe(true);
      const folders = sharedFolders(detail.grants, Date.now());
      expect(folders.map((folder) => folder.grantId)).toEqual(
        models.roots.filter((root) => root.nodeId === node.id).map((root) => root.grantId),
      );
      if (node.hostId !== "Phone")
        expect(node.providers.filter((probe) => probe.available)).toHaveLength(4);
    }
    expect(read("/remote/hosts", HostsSchema).hosts).toEqual([]);
    expect(area.contentUrl?.(`/nodes/${LARP_IDS.homeNode}/screen?fps=15`)).toBeUndefined();
  });

  it("keeps the unfinished pages out of the rail, as a fresh core does", () => {
    expect(allPagesChoice(read("/configuration", ConfigurationSchema).settings)).not.toBe(true);
  });

  it("serves configuration, healthy usage and artifacts using the page schemas", () => {
    expect(read("/configuration", ConfigurationSchema).settings.length).toBeGreaterThan(5);
    const limits = read("/limits?refresh=1", UsageLimitsSchema).limits;
    expect(limits).toHaveLength(2);
    expect(
      limits.every((limit) => limit.fiveHour!.usedPercent < 60 && limit.weekly!.usedPercent < 60),
    ).toBe(true);
    const { artifacts } = read("/artifacts", z.object({ artifacts: z.array(ArtifactSchema) }));
    expect(artifacts.length).toBeGreaterThan(2);
    expect(
      artifacts.every(
        (artifact) => artifact.uri.startsWith("data:") || artifact.uri.startsWith("noctis:"),
      ),
    ).toBe(true);
  });

  it("serves live entries, folder-specific sessions and prior thread history", () => {
    expect(QuestionsSchema.parse({ questions: worldQuestions }).questions.length).toBeGreaterThan(
      0,
    );
    const { sessions } = read("/live-sessions", SessionsSchema);
    expect(sessions.length).toBeGreaterThan(1);
    for (const session of sessions) {
      expect(sharedRootFor(session, read("/models", ModelsSchema).roots)).toBeDefined();
      expect(
        read(`/live-sessions/${session.id}/entries?limit=30`, EntriesSchema).entries.length,
      ).toBeGreaterThan(1);
    }
    for (const root of read("/models", ModelsSchema).roots) {
      const query = new URLSearchParams({ node: root.nodeId, root: root.grantId });
      expect(read(`/sessions?${query}`, ExternalSessionsSchema).sessions.length).toBeGreaterThan(0);
    }
    for (const thread of [LARP_IDS.vesperThread, LARP_IDS.jesterThread, LARP_IDS.demoTaskThread]) {
      expect(read(`/threads/${thread}/history`, HistorySchema).exchanges.length).toBeGreaterThan(0);
    }
    expect(
      read(
        `/sessions?node=${LARP_IDS.homeNode}&root=${LARP_IDS.workDocumentsGrant}`,
        ExternalSessionsSchema,
      ).sessions,
    ).toEqual([]);
  });

  it("grants and revokes standing permissions in memory with an audit row", () => {
    const permissions = read("/permissions", PermissionsSchema).permissions;
    expect(permissions.length).toBeGreaterThan(1);
    z.object({ permissions: z.array(StandingPermissionSchema) }).parse(
      request("/permissions").body,
    );
    const first = permissions.find((permission) => !permission.revokedAt)!;
    const revoked = command("authority.revoke_permission", {
      permissionId: first.id,
      reason: "Owner ended this permission",
    });
    expect(revoked.status).toBe(200);
    expect(StandingPermissionSchema.parse(revoked.body).revokedReason).toBe(
      "Owner ended this permission",
    );
    expect(
      read("/permissions", PermissionsSchema).permissions.find(
        (permission) => permission.id === first.id,
      )?.revokedAt,
    ).toBeDefined();
    const granted = command("authority.grant_permission", {
      actorId: "vesper",
      capability: "git.push",
      operationClass: "external_write",
      constraints: { targetType: "repository", targetIds: ["lantern-kit"] },
    });
    expect(granted.status).toBe(200);
    const permission = StandingPermissionSchema.parse(granted.body);
    expect(
      read("/permissions", PermissionsSchema).permissions.some((row) => row.id === permission.id),
    ).toBe(true);
    expect(
      command("authority.revoke_permission", { permissionId: first.id, reason: "" }).status,
    ).toBe(400);
  });

  it("shares folders, replays a grant safely, and unshares without losing the other roots", () => {
    const constraints = {
      providers: ["claude", "codex"],
      roots: [
        { grantId: "sketches", path: "C:\\Fable\\Sketches", mode: "write", localOnly: false },
        { grantId: "drafts", path: "C:\\Fable\\Drafts", mode: "read", localOnly: false },
      ],
    };
    const granted = command("node.grant_capability", {
      nodeId: LARP_IDS.homeNode,
      capability: "runtime.turn",
      constraints,
    });
    expect(granted.status).toBe(200);
    CapabilityGrantSchema.parse(granted.body);
    expect(
      command("node.grant_capability", {
        nodeId: LARP_IDS.homeNode,
        capability: "runtime.turn",
        constraints,
      }).body,
    ).toEqual(granted.body);
    expect(
      read("/models", ModelsSchema).roots.filter((root) => root.grantId === "sketches"),
    ).toHaveLength(1);
    const unshared = command("node.unshare_folder", {
      nodeId: LARP_IDS.homeNode,
      rootGrantId: "sketches",
    });
    expect(unshared.status).toBe(200);
    NodeDescriptorSchema.parse(unshared.body);
    const roots = read("/models", ModelsSchema).roots.map((root) => root.grantId);
    expect(roots).not.toContain("sketches");
    expect(roots).toContain("drafts");
    expect(roots).toContain(LARP_IDS.homeProjectsGrant);
    const screen = command(
      "node.grant_capability",
      { nodeId: LARP_IDS.homeNode, capability: "screen.view", constraints: {} },
      "screen",
    );
    expect(screen.status).toBe(200);
    CapabilityGrantSchema.parse(screen.body);
    expect(
      command(
        "node.grant_capability",
        { nodeId: LARP_IDS.homeNode, capability: "runtime.turn", constraints: {} },
        "bad-grant",
      ).status,
    ).toBe(400);
  });

  it("updates and resets settings and identity defaults only in memory", () => {
    const set = command("settings.set", { key: "wakeWhileTyping", value: false });
    expect(set.status).toBe(200);
    expect(
      z
        .object({ key: z.literal("wakeWhileTyping") })
        .strict()
        .parse(set.body),
    ).toEqual({ key: "wakeWhileTyping" });
    expect(
      read("/configuration", ConfigurationSchema).settings.find(
        (setting) => setting.key === "wakeWhileTyping",
      ),
    ).toMatchObject({ value: false, source: "ui" });
    expect(command("settings.reset", { key: "wakeWhileTyping" }).status).toBe(200);
    expect(
      read("/configuration", ConfigurationSchema).settings.find(
        (setting) => setting.key === "wakeWhileTyping",
      ),
    ).toMatchObject({ value: true, source: "default" });
    expect(command("settings.reset", { key: "showAllPages" }, "reset-pages").status).toBe(200);
    expect(
      read("/configuration", ConfigurationSchema).settings.find(
        (setting) => setting.key === "showAllPages",
      ),
    ).toMatchObject({ value: false, source: "default" });
    expect(
      command("settings.set", { key: "wakeWhileTyping", value: "bad" }, "bad-setting").status,
    ).toBe(400);
    const model = read("/models", ModelsSchema).catalogue[1]!;
    const changed = command("identity.set_default_model", { identityId: "vesper", model });
    expect(changed.status).toBe(200);
    expect(ModelRefSchema.parse(changed.body)).toEqual(model);
    expect(read("/models", ModelsSchema).defaults.vesper).toEqual(model);
  });

  it("answers push and logout locally and returns detached response bodies", () => {
    expect(read("/push/key", z.object({ publicKey: z.string().min(1) })).publicKey).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(
      request("/push/subscribe", "POST", { endpoint: "https://push.invalid/fictional" }),
    ).toMatchObject({ status: 200, body: { ok: true } });
    expect(request("/session/logout", "POST", {})).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    const models = request("/models").body as { roots: unknown[] };
    models.roots.length = 0;
    expect(read("/models", ModelsSchema).roots).toHaveLength(2);
  });

  it("leaves other areas and unowned subpaths to their transport handlers", () => {
    for (const path of [
      "/identities",
      "/conversations",
      "/threads",
      "/turns",
      "/approvals",
      "/events",
      "/glucose",
      "/vault",
      "/nodes/unknown/screen",
      "/models/unknown",
      "/threads/unknown/history",
      "/commands/conversation.send",
      "/commands/surface.open",
      "/commands/identity.activate",
    ]) {
      expect(
        area.request?.(path.startsWith("/commands") ? "POST" : "GET", path, {}),
        path,
      ).toBeUndefined();
    }
    expect(request("/nodes/unknown").status).toBe(404);
    expect(request("/live-sessions/unknown/entries").status).toBe(404);
    expect(request("/live-sessions/constructor/entries").status).toBe(404);
    expect(area.request?.("GET", "/threads/constructor/history", undefined)).toBeUndefined();
  });

  it("rebases fictional timestamps once when the module loads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-05T15:00:00Z"));
      vi.resetModules();
      area = (await import("./world.js")).worldArea;
      expect(read("/nodes", NodesSchema).nodes[0]?.lastSeenAt).toBe("2026-11-05T12:25:00.000Z");
      expect(read("/limits", UsageLimitsSchema).limits[0]?.weekly?.resetsAt).toBe(
        "2026-11-09T09:00:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
