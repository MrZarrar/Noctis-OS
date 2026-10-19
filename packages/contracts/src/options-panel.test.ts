import { describe, expect, it } from "vitest";

import {
  OptionsPayloadSchema,
  OptionsProposalSchema,
  PANEL_PROPOSABLE_KINDS,
  SURFACE_PAYLOAD_SCHEMAS,
} from "./surface-payloads.js";

const file = {
  from: "file",
  nodeId: "node",
  grantId: "docs",
  relativePath: "noctis-show/.shots/a.png",
};
const option = {
  id: "anker",
  title: "Anker USB-C to USB-C cable, 1.8 m",
  price: "£7.99",
  detail: "4.7★ from 31,000 ratings. Arrives tomorrow.",
  image: file,
  url: "https://www.amazon.co.uk/dp/B0EXAMPLE",
  action: { label: "Add to basket", message: "Add option anker to my basket" },
};

describe("the options panel", () => {
  it("is a kind an agent may propose, validated by its own schema", () => {
    expect(PANEL_PROPOSABLE_KINDS.has("options")).toBe(true);
    expect(SURFACE_PAYLOAD_SCHEMAS.options?.schema).toBe(OptionsPayloadSchema);
  });

  it("keeps each option's picture, link and choice", () => {
    expect(
      OptionsPayloadSchema.parse({ title: "USB-C cables under £10", options: [option] }),
    ).toEqual({
      title: "USB-C cables under £10",
      options: [option],
    });
  });

  it("takes only ordinary web links", () => {
    for (const url of ["javascript:alert(1)", "file:///C:/x", "data:text/html,x", "ftp://x"]) {
      expect(
        OptionsPayloadSchema.safeParse({ title: "t", options: [{ ...option, url }] }).success,
      ).toBe(false);
    }
    expect(
      OptionsPayloadSchema.safeParse({
        title: "t",
        options: [{ ...option, url: "http://shop.example" }],
      }).success,
    ).toBe(true);
  });

  it("bounds how many options one panel holds", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `o${String(i)}`, title: "x" }));
    expect(OptionsPayloadSchema.safeParse({ title: "t", options: many }).success).toBe(false);
    expect(OptionsPayloadSchema.safeParse({ title: "t", options: [] }).success).toBe(false);
  });

  it("asks the agent for each picture by path, never for a node and grant", () => {
    const proposal = { title: "t", options: [{ ...option, image: { path: "C:\\work\\a.png" } }] };

    expect(OptionsProposalSchema.safeParse(proposal).success).toBe(true);
    expect(OptionsProposalSchema.safeParse({ title: "t", options: [option] }).success).toBe(false);
  });
});
