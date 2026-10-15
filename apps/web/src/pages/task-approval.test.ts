import { describe, expect, it } from "vitest";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { allowForThisTask } from "./task-approval.js";
const approval = {
  id: "00000000-0000-7000-8000-000000000001",
  taskId: "00000000-0000-7000-8000-000000000002",
  actorId: "vesper",
  capability: "git.push",
  operationClass: "publish" as const,
  outcome: "require_confirmation" as const,
  target: { type: "repository", id: "repo", hostId: "home" },
};
describe("remembering a scheduled task approval", () => {
  it("grants only the exact task, actor, operation and target before confirming", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const transport = {
      request: (_method: string, path: string, body: unknown) => {
        calls.push({ path, body });
        return Promise.resolve({ status: 200, body: {} });
      },
    } as CoreTransport;
    await allowForThisTask(transport, approval);
    expect(calls.map((c) => c.path)).toEqual([
      "/commands/authority.grant_permission",
      "/commands/authority.confirm",
    ]);
    expect(calls[0]?.body).toMatchObject({
      taskId: approval.taskId,
      actorId: "vesper",
      capability: "git.push",
      operationClass: "publish",
      constraints: { targetType: "repository", targetIds: ["repo"], hostIds: ["home"] },
    });
    expect(calls[1]?.body).toMatchObject({ requestId: approval.id });
  });
  it("does not confirm if saving the permission fails", async () => {
    const paths: string[] = [];
    const transport = {
      request: (_method: string, path: string) => {
        paths.push(path);
        return Promise.resolve({ status: 409, body: { error: { message: "Task changed" } } });
      },
    } as CoreTransport;
    await expect(allowForThisTask(transport, approval)).rejects.toThrow("Task changed");
    expect(paths).toHaveLength(1);
  });
  it("never remembers typed or unscoped approvals", async () => {
    const transport = {
      request: () => {
        throw Error("must not call");
      },
    } as unknown as CoreTransport;
    await expect(
      allowForThisTask(transport, { ...approval, outcome: "require_typed_confirmation" }),
    ).rejects.toThrow("cannot be remembered");
    const { taskId: _task, ...ordinary } = approval;
    void _task;
    await expect(allowForThisTask(transport, ordinary)).rejects.toThrow("cannot be remembered");
  });
});
