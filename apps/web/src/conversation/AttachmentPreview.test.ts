import { describe, expect, it } from "vitest";

import { previewKind } from "./AttachmentPreview.js";

describe("previewKind", () => {
  it("uses image and video media types", () => {
    expect(previewKind({ name: "shot.png", type: "image/png" })).toBe("image");
    expect(previewKind({ name: "clip.mp4", type: "video/mp4" })).toBe("video");
  });

  it("recognises text media types and common text extensions without rendering markup", () => {
    for (const name of [
      "notes.txt",
      "README.MD",
      "data.json",
      "rows.csv",
      "main.tsx",
      "page.html",
    ]) {
      expect(previewKind({ name, type: "" })).toBe("text");
    }
    expect(previewKind({ name: "unknown", type: "text/plain" })).toBe("text");
    expect(previewKind({ name: "unknown", type: "application/json" })).toBe("text");
  });

  it("leaves binary files as metadata", () => {
    expect(previewKind({ name: "report.pdf", type: "application/pdf" })).toBe("other");
    expect(previewKind({ name: "archive.zip", type: "" })).toBe("other");
  });
});
