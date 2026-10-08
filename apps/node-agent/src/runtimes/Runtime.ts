import type {
  ExternalSession,
  RuntimeAnswer,
  RuntimeAsk,
  RuntimeDelegation,
  RuntimeDelegationResult,
  RuntimeItem,
  RuntimeProbe,
  RuntimeProviderId,
  RuntimeTurnEvidence,
  RuntimeTurnPayload,
  SessionExchange,
} from "@noctis/contracts";

/** The node refused the job itself. Reported to the core as a failure, not a crash. */
export class AdapterRefused extends Error {}

/** How long a turn waits for a person to answer an approval before it fails. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Nobody answered an approval in time. A runtime fails its turn with this message. */
export class ApprovalTimedOut extends Error {
  constructor(summary: string, timeoutMs: number) {
    const within =
      timeoutMs >= 60_000
        ? `${String(Math.round(timeoutMs / 60_000))} minutes`
        : timeoutMs >= 1_000
          ? `${String(Math.round(timeoutMs / 1_000))} seconds`
          : `${String(timeoutMs)} ms`;

    super(`approval timed out: "${summary}" was not answered within ${within}`);
  }
}

/** Grant roots made real: every path is a `realpath`, so junctions cannot widen a grant. */
export interface ResolvedRoots {
  cwd: string;
  writable: string[];
  readable: string[];
  localOnly: boolean;
}

/** What a runtime says mid-turn. `ask` blocks until the core answers; the runtime never decides. */
export interface RuntimeSink {
  item(item: RuntimeItem): void;
  delta(itemId: string, text: string): void;
  ask(ask: Omit<RuntimeAsk, "askId">): Promise<RuntimeAnswer>;
  /** Hands work to another agent through the core and waits for the child turn to end. */
  delegate(delegation: Omit<RuntimeDelegation, "delegationId">): Promise<RuntimeDelegationResult>;
  /** Gives the core a file the turn made, so the owner can open it anywhere. Resolves to its attachment id. */
  upload(output: RuntimeUpload): Promise<string>;
}

export interface RuntimeUpload {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface RuntimeTurnInput {
  payload: RuntimeTurnPayload;
  roots: ResolvedRoots;
  /** Already stripped of billing keys. A runtime spawns children with this and nothing else. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface Runtime {
  providerId: RuntimeProviderId;
  probe(): Promise<RuntimeProbe>;
  turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence>;
  /**
   * The sessions this agent keeps on disk for `cwd`, newest first, started
   * anywhere but Noctis: what the owner can pick up and continue.
   */
  listSessions?(cwd: string, env: NodeJS.ProcessEnv): Promise<ExternalSession[]>;
  /**
   * The last exchanges of one session kept for `cwd`, oldest first: what the
   * owner said and the reply the agent ended on. A session kept for another
   * folder is not found.
   */
  readHistory?(cwd: string, sessionRef: string, env: NodeJS.ProcessEnv): Promise<SessionExchange[]>;
  /** Ends every process the runtime is keeping open between turns. */
  close?(): void;
}
