import { describe, expect, it } from "vitest";

import {
  ROUTE_NAMES,
  RouteNameSchema,
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_OPERATION_CLASS,
  TOOL_TARGET_TYPE,
  ToolDescriptorSchema,
  ToolIntentSchema,
  ToolRouteExecutionEvidenceSchema,
  ExternalToolStateSchema,
} from "./tool.js";
import { OperationClassSchema } from "./enums.js";

const descriptor = (overrides: Record<string, unknown> = {}): unknown => ({
  id: "vinted",
  displayName: "Vinted",
  instructions: "Open Vinted and start a new listing.",
  routes: [],
  ...overrides,
});

describe("tool capabilities", () => {
  /**
   * THE GATE: the table is what stops a caller naming its own consequence, and a
   * capability missing from it is a capability with no class at all. A `Record`
   * type catches that at compile time; this catches the reverse — an entry for a
   * capability that no longer exists — and it is cheap enough to keep both.
   */
  it("classifies every capability and nothing else", () => {
    expect(Object.keys(TOOL_CAPABILITY_OPERATION_CLASS).sort()).toEqual(
      [...TOOL_CAPABILITIES].sort(),
    );

    for (const operationClass of Object.values(TOOL_CAPABILITY_OPERATION_CLASS)) {
      expect(OperationClassSchema.parse(operationClass)).toBe(operationClass);
    }
  });

  /**
   * Section 12.3: "visible existing-profile control is a separate explicitly
   * granted capability". Two capabilities, not one with a flag — and they must
   * not share a class, or the separation would be nominal: a single grant shape
   * would cover both.
   */
  it("separates existing-profile control from isolated automation", () => {
    expect(TOOL_CAPABILITY_OPERATION_CLASS["browser.control_profile"]).toBe("external_write");
    expect(TOOL_CAPABILITY_OPERATION_CLASS["browser.automate_isolated"]).toBe(
      "local_reversible_edit",
    );
  });

  /**
   * THE GATE: writing a descriptor names an executable path and an origin
   * allowlist, so it widens what Noctis may reach. Section 9.1 puts that class
   * beyond any standing permission and beyond a model — and choosing
   * `credential_security` is what makes `evaluate.ts` enforce both with no new
   * policy code.
   */
  it("treats registering a descriptor as a security change", () => {
    expect(TOOL_CAPABILITY_OPERATION_CLASS["tool.register_descriptor"]).toBe("credential_security");
  });

  it("binds every tool grant to one tool", () => {
    expect(TOOL_TARGET_TYPE).toBe("tool");
  });
});

