import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Login } from "./Login.js";

it("centres the login form with auto margins so overflow can start at the top", () => {
  const markup = renderToStaticMarkup(
    createElement(Login, { baseUrl: "http://localhost", onAuthenticated: () => undefined }),
  );
  expect(markup).toMatch(/<form[^>]*style="[^"]*margin:auto/);
  expect(markup).not.toContain("align-items:center");
  expect(markup).not.toContain("justify-content:center");
});
