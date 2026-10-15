import type { OperationClass, StandingPermission, ToolCapability } from "@noctis/contracts";
import {
  OperationClassSchema,
  WINDOW_CAPABILITIES,
  WINDOW_CAPABILITY_OPERATION_CLASS,
  WINDOW_TARGET_TYPE,
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_OPERATION_CLASS,
  TOOL_TARGET_TYPE,
} from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { AuthorityEvaluationInput } from "./evaluate.js";
import { BASELINE_POLICY_ID, evaluateAuthority, isConfirmLevel } from "./evaluate.js";
import { raisedOperationClass } from "../tools/route.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ACTOR = "vesper";
const CAPABILITY = "fs.read";
const TARGET = { type: "repository", id: "noctis-os" } as const;

const ALL_CLASSES: readonly OperationClass[] = OperationClassSchema.options;

/**
 * Operation classes a standing permission may never upgrade. Written out here
 * rather than imported from the module under test, so that deleting an entry in
 * the implementation fails this file instead of agreeing with it.
 */
const NEVER_DELEGABLE: readonly OperationClass[] = [
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
];

function input(overrides: Partial<AuthorityEvaluationInput> = {}): AuthorityEvaluationInput {
  return {
    operationClass: "read_inspect",
    capability: CAPABILITY,
    actorId: ACTOR,
    target: TARGET,
    objectiveIsActive: false,
    standingPermissions: [],
    now: NOW,
    ...overrides,
  };
}

function permission(overrides: Partial<StandingPermission> = {}): StandingPermission {
  return {
    id: "0199a000-0000-7000-8000-000000000001",
    actorId: ACTOR,
    capability: CAPABILITY,
    operationClass: "external_write",
    constraints: { targetType: TARGET.type, targetIds: [TARGET.id] },
    grantedAt: "2026-08-01T00:00:00.000Z",
    grantedBy: "local",
    ...overrides,
  };
}

describe("scheduled task standing permissions", () => {
  const taskId = "0199a000-0000-7000-8000-000000000011";
  it("does not lend a task permission to an ordinary chat or another task", () => {
    const grant = permission({ taskId });
    for (const task of [undefined, "0199a000-0000-7000-8000-000000000012"]) {
      expect(
        evaluateAuthority(
          input({
            operationClass: "external_write",
            ...(task === undefined ? {} : { taskId: task }),
            standingPermissions: [grant],
          }),
        ).outcome,
      ).toBe("require_confirmation");
    }
  });
  it("uses the owner's exact task permission even when the runtime asks again", () => {
    expect(
      evaluateAuthority(
        input({
          operationClass: "external_write",
          taskId,
          askedByRuntime: true,
          standingPermissions: [permission({ taskId })],
        }),
      ).outcome,
    ).toBe("allow");
  });
  it("does not borrow a global permission or delegate a destructive operation", () => {
    expect(
      evaluateAuthority(
        input({ operationClass: "external_write", taskId, standingPermissions: [permission()] }),
      ).outcome,
    ).toBe("require_confirmation");
    expect(
      evaluateAuthority(
        input({
          operationClass: "destructive",
          taskId,
          askedByRuntime: true,
          standingPermissions: [permission({ taskId, operationClass: "destructive" })],
        }),
      ).outcome,
    ).toBe("require_typed_confirmation");
  });
});

