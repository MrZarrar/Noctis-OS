import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProductivityReceipt } from "./ProductivityReceipt.js";
import type { RuntimeItem } from "@noctis/contracts";
const proposal: Extract<RuntimeItem, { kind: "proposal" }> = {
  kind: "proposal",
  itemId: "capture",
  status: "completed",
  proposal: { kind: "reminder", text: "Call home", trigger: null },
};
describe("core-confirmed capture receipt", () => {
  it("does not claim saved or show Undo without a core receipt", () => {
    const html = renderToStaticMarkup(
      createElement(ProductivityReceipt, {
        item: proposal,
        transport: undefined,
        onOpen: undefined,
      }),
    );
    expect(html).toContain("Not recorded");
    expect(html).not.toContain("Undo");
  });
  it("offers Undo only for a committed reminder", () => {
    const html = renderToStaticMarkup(
      createElement(ProductivityReceipt, {
        item: { ...proposal, appliedRecordId: "00000000-0000-7000-8000-000000000001" },
        transport: undefined,
        onOpen: undefined,
      }),
    );
    expect(html).toContain("Saved in Noctis");
    expect(html).toContain("Undo");
  });
  it.each(["run_now", "pause"] as const)(
    "shows a truthful receipt and Open without activation for applied %s",
    (action) => {
      const taskId = "00000000-0000-7000-8000-000000000002";
      const html = renderToStaticMarkup(
        createElement(ProductivityReceipt, {
          item: {
            ...proposal,
            proposal: { kind: "task_action", taskId, action },
            appliedRecordId: taskId,
          },
          transport: undefined,
          onOpen: () => {},
        }),
      );
      expect(html).toContain(action === "run_now" ? "Run now" : "Pause");
      expect(html).not.toContain(taskId);
      expect(html).toContain(action === "run_now" ? "Run requested" : "Task paused");
      expect(html).toContain(">Open</button>");
      expect(html).not.toContain("Turn on");
      expect(html).not.toContain("Undo");
      expect(html).not.toContain("Saved in Noctis");
      expect(html).not.toContain("Task started");
    },
  );
  it.each(["run_now", "pause"] as const)(
    "labels %s as proposed only without a core receipt",
    (action) => {
      const taskId = "00000000-0000-7000-8000-000000000002";
      const html = renderToStaticMarkup(
        createElement(ProductivityReceipt, {
          item: { ...proposal, proposal: { kind: "task_action", taskId, action } },
          transport: undefined,
          onOpen: () => {},
        }),
      );
      expect(html).toContain(action === "run_now" ? "Run now" : "Pause");
      expect(html).not.toContain(taskId);
      expect(html).toContain("Proposed only. Action not applied.");
      expect(html).toContain(">Open</button>");
      expect(html).not.toContain("Run requested");
      expect(html).not.toContain("Task paused");
      expect(html).not.toContain("Turn on");
    },
  );
});
