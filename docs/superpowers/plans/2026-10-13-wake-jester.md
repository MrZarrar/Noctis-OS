# Wake Jester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jester's first reply no longer waits for a cold start: the owner wakes it with a button, or it wakes as they start typing, so LM Studio loads Qwen and Hermes starts while the prompt is still being written.

**Architecture:** A new node job, `runtime.warm`, carries everything a turn carries except the prompt. The node runs the runtime's optional `warm()`: for Hermes and the local model that is `ensureModel` (LM Studio loads the model, 10-minute TTL) and, for Hermes, opening the thread's process in the existing pool so the first turn reuses it. Claude and Codex have no `warm()`, so the job completes at once. The core answers `conversation.warm` by choosing the node, model and root exactly as `conversation.send` does, enqueues the job, and tracks a per-thread "awake until" time that the web shows as a new `asleep` core state.

**Tech Stack:** TypeScript, Node 22.23.2, zod 4, vitest 4, React 18. No new dependencies.

**Depends on:** [Settings in the UI](2026-10-13-settings-in-the-ui.md) for the `wakeWhileTyping` setting. Build order: settings, Vault promoter, then this.

**Spec:** The owner, 2026-10-13: "Jester can be awoken without sending a prompt. A wake up button, and he goes from sleeping to idle (the Hermes LLM starts). This lets me wake it up whilst I'm writing the prompt, making it overall faster." Agreed refinement: wake also starts on the first keystroke to a sleeping agent (a Settings toggle, on by default), and the button stays for waking before writing.

## Global Constraints

- Node.js 22.23.2, exact package lock, no new packages. Failing test first.
- **Deploy order:** the node advertises a new capability, `runtime.warm`. A core that does not know it rejects the node's hello (the trap recorded in the v1 scope memory). Deploy the work-PC core first, then restart nodes.
- A wake never creates a turn, a message or an approval, and never runs a model on a prompt.
- A wake is idempotent and cheap to repeat: waking an awake agent only extends its "awake until".
- Waking must not change which node, model or folder the next turn uses; it resolves them with the same function `conversation.send` uses.
- The automatic wake is a Settings toggle (`wakeWhileTyping`, default on), never a code constant.

## Review Focus

1. **Wake, then send before the model finishes loading:** the turn waits for the same load instead of starting a second one. LM Studio's `lms load` of a model already loading must not load it twice. (Task 2 test "a turn during a wake reuses the load".)
2. **Wake, then send on a different model:** the turn loads its own model; the woken one unloads on its TTL. (Task 3 test "a wake does not choose the turn's model".)
3. **Typing in bursts:** the automatic wake fires once per sleeping period, not per keystroke. (Task 4 test "one wake per sleep, however much is typed".)
4. **The node offline:** the wake is refused as `unavailable` and the page says the PC is asleep, not that Jester is awake. (Task 3 test "no node, no wake".)
5. **The model unloaded early** (LM Studio restarted, or another model loaded over it): the page may show awake for up to the TTL while the model is gone; the next turn simply loads it again. Accepted and recorded, not tested.

---

### Task 1: The contract

**Files:** `packages/contracts/src/node.ts` (`"runtime.warm"` in `NODE_CAPABILITIES`, and its operation class `read_inspect` in `CAPABILITY_OPERATION_CLASS`), `packages/contracts/src/runtime.ts` (`RuntimeWarmPayloadSchema`: the turn payload schema with `prompt` and `attachments` omitted), `packages/contracts/src/command.ts` (`WarmConversationCommandSchema = { ...CommandBase, identityId, threadId?, model? }`, name `"conversation.warm"`).
**Test:** `packages/contracts/src/runtime.test.ts`