describe("evaluateAuthority", () => {
  it("covers every operation class the contract defines", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(input({ operationClass }));

      expect(decision.reasonCodes).not.toContain("unknown_operation_class");
      expect(decision.policyId).toBe(BASELINE_POLICY_ID);
    }
  });

  it("denies an operation class outside the policy table", () => {
    const decision = evaluateAuthority(
      input({ operationClass: "not_a_real_class" as OperationClass }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reasonCodes).toEqual(["unknown_operation_class"]);
  });

  it("allows only read_inspect without a scope or a permission", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(input({ operationClass }));

      if (operationClass === "read_inspect") {
        expect(decision.outcome).toBe("allow");
      } else {
        expect(decision.outcome).not.toBe("allow");
      }
    }
  });

  it("requires typed confirmation for the consequence classes", () => {
    for (const operationClass of NEVER_DELEGABLE) {
      expect(evaluateAuthority(input({ operationClass })).outcome).toBe(
        "require_typed_confirmation",
      );
    }
  });

  it("allows a local reversible edit only inside an active objective", () => {
    const inactive = evaluateAuthority(input({ operationClass: "local_reversible_edit" }));
    const active = evaluateAuthority(
      input({ operationClass: "local_reversible_edit", objectiveIsActive: true }),
    );

    expect(inactive.outcome).toBe("require_confirmation");
    expect(inactive.reasonCodes).toContain("objective_not_active");
    expect(active.outcome).toBe("allow");
    expect(active.reasonCodes).toContain("objective_active_scope");
  });

  it("upgrades a confirmation to allow on a matching standing permission", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        standingPermissions: [permission()],
      }),
    );

    expect(decision.outcome).toBe("allow");
    expect(decision.reasonCodes).toContain("standing_permission_matched");
    expect(decision.permissionId).toBe(permission().id);
  });

  it("never lets a standing permission cover a consequence class", () => {
    for (const operationClass of NEVER_DELEGABLE) {
      const decision = evaluateAuthority(
        input({
          operationClass,
          standingPermissions: [permission({ operationClass })],
        }),
      );

      expect(decision.outcome).toBe("require_typed_confirmation");
      expect(decision.permissionId).toBeUndefined();
      expect(decision.reasonCodes).toContain("standing_permission_ineligible_operation_class");
    }
  });

  it.each([
    ["revoked", permission({ revokedAt: "2026-08-20T00:00:00.000Z" })],
    ["expired", permission({ expiresAt: "2026-08-31T00:00:00.000Z" })],
    ["expiring exactly now", permission({ expiresAt: "2026-09-01T12:00:00.000Z" })],
    ["for another actor", permission({ actorId: "jester" })],
    ["for another capability", permission({ capability: "fs.write" })],
    ["for another operation class", permission({ operationClass: "publish" })],
  ])("ignores a standing permission that is %s", (_label, unusable) => {
    const decision = evaluateAuthority(
      input({ operationClass: "external_write", standingPermissions: [unusable] }),
    );

    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.permissionId).toBeUndefined();
  });

  it("honours a permission that has not yet expired", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        standingPermissions: [permission({ expiresAt: "2026-09-01T12:00:00.001Z" })],
      }),
    );

    expect(decision.outcome).toBe("allow");
  });
});

describe("THE GATE: a standing permission is narrow and target-bound", () => {
  it("does not cover a target it does not name", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        target: { type: "repository", id: "some-other-repo" },
        standingPermissions: [permission()],
      }),
    );

    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.permissionId).toBeUndefined();
  });

  it("does not cover another type of target with the same id", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        target: { type: "vinted_listing", id: TARGET.id },
        standingPermissions: [permission()],
      }),
    );

    expect(decision.outcome).toBe("require_confirmation");
  });

  it("does not cover a request on a host it was not granted for", () => {
    const hostBound = permission({
      constraints: { targetType: TARGET.type, targetIds: [TARGET.id], hostIds: ["desk"] },
    });

    expect(
      evaluateAuthority(
        input({
          operationClass: "external_write",
          target: { ...TARGET, hostId: "laptop" },
          standingPermissions: [hostBound],
        }),
      ).outcome,
    ).toBe("require_confirmation");

    expect(
      evaluateAuthority(
        input({
          operationClass: "external_write",
          target: { ...TARGET, hostId: "desk" },
          standingPermissions: [hostBound],
        }),
      ).outcome,
    ).toBe("allow");
  });

  it("does not treat a host-bound permission as covering a host-less request", () => {
    // The permission is narrower than the request, so it cannot cover it. The
    // opposite reading — "no host named, so any host" — is how a laptop grant
    // ends up authorising the production machine.
    const decision = evaluateAuthority(
      input({
        operationClass: "external_write",
        standingPermissions: [
          permission({
            constraints: { targetType: TARGET.type, targetIds: [TARGET.id], hostIds: ["desk"] },
          }),
        ],
      }),
    );

    expect(decision.outcome).toBe("require_confirmation");
  });

  it("THE GATE: never lets a permission grant the power to grant permissions", () => {
    for (const capability of ["authority.grant_permission", "authority.revoke_permission"]) {
      const decision = evaluateAuthority(
        input({
          operationClass: "external_write",
          capability,
          standingPermissions: [permission({ capability })],
        }),
      );

      expect(decision.outcome).toBe("require_confirmation");
      expect(decision.permissionId).toBeUndefined();
      expect(decision.reasonCodes).toContain("authority_management_never_delegated");
    }
  });
});

