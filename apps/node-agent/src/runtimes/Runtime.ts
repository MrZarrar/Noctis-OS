import type {
  RuntimeAnswer,
  RuntimeAsk,
  RuntimeItem,
  RuntimeProbe,
  RuntimeProviderId,
  RuntimeTurnEvidence,
  RuntimeTurnPayload,
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
  /** Ends every process the runtime is keeping open between turns. */
  close?(): void;
}
