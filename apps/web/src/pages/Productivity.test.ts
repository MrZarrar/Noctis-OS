import { describe, it, expect } from "vitest";
import { UpdateReminderCommandSchema } from "@noctis/contracts";
import { productivityCommand } from "./Productivity.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
const id = "00000000-0000-7000-8000-000000000001";
describe("productivity mutations", () => {
  it("uses entity IDs and never adds identity to reminder updates", async () => {
    let received: unknown;
    const transport = {
      request: (_m: string, _p: string, body: unknown) => {
        received = body;
        return Promise.resolve({ status: 200, body: {} });
      },
    } as CoreTransport;
    await productivityCommand(transport, "reminder.update", {
      id,
      expectedRevision: 2,
      identityId: "vesper",
      text: "Updated",
      note: "",
      trigger: null,
    });
    expect(UpdateReminderCommandSchema.safeParse(received).success).toBe(true);
  });
  it("surfaces rejected core writes rather than claiming saved", async () => {
    const transport = {
      request: () =>
        Promise.resolve({ status: 409, body: { message: "This note changed elsewhere." } }),
    } as unknown as CoreTransport;
    await expect(
      productivityCommand(transport, "note.delete", { id, expectedRevision: 1 }),
    ).rejects.toThrow("changed elsewhere");
  });
});