describe("THE GATE: typed confirmation names what is about to happen", () => {
  it("gives spend a phrase carrying the amount and the target", () => {
    const decision = evaluateAuthority(
      input({
        operationClass: "spend",
        target: { type: "provider", id: "suno" },
        estimatedCostGbp: 12.5,
      }),
    );

    expect(decision.outcome).toBe("require_typed_confirmation");
    expect(decision.confirmationPhrase).toBe("SPEND GBP 12.50 ON provider:suno");
  });

  it("names the exact target of a destructive operation", () => {
    expect(
      evaluateAuthority(
        input({ operationClass: "destructive", target: { type: "database", id: "core.db" } }),
      ).confirmationPhrase,
    ).toBe("DESTROY database:core.db");
  });

  it("gives every typed class a phrase and every other class none", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(input({ operationClass }));

      if (NEVER_DELEGABLE.includes(operationClass)) {
        expect(decision.confirmationPhrase, operationClass).toBeDefined();
      } else {
        expect(decision.confirmationPhrase, operationClass).toBeUndefined();
      }
    }
  });

  it("is deterministic, so the stored phrase and the checked phrase are one string", () => {
    const twice = [1, 2].map(
      () =>
        evaluateAuthority(input({ operationClass: "spend", estimatedCostGbp: 0.1 }))
          .confirmationPhrase,
    );

    expect(twice[0]).toBe(twice[1]);
    // Pence, not float formatting: 0.1 must never render as 0.10000000000000001.
    expect(twice[0]).toContain("GBP 0.10");
  });
});

/**
 * Phase 9 routes native window placement through this evaluator rather than
 * inventing a second permission model. These tests pin what that decision
 * actually buys, because the answer is not obvious from the capability names.
 */
describe("native window placement routes through the same authority", () => {
  const VSCODE = { type: WINDOW_TARGET_TYPE, id: "vscode" } as const;
  const EMULATOR = { type: WINDOW_TARGET_TYPE, id: "emulator" } as const;

  function placement(overrides: Partial<AuthorityEvaluationInput> = {}): AuthorityEvaluationInput {
    return input({
      capability: "window.place",
      operationClass: WINDOW_CAPABILITY_OPERATION_CLASS["window.place"],
      target: VSCODE,
      ...overrides,
    });
  }

  function windowPermission(targetIds: string[]): StandingPermission {
    return permission({
      capability: "window.place",
      operationClass: WINDOW_CAPABILITY_OPERATION_CLASS["window.place"],
      constraints: { targetType: WINDOW_TARGET_TYPE, targetIds },
    });
  }

  it("lets anyone look at the windows that are open", () => {
    const decision = evaluateAuthority(
      placement({
        capability: "window.discover",
        operationClass: WINDOW_CAPABILITY_OPERATION_CLASS["window.discover"],
      }),
    );

    expect(decision.outcome).toBe("allow");
  });

  /**
   * THE GATE: with nothing granted and no Objective running, rearranging
   * somebody's desk is a consequence they get asked about.
   */
  it("asks before moving a window with no grant and no active objective", () => {
    const decision = evaluateAuthority(placement());

    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.reasonCodes).toContain("objective_not_active");
  });

  /**
   * The scope clause in Section 9.1 is what makes focus mode usable: an active
   * Objective is the user's declared context, and arranging the tools for it is
   * the whole point. Pinned here because it is the difference between Noctis
   * tidying a desk on request and tidying one uninvited.
   */
  it("places without asking while an objective is active", () => {
    const decision = evaluateAuthority(placement({ objectiveIsActive: true }));

    expect(decision.outcome).toBe("allow");
    expect(decision.reasonCodes).toContain("objective_active_scope");
  });

  it("places without asking when a standing permission names that window", () => {
    const decision = evaluateAuthority(
      placement({ standingPermissions: [windowPermission(["vscode"])] }),
    );

    expect(decision.outcome).toBe("allow");
    expect(decision.reasonCodes).toContain("standing_permission_matched");
  });

  /**
   * THE GATE: a grant is target-bound. Letting Noctis arrange the editor is not
   * letting it arrange everything else on the machine.
   */
  it("does not let a grant for one application reach another", () => {
    const decision = evaluateAuthority(
      placement({ target: EMULATOR, standingPermissions: [windowPermission(["vscode"])] }),
    );

    expect(decision.outcome).toBe("require_confirmation");
    expect(decision.reasonCodes).not.toContain("standing_permission_matched");
  });

  it("does not let a window grant reach a file with the same id", () => {
    const decision = evaluateAuthority(
      placement({
        target: { type: "file", id: "vscode" },
        standingPermissions: [windowPermission(["vscode"])],
      }),
    );

    expect(decision.outcome).toBe("require_confirmation");
  });

  /** A revoked grant is the control the Settings screen already offers. */
  it("stops placing the moment a grant is revoked", () => {
    const revoked: StandingPermission = {
      ...windowPermission(["vscode"]),
      revokedAt: "2026-08-15T00:00:00.000Z",
      revokedReason: "changed my mind",
    };

    expect(evaluateAuthority(placement({ standingPermissions: [revoked] })).outcome).toBe(
      "require_confirmation",
    );
  });

  /**
   * Placement must never be classed so high that it needs a typed phrase. A
   * confirmation that appears every time a window moves is one nobody reads,
   * and a confirmation nobody reads is worse than none.
   */
  it("never demands a typed confirmation to move a window", () => {
    for (const capability of WINDOW_CAPABILITIES) {
      const decision = evaluateAuthority(
        placement({ capability, operationClass: WINDOW_CAPABILITY_OPERATION_CLASS[capability] }),
      );

      expect(decision.outcome).not.toBe("require_typed_confirmation");
      expect(decision.confirmationPhrase).toBeUndefined();
    }
  });
});

