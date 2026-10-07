import type {
  AuthorityOutcome,
  AuthorityTarget,
  OperationClass,
  StandingPermission,
} from "@noctis/contracts";

import { confirmationPhraseFor, requiresTypedConfirmation } from "./confirmation.js";

export const BASELINE_POLICY_ID = "baseline.v1";

/**
 * Master plan Section 9.1, "Default policy". Pure and total over the enum.
 *
 * `local_reversible_edit` is listed as "allow or require confirmation by scope";
 * the scope test lives in `evaluateAuthority`, and this table holds the stricter
 * of the two so a scope check that never runs cannot silently widen authority.
 */
const DEFAULT_OUTCOME: Readonly<Record<OperationClass, AuthorityOutcome>> = {
  read_inspect: "allow",
  local_reversible_edit: "require_confirmation",
  external_write: "require_confirmation",
  message_send: "require_confirmation",
  publish: "require_confirmation",
  spend: "require_typed_confirmation",
  destructive: "require_typed_confirmation",
  production_deploy: "require_typed_confirmation",
  credential_security: "require_typed_confirmation",
};

/**
 * "Standing permissions ... cannot cover spend, destructive operations,
 * production activation, credential/security changes, or widening their own
 * scope." Kept as its own set rather than inferred from the outcome table, so
 * that relaxing a default outcome cannot accidentally make one of these
 * delegable.
 */
const PERMISSION_INELIGIBLE: ReadonlySet<OperationClass> = new Set<OperationClass>([
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
]);

/**
 * "...or widening their own scope."
 *
 * Granting and revoking permissions are themselves capabilities, and a standing
 * permission that covered one would be a permission that can write itself a
 * larger one. Named here rather than left to the operation class, because the
 * grant of a narrow read permission is not itself a read.
 */
export const AUTHORITY_MANAGEMENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "authority.grant_permission",
  "authority.revoke_permission",
]);

export interface AuthorityEvaluationInput {
  operationClass: OperationClass;
  capability: string;
  actorId: string;
  target: AuthorityTarget;
  estimatedCostGbp?: number;
  /** True only when the request names an Objective that is currently `active`. */
  objectiveIsActive: boolean;
  standingPermissions: readonly StandingPermission[];
  /** Epoch milliseconds from the injected clock. */
  now: number;
  /**
   * The agent's own permission system asked, rather than Noctis stopping it.
   * The agent wanted a person, so policy alone never answers for one.
   */
  askedByRuntime?: boolean;
}

export interface AuthorityEvaluation {
  outcome: AuthorityOutcome;
  policyId: string;
  reasonCodes: string[];
  permissionId?: string;
  /** Set exactly when the outcome is `require_typed_confirmation`. */
  confirmationPhrase?: string;
}

/**
 * Whether one permission covers one request.
 *
 * Every clause is an `AND`, and the constraint clauses fail closed: a
 * permission whose `targetIds` does not name this target does not apply, and a
 * permission that names a host does not apply to a request on another one.
 */
function covers(permission: StandingPermission, input: AuthorityEvaluationInput): boolean {
  if (permission.revokedAt !== undefined) {
    return false;
  }

  if (permission.expiresAt !== undefined && Date.parse(permission.expiresAt) <= input.now) {
    return false;
  }

  if (
    permission.actorId !== input.actorId ||
    permission.capability !== input.capability ||
    permission.operationClass !== input.operationClass
  ) {
    return false;
  }

  const constraints = permission.constraints;

  if (constraints.targetType !== input.target.type) {
    return false;
  }

  if (!constraints.targetIds.includes(input.target.id)) {
    return false;
  }

  if (constraints.hostIds !== undefined) {
    // A host-bound permission on a request that names no host: the permission
    // is narrower than the request, so it does not cover it.
    return input.target.hostId !== undefined && constraints.hostIds.includes(input.target.hostId);
  }

  return true;
}

function decide(
  outcome: AuthorityOutcome,
  reasonCodes: string[],
  input: AuthorityEvaluationInput,
  permissionId?: string,
): AuthorityEvaluation {
  const phrase =
    outcome === "require_typed_confirmation"
      ? confirmationPhraseFor({
          operationClass: input.operationClass,
          target: input.target,
          ...(input.estimatedCostGbp === undefined
            ? {}
            : { estimatedCostGbp: input.estimatedCostGbp }),
        })
      : undefined;

  return {
    outcome,
    policyId: BASELINE_POLICY_ID,
    reasonCodes,
    ...(permissionId === undefined ? {} : { permissionId }),
    ...(phrase === undefined ? {} : { confirmationPhrase: phrase }),
  };
}

/**
 * The Section 9.1 rows that confirm: everything but a read and a local edit.
 * A runtime brings these to Noctis before acting; below them the agent's own
 * permission system decides.
 */
export function isConfirmLevel(operationClass: OperationClass): boolean {
  return operationClass !== "read_inspect" && operationClass !== "local_reversible_edit";
}

/**
 * The single authority decision function. Pure, deterministic, and fail-closed:
 * an operation class outside the table denies rather than falling through.
 */
export function evaluateAuthority(input: AuthorityEvaluationInput): AuthorityEvaluation {
  const evaluation = evaluatePolicy(input);

  if (input.askedByRuntime === true && evaluation.outcome === "allow") {
    return decide("require_confirmation", [...evaluation.reasonCodes, "runtime_asked"], input);
  }

  return evaluation;
}

function evaluatePolicy(input: AuthorityEvaluationInput): AuthorityEvaluation {
  const base = DEFAULT_OUTCOME[input.operationClass] as AuthorityOutcome | undefined;

  if (base === undefined) {
    return decide("deny", ["unknown_operation_class"], input);
  }

  // A cross-check rather than a second source of truth: if the table and the
  // typed-confirmation rule ever disagree, the stricter one wins and says so.
  if (requiresTypedConfirmation(input.operationClass) && base !== "require_typed_confirmation") {
    return decide("require_typed_confirmation", ["typed_confirmation_required"], input);
  }

  const reasonCodes = ["operation_class_default"];

  if (input.operationClass === "local_reversible_edit") {
    if (input.objectiveIsActive) {
      return decide("allow", ["objective_active_scope"], input);
    }

    reasonCodes.push("objective_not_active");
  }

  if (AUTHORITY_MANAGEMENT_CAPABILITIES.has(input.capability)) {
    // Recorded before any permission is consulted, so the audit trail shows
    // that no grant was even eligible rather than that none happened to match.
    reasonCodes.push("authority_management_never_delegated");

    return decide(base, reasonCodes, input);
  }

  const permission = input.standingPermissions.find((candidate) => covers(candidate, input));

  if (permission === undefined) {
    return decide(base, reasonCodes, input);
  }

  if (PERMISSION_INELIGIBLE.has(input.operationClass)) {
    // Recorded rather than ignored: an operator who granted a permission that
    // cannot apply should be able to see that in the audit trail.
    reasonCodes.push("standing_permission_ineligible_operation_class");

    return decide(base, reasonCodes, input);
  }

  if (base !== "require_confirmation") {
    return decide(base, reasonCodes, input);
  }

  reasonCodes.push("standing_permission_matched");

  return decide("allow", reasonCodes, input, permission.id);
}
