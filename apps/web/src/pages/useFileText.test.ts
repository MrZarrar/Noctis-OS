import { describe, expect, it, vi } from "vitest";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { readFileText } from "./useFileText.js";
describe("safe file text reads", () => {
  it("requests only the server bounded preview and forwards cancellation", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { text: '{"literal":true}', truncated: true } });
    const controller = new AbortController();
    expect(
      await readFileText(
        { request } as unknown as CoreTransport,
        "/files/content?root=test",
        controller.signal,
      ),
    ).toEqual({ text: '{"literal":true}', truncated: true });
    expect(request).toHaveBeenCalledWith("GET", "/files/content?root=test&preview=1", undefined, {
      signal: controller.signal,
    });
  });
  it("rejects errors, oversized and malformed previews", async () => {
    for (const response of [
      { status: 503, body: { error: { message: "PC offline" } } },
      { status: 200, body: { text: "x".repeat(2 * 1024 * 1024 + 1), truncated: false } },
      { status: 200, body: "not a preview" },
    ]) {
      await expect(
        readFileText(
          { request: () => Promise.resolve(response) } as unknown as CoreTransport,
          "/files/content?root=test",
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });
  it("discards an aborted native response even when the transport ignores signals", async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const pending = readFileText(
      { request: () => response } as unknown as CoreTransport,
      "/files/content?root=test",
      controller.signal,
    );
    controller.abort();
    resolve({ status: 200, body: { text: "wrong owner", truncated: false } });
    await expect(pending).rejects.toThrow();
  });
});