describe("tool routes go through the same authority", () => {
  const VINTED = { type: TOOL_TARGET_TYPE, id: "vinted" } as const;
  const SUNO = { type: TOOL_TARGET_TYPE, id: "suno" } as const;

  function toolRequest(
    capability: ToolCapability,
    overrides: Partial<AuthorityEvaluationInput> = {},
  ): AuthorityEvaluationInput {
    return input({
      capability,
      operationClass: TOOL_CAPABILITY_OPERATION_CLASS[capability],
      target: VINTED,
      ...overrides,
    });
  }

  function toolPermission(capability: ToolCapability, targetIds: string[]): StandingPermission {
    return permission({
      capability,
      operationClass: TOOL_CAPABILITY_OPERATION_CLASS[capability],
      constraints: { targetType: TOOL_TARGET_TYPE, targetIds },
    });
  }

  it("lets anyone look at what a tool offers", () => {
    expect(evaluateAuthority(toolRequest("tool.inspect")).outcome).toBe("allow");
  });

  /**
   * THE GATE, and the whole reason `tool.launch` is `local_reversible_edit`:
   * opening the editor for the work in hand is what focus mode does, and a
   * prompt every time would make it useless. With no Objective it still asks.
   */
  it("launches without asking while an objective is active, and asks otherwise", () => {
    expect(evaluateAuthority(toolRequest("tool.launch")).outcome).toBe("require_confirmation");
    expect(evaluateAuthority(toolRequest("tool.launch", { objectiveIsActive: true })).outcome).toBe(
      "allow",
    );
  });

  /**
   * Opening a tab in somebody's own browser is the handoff itself, not a write.
   * It travels the same path as a placement for the same reason.
   */
  it("hands off to a visible browser without asking under an active objective", () => {
    expect(
      evaluateAuthority(toolRequest("browser.open_visible", { objectiveIsActive: true })).outcome,
    ).toBe("allow");
  });

  /**
   * THE GATE for Section 12.3's separation. Driving the signed-in profile is an
   * `external_write`, so an active Objective does *not* clear it — the scope
   * clause only covers `local_reversible_edit`. Isolated automation does clear.
   * That difference is the separation, and it needs no flag to enforce.
   */
  it("does not let an active objective authorise driving the signed-in profile", () => {
    expect(
      evaluateAuthority(toolRequest("browser.control_profile", { objectiveIsActive: true }))
        .outcome,
    ).toBe("require_confirmation");
    expect(
      evaluateAuthority(toolRequest("browser.automate_isolated", { objectiveIsActive: true }))
        .outcome,
    ).toBe("allow");
  });

  /**
   * THE GATE: a grant for one tool is a grant for one tool. Section 12.3's
   * narrow reading of existing-profile control — "drive my browser on Vinted",
   * not "drive my browser" — is only true if the target binding holds.
   */
  it("refuses a profile-control grant issued for another tool", () => {
    const forVinted = [toolPermission("browser.control_profile", ["vinted"])];

    expect(
      evaluateAuthority(toolRequest("browser.control_profile", { standingPermissions: forVinted }))
        .outcome,
    ).toBe("allow");
    expect(
      evaluateAuthority(
        toolRequest("browser.control_profile", { standingPermissions: forVinted, target: SUNO }),
      ).outcome,
    ).toBe("require_confirmation");
  });

  /**
   * THE GATE: a grant to drive the signed-in profile must not also cover
   * isolated automation or the reverse. They differ in name *and* class, and
   * `covers` compares both — so this holds even if somebody later gives them the
   * same class by mistake.
   */
  it("does not let an isolated-automation grant cover the signed-in profile", () => {
    const isolated = [toolPermission("browser.automate_isolated", ["vinted"])];

    expect(
      evaluateAuthority(toolRequest("browser.control_profile", { standingPermissions: isolated }))
        .outcome,
    ).toBe("require_confirmation");
  });

  /**
   * THE GATE: writing a descriptor names an executable and an origin allowlist,
   * so it widens what Noctis may reach. `credential_security` puts it beyond
   * every standing permission and every active Objective, and this asserts the
   * existing policy actually delivers that rather than the table merely saying so.
   */
  it("never delegates registering a tool, whatever is granted or active", () => {
    const granted = [toolPermission("tool.register_descriptor", ["vinted"])];

    const decision = evaluateAuthority(
      toolRequest("tool.register_descriptor", {
        objectiveIsActive: true,
        standingPermissions: granted,
      }),
    );

    expect(decision.outcome).toBe("require_typed_confirmation");
    expect(decision.confirmationPhrase).toBeDefined();
    expect(decision.reasonCodes).toContain("standing_permission_ineligible_operation_class");
  });

  /**
   * The commit boundary. A verb that publishes raises the class above the
   * capability's floor, and the raised class is what authority sees — so
   * preparation is cheap and the commit is not.
   */
  it("asks harder when a verb raises the class above the capability's floor", () => {
    const floor = evaluateAuthority(toolRequest("tool.run_command", { objectiveIsActive: true }));
    const spending = evaluateAuthority(
      input({
        capability: "tool.run_command",
        operationClass: raisedOperationClass("tool.run_command", "spend"),
        target: VINTED,
        objectiveIsActive: true,
      }),
    );

    expect(floor.outcome).toBe("require_confirmation");
    expect(spending.outcome).toBe("require_typed_confirmation");
  });

  /** Every tool capability's declared class must be one the evaluator handles. */
  it("decides every tool capability rather than falling through", () => {
    for (const capability of TOOL_CAPABILITIES) {
      const decision = evaluateAuthority(toolRequest(capability));

      expect(decision.policyId).toBe(BASELINE_POLICY_ID);
      expect(decision.reasonCodes).not.toContain("unknown_operation_class");
    }
  });
});

