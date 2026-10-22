import { describe, expect, it } from "vitest";
import { FileListEvidenceSchema } from "@noctis/contracts";
import { PreviewSchema } from "../pages/useFileText.js";
import { viewerKind } from "../pages/files-view.js";
import { files } from "./files.js";
import { LARP_IDS } from "./ids.js";

const roots = [
  { node: LARP_IDS.homeNode, root: LARP_IDS.homeProjectsGrant },
  { node: LARP_IDS.workNode, root: LARP_IDS.workDocumentsGrant },
];
const url = (index: number, path: string, route = "list") =>
  `/files/${route}?${new URLSearchParams({ ...roots[index]!, path })}`;

describe("fictional Files", () => {
  it("walks both shared trees, parses lists and previews, and loads every data URL locally", async () => {
    let images = 0;
    let texts = 0;
    let folders = 0;
    for (const index of [0, 1]) {
      const pending = [""];
      while (pending.length) {
        const path = pending.shift()!;
        const response = files.request?.("GET", url(index, path), undefined);
        expect(response?.status).toBe(200);
        const listing = FileListEvidenceSchema.parse(response?.body);
        expect(listing.truncated).toBe(false);
        expect(listing.entries.length).toBeGreaterThan(0);
        for (const entry of listing.entries) {
          const child = path === "" ? entry.name : `${path}/${entry.name}`;
          if (entry.kind === "directory") {
            pending.push(child);
            folders++;
            continue;
          }
          const contentPath = url(index, child, "content");
          const contentUrl = files.contentUrl?.(contentPath);
          expect(contentUrl).toMatch(/^data:/);
          const loaded = await fetch(contentUrl!);
          expect(loaded.ok).toBe(true);
          const content = await loaded.text();
          expect(content.length).toBeGreaterThan(20);
          expect(files.request?.("GET", contentPath, undefined)).toEqual({
            status: 200,
            body: content,
          });
          // Existing download links append this query suffix to contentUrl.
          expect(await (await fetch(`${contentUrl!}&download=1`)).text()).toBe(content);
          expect(new TextEncoder().encode(content).length).toBe(entry.sizeBytes);
          if (viewerKind(entry.name, entry.sizeBytes) === "image") {
            images++;
            expect(loaded.headers.get("content-type")).toContain("image/svg+xml");
            expect(content).toContain("<svg");
            expect(content).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
          } else {
            texts++;
            const preview = files.request?.("GET", `${contentPath}&preview=1`, undefined);
            expect(preview?.status).toBe(200);
            expect(PreviewSchema.parse(preview?.body)).toEqual({ text: content, truncated: false });
          }
        }
      }
    }
    expect(images).toBeGreaterThanOrEqual(4);
    expect(texts).toBeGreaterThanOrEqual(8);
    expect(folders).toBeGreaterThanOrEqual(4);
  });

  it("refuses writes and invalid paths while leaving unrelated routes to other areas", () => {
    const before = files.request?.("GET", url(0, ""), undefined);
    expect(
      files.request?.("POST", url(0, "README.md", "content"), { text: "overwrite" })?.status,
    ).toBe(403);
    expect(files.request?.("POST", "/files/upload", {})?.status).toBe(403);
    expect(files.request?.("GET", url(0, "missing"), undefined)?.status).toBe(404);
    expect(files.request?.("GET", url(0, "../private"), undefined)?.status).toBe(400);
    expect(
      files.request?.("GET", "/files/list?node=unknown&root=unknown&path=", undefined)?.status,
    ).toBe(404);
    expect(files.contentUrl?.(url(0, "missing.png", "content"))).toBeUndefined();
    expect(
      files.contentUrl?.(
        `/files/content?node=${LARP_IDS.workNode}&root=${LARP_IDS.homeProjectsGrant}&path=README.md`,
      ),
    ).toBeUndefined();
    expect(files.request?.("GET", "/nodes", undefined)).toBeUndefined();
    expect(files.contentUrl?.("/screen/content")).toBeUndefined();
    expect(files.request?.("GET", url(0, ""), undefined)).toEqual(before);
  });
});
