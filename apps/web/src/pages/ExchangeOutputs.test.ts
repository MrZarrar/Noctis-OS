import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExchangeOutputs } from "./ExchangeOutputs.js";

const image = { attachmentId: "att-1", mediaType: "image/png", path: "jester.png" };
const file = { attachmentId: "att-2", mediaType: "application/pdf" };
const render = (outputUrl: ((id: string) => string) | undefined): string =>
  renderToStaticMarkup(
    createElement(ExchangeOutputs, { outputs: [image, file], outputUrl, mobile: false }),
  );

describe("the outputs under Presence's reply", () => {
  it("shows an image as a thumbnail that opens it, and any other file as a link", () => {
    const markup = render((id) => `/attachments/${id}/content`);

    expect(markup).toMatch(/<a [^>]*href="\/attachments\/att-1\/content"[^>]*target="_blank"/);
    expect(markup).toMatch(/<img [^>]*src="\/attachments\/att-1\/content"[^>]*alt="jester.png"/);
    expect(markup).toMatch(
      /<a [^>]*href="\/attachments\/att-2\/content"[^>]*>Open application\/pdf</,
    );
  });

  it("names the files in plain text when the transport cannot say where they are", () => {
    const markup = render(undefined);

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("jester.png");
  });
});