describe("the agents decide the everyday, Noctis confirms the consequential", () => {
  /** Section 9.1's confirm rows, written out so a change to the table fails here. */
  const CONFIRM_LEVEL: readonly OperationClass[] = [
    "external_write",
    "message_send",
    "publish",
    "spend",
    "destructive",
    "production_deploy",
    "credential_security",
  ];

  it("names exactly the confirm-level classes", () => {
    expect(ALL_CLASSES.filter((operationClass) => isConfirmLevel(operationClass))).toEqual(
      CONFIRM_LEVEL,
    );
  });

  it("puts every ask an agent raised itself in front of a person, even a read", () => {
    for (const operationClass of ALL_CLASSES) {
      const decision = evaluateAuthority(
        input({ operationClass, objectiveIsActive: true, askedByRuntime: true }),
      );

      expect(decision.outcome, operationClass).not.toBe("allow");
    }

    expect(
      evaluateAuthority(input({ operationClass: "read_inspect", askedByRuntime: true })),
    ).toMatchObject({
      outcome: "require_confirmation",
      reasonCodes: ["operation_class_default", "runtime_asked"],
    });
  });

  it("does not soften a typed confirmation the agent's ask lands on", () => {
    expect(
      evaluateAuthority(input({ operationClass: "destructive", askedByRuntime: true })).outcome,
    ).toBe("require_typed_confirmation");
  });
});
