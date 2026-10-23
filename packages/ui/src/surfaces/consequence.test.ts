import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalSurface } from "./consequence.js";

describe("ApprovalSurface", () => {
  it("shows the exact action, cost and reversal consequence before collapsed technical details", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalSurface, {
        id: "approval-1",
        consequenceSummary: "Transfer GBP 8.00 to a named recipient",
        operationClass: "external_spend",
        capability: "money.transfer",
        targetType: "account",
        targetId: "recipient-123",
        reversibility: "irreversible",
        outcome: "require_typed_confirmation",
        reasonCodes: ["spend_requires_confirmation"],
        estimatedCostGbp: 8,
        confirmationPhrase: "CONFIRM TRANSFER",
        onConfirm: () => undefined,
        onDecline: () => undefined,
      }),
    );
    const details = markup.match(/<details[^>]*>[\s\S]*?<\/details>/)?.[0];
    const visible = markup.split("<details")[0];

    expect(details).toBeDefined();
    expect(details).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(details).toContain("Details");
    expect(details).toContain("money.transfer");
    expect(details).toContain("recipient-123");
    expect(details).toContain("external_spend");
    expect(details).toContain("spend_requires_confirmation");
    expect(visible).toContain("Transfer GBP 8.00 to a named recipient");
    expect(visible).toContain("GBP 8.00");
    expect(visible).toMatch(/cannot be undone/i);
    expect(markup).toContain("CONFIRM TRANSFER");
    expect(markup).toContain("Confirm");
    expect(markup).toContain("Decline");
  });

  it("leads with the outline and keeps the exact command collapsed under it", () => {
    const command = `git show origin/main:a.json > a.tmp.json; python -c "print('<hi>')"`;
    const markup = renderToStaticMarkup(
      createElement(ApprovalSurface, {
        id: "approval-2",
        consequenceSummary: "Print the Vesper options from origin/main",
        consequenceDetail: command,
        operationClass: "external_write",
        capability: "runtime.command",
        targetType: "command",
        targetId: "git show",
        reversibility: "partially_reversible",
        outcome: "require_confirmation",
        reasonCodes: ["runtime_asked"],
        onConfirm: () => undefined,
      }),
    );
    const visible = markup.split("<details")[0];
    const commandBox = markup.match(
      /<details[^>]*>\s*<summary[^>]*>Command<\/summary>[\s\S]*?<\/details>/,
    )?.[0];

    expect(visible).toContain("Print the Vesper options from origin/main");
    expect(visible).not.toContain("python");
    expect(commandBox).toBeDefined();
    expect(commandBox).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(commandBox).toContain("<pre");
    expect(commandBox).toContain("print(&#x27;&lt;hi&gt;&#x27;)");
  });
});