- [ ] Failing test: `RuntimeWarmPayloadSchema.parse(turnPayloadFixture)` strips `prompt` (or refuses it as an unknown key under `.strict()`, whichever the turn schema's style is), and `WarmConversationCommandSchema` accepts `{ idempotencyKey, identityId: "jester" }`.
- [ ] Implement; `npx vitest run packages/contracts`; commit `feat(contracts): a wake job and command`.

### Task 2: The node warms a runtime

**Files:** `apps/node-agent/src/runtimes/Runtime.ts` (optional `warm?(input: RuntimeWarmInput): Promise<void>` on `Runtime`), `apps/node-agent/src/runtimes/hermes.ts` (`warm`: resolve the command, `ensureModel`, then `pool.prepare(threadId, { key, sessionRef }, () => open(input, key, command))`), `apps/node-agent/src/runtimes/sessions.ts` (`prepare`: open and park a process for a thread without running anything, keeping the idle timer), `apps/node-agent/src/runtimes/local.ts` (`warm`: `ensureModel` only), `apps/node-agent/src/runtimes/lmstudio.ts` (concurrent `ensure` calls for one model share one in-flight promise), `apps/node-agent/src/adapters.ts` (a `runtime.warm` adapter: parse, resolve roots like `runtimeTurn`, call `runtime.warm` if present, return `{ warmed: boolean }`).
**Tests:** `hermes.test.ts`, `sessions.test.ts`, `lmstudio.test.ts`, `adapters.test.ts`

- [ ] Failing tests:
  - "warming Hermes loads the model and starts the thread's process, and the next turn reuses it": after `warm`, `spawned` has one entry; after a `turn` on the same thread and roots, still one.
  - "a turn during a wake reuses the load": `ensure` called twice concurrently for one model runs `lms load` once (fake `run` counting calls).
  - "a runtime with nothing to warm completes at once": the adapter returns `{ warmed: false }` for `claude`.
- [ ] Implement; `npx vitest run apps/node-agent`; commit `feat(node): warm a runtime before its first turn`.

### Task 3: The core wakes a thread

**Files:** `apps/core/src/conversation/service.ts` (`warm(context, command)`: reuse the node/model/root resolution of `sendMessage` (extract it into a shared function first if it is inline), enqueue a `runtime.warm` job with a 60-second lease, record `awakeUntil = now + 10 min` in an in-memory map keyed by thread; `onJobResult` for a failed warm clears it), `apps/core/src/api/http.ts` (command `conversation.warm`; `GET /identities` adds `awakeUntil` per thread), `apps/core/src/nodes/*` (accept the new capability in hello and grants the same way `runtime.turn` is accepted).
**Tests:** `apps/core/src/conversation/conversation.integration.test.ts` (scripted node, as the existing turn tests do)

- [ ] Failing tests:
  - "waking Jester sends a warm job with no prompt, and records no turn".
  - "a wake does not choose the turn's model": wake with the default model, send with another; the turn's job names the other model.
  - "no node, no wake": with Jester's node offline the command fails `unavailable` and `awakeUntil` stays unset.
  - "waking again extends awakeUntil and sends one more job".
- [ ] Implement; `npx vitest run apps/core`; commit `feat(core): wake an agent before the owner sends`.

### Task 4: The page

**Files:** `packages/ui/src/...IntelligenceState` (add `"asleep"`, drawn dimmer and still; check every `switch` over the state), `apps/web/src/conversation/intelligence-state.ts` (`asleep` when idle and `awakeUntil` is past or absent), `apps/web/src/conversation/PromptForm.tsx` (a **Wake** button beside Send while asleep; on the first input while asleep, if the `wakeWhileTyping` setting is on, send `conversation.warm` once), `apps/web/src/conversation/useConversation.ts` (expose `awakeUntil` and `wake()`), Settings registry (`wakeWhileTyping`: boolean, default true, label "Wake an agent as I start typing").
**Tests:** `intelligence-state.test.ts`, `PromptForm.test.ts`, `apps/web/e2e/presence.test.mjs` (one case)

- [ ] Failing tests:
  - "asleep when nothing is running and the wake has lapsed; idle while awake".
  - "one wake per sleep, however much is typed": typing five characters calls `wake` once; after `awakeUntil` passes, typing calls it again.
  - "no automatic wake when the setting is off; the button still wakes".
- [ ] Implement; `npx vitest run apps/web/src packages/ui`; commit `feat(web): wake Jester with a button or by starting to type`.

### Task 5: Record

- [ ] Status log entry with clause table and commands, including the deploy order (core first) and the measured cold-start time before and after (the owner's stopwatch: send to first token from asleep, with and without waking while typing).
- [ ] Commit and push — `docs: record waking an agent`.
