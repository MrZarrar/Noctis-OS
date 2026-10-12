import { describe, expect, it } from "vitest";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { MediaSurface, mediaElement } from "./media.js";

describe("media panels", () => {
  it.each([
    ["video/mp4", "video", { controls: true, playsInline: true, preload: "metadata" }],
    ["audio/mpeg", "audio", { controls: true }],
    ["application/pdf", "a", { children: "Open PDF", target: "_blank" }],
    ["application/zip", "a", { children: "Open file", target: "_blank" }],
  ])("renders %s with its controls or link", (mediaType, type, props) => {
    const element = MediaSurface({ title: "Preview", mediaType, url: "/output" });
    expect(element.type).toBe(type);
    expect((element as ReactElement<unknown>).props).toMatchObject(props);
  });
  it.each([
    ["image/png", "image"],
    ["video/mp4", "video"],
    ["audio/mpeg", "audio"],
    ["application/pdf", "link"],
    ["application/zip", "link"],
  ])("selects %s as %s", (type, element) => {
    expect(mediaElement(type)).toBe(element);
  });

  it("contains a compact thumbnail within 96 pixels", () => {
    const element = MediaSurface({
      title: "Preview",
      mediaType: "image/png",
      url: "/image",
      size: "compact",
    });
    expect(element.type).toBe("img");
    const props = (element as ReactElement<{ style: CSSProperties }>).props;
    expect(props.style.maxHeight).toBe(96);
    expect(props.style.objectFit).toBe("contain");
  });

  it.each([undefined, "", "   "])("shows text for an unusable URL %s", (url) => {
    const element = MediaSurface({ title: "Preview", mediaType: "image/png", url });
    expect(element.type).toBe("p");
    expect((element as ReactElement<{ children: ReactNode }>).props.children).toBe(
      "This file opens from Threads",
    );
  });
});
