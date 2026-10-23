import { useEffect, useState } from "react";
import { StandingPermissionSchema, type StandingPermission } from "@noctis/contracts";
import { z } from "zod";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { buttonStyle, fieldStyle } from "../layout/Page.js";
import { ActionButton } from "../layout/ActionButton.js";
import { productivityCommand } from "./Productivity.js";
export function TaskPermissions({
  transport,
  taskId,
  actorId,
}: {
  transport: CoreTransport | undefined;
  taskId: string;
  actorId: string;
}) {
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState({
    capability: "",
    operationClass: "external_write",
    targetType: "",
    targetId: "",
    hostId: "",
  });
  const [permissions, setPermissions] = useState<StandingPermission[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void transport
      ?.request("GET", "/permissions")
      .then((r) => {
        const parsed = z.object({ permissions: z.array(StandingPermissionSchema) }).parse(r.body);
        if (!cancelled)
          setPermissions(parsed.permissions.filter((p) => p.taskId === taskId && !p.revokedAt));
      })
      .catch(() => {
        if (!cancelled) setError("Could not load task permissions.");
      });
    return () => {
      cancelled = true;
    };
  }, [transport, taskId, revision]);
  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await productivityCommand(transport, "authority.revoke_permission", {
        permissionId: id,
        reason: "Owner revoked from scheduled task",
      });
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke permission.");
    } finally {
      setBusy(false);
    }
  }
  async function grant() {
    setBusy(true);
    setError("");
    try {
      await productivityCommand(transport, "authority.grant_permission", {
        taskId,
        actorId,
        capability: scope.capability,
        operationClass: scope.operationClass,
        constraints: {
          targetType: scope.targetType,
          targetIds: [scope.targetId],
          ...(scope.hostId ? { hostIds: [scope.hostId] } : {}),
        },
      });
      setAdding(false);
      setScope({
        capability: "",
        operationClass: "external_write",
        targetType: "",
        targetId: "",
        hostId: "",
      });
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not grant permission.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary style={{ cursor: "pointer", minHeight: 44 }}>
        Standing permissions ({permissions.length})
      </summary>
      {error && <p role="alert">{error}</p>}
      {!permissions.length && <p>Consequential actions ask for approval.</p>}
      <button type="button" style={buttonStyle} onClick={() => setAdding(!adding)}>
        {adding ? "Cancel permission" : "Add permission"}
      </button>
      {adding && (
        <form
          style={{ display: "grid", gap: 8, marginBlock: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void grant();
          }}
        >
          <p>
            Allow this task to perform this exact action without asking again. Revoke it here at any
            time.
          </p>
          <label>
            Action class
            <select
              style={fieldStyle}
              value={scope.operationClass}
              onChange={(e) => setScope({ ...scope, operationClass: e.target.value })}
            >
              <option value="external_write">External write (for example, push)</option>
              <option value="message_send">Send a message</option>
              <option value="publish">Publish</option>
            </select>
          </label>
          {(["capability", "targetType", "targetId", "hostId"] as const).map((key) => (
            <label key={key}>
              {
                {
                  capability: "Capability",
                  targetType: "Target type",
                  targetId: "Exact target ID",
                  hostId: "Host ID (optional)",
                }[key]
              }
              <input
                required={key !== "hostId"}
                style={fieldStyle}
                value={scope[key]}
                onChange={(e) => setScope({ ...scope, [key]: e.target.value })}
              />
            </label>
          ))}
          <button disabled={busy || !transport} aria-busy={busy} style={buttonStyle}>
            {busy ? "Saving..." : "Grant for this task"}
          </button>
        </form>
      )}
      {permissions.map((p) => (
        <div key={p.id}>
          <p>
            {p.capability}: {p.constraints.targetIds.join(", ")}
            {p.expiresAt ? ` (expires ${p.expiresAt})` : ""}
          </p>
          <ActionButton disabled={busy} onAction={() => revoke(p.id)} pendingLabel="Revoking...">
            Revoke
          </ActionButton>
        </div>
      ))}
    </details>
  );
}
