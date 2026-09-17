import { describe, expect, it } from "vitest";

import { LoginRefused, login } from "./login.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that answers with one scripted response and records what it was asked. */
function scripted(
  status: number,
  body: unknown,
): {
  fetch: (
    url: string,
    init: RequestInit,
  ) => Promise<{ status: number; text: () => Promise<string> }>;
  calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });

      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    },
  };
}

describe("login", () => {
  it("posts the token and returns the csrf the core issued", async () => {
    const { fetch, calls } = scripted(200, { csrf: "csrf-value" });

    await expect(login("https://core.example", "the-token", fetch)).resolves.toEqual({
      csrf: "csrf-value",
    });

    expect(calls[0]?.url).toBe("https://core.example/session/login");
    expect(calls[0]?.init.method).toBe("POST");
    // Without this the browser never stores the `Set-Cookie` the core answers
    // with, and every request after login is anonymous.
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ token: "the-token" }));
  });

  it("rejects a refused token rather than returning a transport with no session", async () => {
    await expect(
      login(
        "https://core.example",
        "wrong",
        scripted(401, { error: { code: "unauthorized" } }).fetch,
      ),
    ).rejects.toThrow(LoginRefused);

    await expect(
      login(
        "https://core.example",
        "wrong",
        scripted(401, { error: { code: "unauthorized" } }).fetch,
      ),
    ).rejects.toThrow(/token/i);
  });

  it("rejects a 200 that carries no csrf, which would leave every mutation refused", async () => {
    await expect(login("https://core.example", "t", scripted(200, {}).fetch)).rejects.toThrow(
      /csrf/i,
    );
  });

  it("reports a refusal that is not a 401 rather than pretending it succeeded", async () => {
    await expect(
      login(
        "https://core.example",
        "t",
        scripted(403, { error: { code: "forbidden_origin" } }).fetch,
      ),
    ).rejects.toThrow(/403/);
  });

  it("never puts the token in the URL, where a proxy log would keep it", async () => {
    const { fetch, calls } = scripted(200, { csrf: "c" });

    await login("https://core.example", "secret-token", fetch);

    expect(calls[0]?.url).not.toContain("secret-token");
  });
});
