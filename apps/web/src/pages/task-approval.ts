import type { ApprovalRecord } from "@noctis/contracts";
import { nextKey } from "../idempotency.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

type TaskApproval = Pick<
  ApprovalRecord,
  "id" | "taskId" | "actorId" | "capability" | "operationClass" | "outcome" | "target"
>;
export function canRememberTaskApproval(approval: TaskApproval): boolean {
  return (
    approval.taskId !== undefined &&
    approval.outcome === "require_confirmation" &&
    ["local_reversible_edit", "external_write", "message_send", "publish"].includes(
      approval.operationClass,
    ) &&
    !["authority.grant_permission", "authority.revoke_permission"].includes(approval.capability)
  );
}
export async function allowForThisTask(
  transport: CoreTransport,
  approval: TaskApproval,
): Promise<void> {
  if (!canRememberTaskApproval(approval)) throw new Error("This approval cannot be remembered");
  const commands: [string, Record<string, unknown>][] = [
    [
      "authority.grant_permission",
      {
        taskId: approval.taskId,
        actorId: approval.actorId,
        capability: approval.capability,
        operationClass: approval.operationClass,
        constraints: {
          targetType: approval.target.type,
          targetIds: [approval.target.id],
          ...(approval.target.hostId === undefined ? {} : { hostIds: [approval.target.hostId] }),
        },
      },
    ],
    ["authority.confirm", { requestId: approval.id }],
  ];
  for (const [name, body] of commands) {
    const response = await transport.request("POST", `/commands/${name}`, {
      idempotencyKey: nextKey(name),
      ...body,
    });
    if (response.status !== 200)
      throw new Error(
        (response.body as { error?: { message?: string } }).error?.message ??
          "The core refused this approval",
      );
  }
}
