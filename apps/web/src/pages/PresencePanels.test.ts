import { describe, expect, it } from "vitest";
import { presenceHandoffs } from "./PresencePanels.js";

describe("presence handoffs", () => {
  const shared = {
    mediaUrl: () => "blob:picture",
    visualUrl: () => "blob:visual",
    fileTransport: { contentUrl: () => "blob:file" },
    onPanelAction: () => undefined,
    onConfirm: () => undefined,
  };
  const renderPage = () => null;

  it("lets a Presence panel show its pictures, files and visuals", () => {
    const handoffs = presenceHandoffs(shared as never, renderPage as never);
    expect(handoffs.mediaUrl).toBe(shared.mediaUrl);
    expect(handoffs.visualUrl).toBe(shared.visualUrl);
    expect(handoffs.fileTransport).toBe(shared.fileTransport);
    expect(handoffs.renderPage).toBe(renderPage);
  });

  it("still leaves choices and confirmations to a conversation", () => {
    const handoffs = presenceHandoffs(shared as never, undefined);
    expect(handoffs).not.toHaveProperty("onPanelAction");
    expect(handoffs).not.toHaveProperty("onConfirm");
    expect(handoffs).not.toHaveProperty("renderPage");
  });
});