describe("ToolDescriptorSchema", () => {
  it("accepts a tool that offers nothing but instructions", () => {
    expect(ToolDescriptorSchema.parse(descriptor())).toMatchObject({ id: "vinted", routes: [] });
  });

  /**
   * THE GATE: a route and the facts it needs are one thing, not two. A
   * discriminated union means a handoff route cannot exist without origins and a
   * CLI route cannot exist without an executable — so the executor never has to
   * ask "and what if this is missing", which is where an unchecked URL would get
   * in.
   */
  it("refuses a handoff route with no origins to constrain it", () => {
    expect(
      ToolDescriptorSchema.safeParse(
        descriptor({
          routes: [{ route: "visible_handoff", url: "https://www.vinted.co.uk/items/new" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts a handoff route whose url its own origins cover", () => {
    const parsed = ToolDescriptorSchema.parse(
      descriptor({
        routes: [
          {
            route: "visible_handoff",
            url: "https://www.vinted.co.uk/items/new",
            origins: ["https://www.vinted.co.uk"],
          },
        ],
      }),
    );

    expect(parsed.routes[0]).toMatchObject({ route: "visible_handoff" });
  });

  /**
   * An origin allowlist that does not cover the tool's own landing URL is a
   * contradiction, and the executor would refuse the only thing the route
   * exists to do. Caught here rather than at execution, because a descriptor is
   * written once and executed many times.
   */
  it("refuses a handoff url its own origin allowlist would refuse", () => {
    expect(
      ToolDescriptorSchema.safeParse(
        descriptor({
          routes: [
            {
              route: "visible_handoff",
              url: "https://suno.com/create",
              origins: ["https://www.vinted.co.uk"],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  /** A descriptor may not carry a `file:` or `javascript:` url, whatever its origins say. */
  it("refuses a handoff url that is not http", () => {
    for (const url of ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)"]) {
      expect(
        ToolDescriptorSchema.safeParse(
          descriptor({ routes: [{ route: "visible_handoff", url, origins: [url] }] }),
        ).success,
      ).toBe(false);
    }
  });

  it("refuses two routes of the same name", () => {
    expect(
      ToolDescriptorSchema.safeParse(
        descriptor({
          routes: [
            { route: "manual", steps: ["Open the app"] },
            { route: "manual", steps: ["Open it again"] },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  /**
   * A CLI verb declares its own operation class, because the consequence of
   * running a command is a property of the command and not of the route. The
   * capability's class is the floor; this is what may raise it.
   */
  it("carries an operation class on every command verb", () => {
    const parsed = ToolDescriptorSchema.parse(
      descriptor({
        routes: [
          {
            route: "official_cli",
            executable: "gh",
            verbs: [
              {
                id: "pr_list",
                label: "List pull requests",
                args: ["pr", "list"],
                operationClass: "read_inspect",
              },
              {
                id: "pr_merge",
                label: "Merge",
                args: ["pr", "merge"],
                operationClass: "external_write",
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.routes[0]).toMatchObject({ route: "official_cli" });
  });

  /**
   * THE GATE: arguments are declared, never composed by a caller. A verb whose
   * args carried a shell metacharacter would be a command line a model could
   * extend, which is the whole reason the page sends a verb id rather than a
   * command.
   */
  it("refuses a verb whose arguments could extend the command line", () => {
    for (const argument of ["pr list && rm -rf /", "$(whoami)", "a|b", "a;b", "a`b`"]) {
      expect(
        ToolDescriptorSchema.safeParse(
          descriptor({
            routes: [
              {
                route: "official_cli",
                executable: "gh",
                verbs: [{ id: "x", label: "X", args: [argument], operationClass: "read_inspect" }],
              },
            ],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it("refuses a launch route with no executable", () => {
    expect(
      ToolDescriptorSchema.safeParse(descriptor({ routes: [{ route: "official_cli" }] })).success,
    ).toBe(false);
  });
});

describe("ToolIntentSchema", () => {
  /**
   * THE GATE: the page names a tool and a verb. If an intent could carry a URL,
   * an executable, or arguments, the descriptor would be advice rather than the
   * allowlist it is — the same rule `PlaceIntent` enforces by having nowhere to
   * put a pixel.
   */
  it("has nowhere to put a url, an executable, or an argument", () => {
    const parsed = ToolIntentSchema.parse({
      toolId: "vinted",
      verbId: "open_new_listing",
      url: "https://evil.example/",
      executable: "cmd.exe",
      args: ["/c", "calc"],
    });

    expect(parsed).toEqual({ toolId: "vinted", verbId: "open_new_listing" });
  });

  it("keeps the objective so the core can see it is active", () => {
    expect(
      ToolIntentSchema.parse({
        toolId: "vinted",
        verbId: "open_new_listing",
        objectiveId: "0199a000-0000-7000-8000-0000000000ff",
      }).objectiveId,
    ).toBe("0199a000-0000-7000-8000-0000000000ff");
  });
});

describe("route names", () => {
  it("names the four routes Section 12.3 lists", () => {
    expect([...ROUTE_NAMES]).toEqual([
      "official_cli",
      "isolated_browser",
      "visible_handoff",
      "manual",
    ]);
    expect(RouteNameSchema.parse("manual")).toBe("manual");
  });
});

describe("ToolRouteExecutionEvidenceSchema", () => {
  /**
   * Phase 10: "Record source identity, host, session, and verification
   * evidence." All four are required rather than optional, because evidence that
   * may omit which session it used cannot answer the question the isolation
   * grant exists to ask.
   */
  it("requires the session kind, the host, and the tool", () => {
    const complete = {
      toolId: "vinted",
      route: "visible_handoff" as const,
      capability: "browser.open_visible" as const,
      hostId: "desktop",
      sessionKind: "existing_profile" as const,
      startedAt: "2026-09-10T09:00:00.000Z",
      elapsedMs: 12,
      detail: { kind: "opened" as const, url: "https://www.vinted.co.uk/items/new" },
    };

    expect(ToolRouteExecutionEvidenceSchema.parse(complete).sessionKind).toBe("existing_profile");

    for (const missing of ["hostId", "sessionKind", "toolId"]) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[missing];
      expect(ToolRouteExecutionEvidenceSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("records the correlation id a launch produced, so a window can be tied to it", () => {
    const evidence = ToolRouteExecutionEvidenceSchema.parse({
      toolId: "vscode",
      route: "official_cli",
      capability: "tool.launch",
      hostId: "desktop",
      sessionKind: "none",
      startedAt: "2026-09-10T09:00:00.000Z",
      elapsedMs: 340,
      detail: { kind: "launched", processId: 4242, launchCorrelationId: "launch-7" },
    });

    expect(evidence.detail).toMatchObject({ launchCorrelationId: "launch-7" });
  });
});

describe("ExternalToolStateSchema", () => {
  it("accepts a null confirmation phrase, because Rust sends one", () => {
    expect(
      ExternalToolStateSchema.parse({
        kind: "needsApproval",
        requestId: "req-1",
        outcome: "require_confirmation",
        consequenceSummary: "Open Vinted",
        confirmationPhrase: null,
      }).kind,
    ).toBe("needsApproval");
  });

  it("carries the reason a route was unavailable rather than reporting nothing", () => {
    expect(
      ExternalToolStateSchema.parse({
        kind: "routeUnavailable",
        route: "isolated_browser",
        reason: "No isolated browser executor is built yet.",
      }).kind,
    ).toBe("routeUnavailable");
  });
});
