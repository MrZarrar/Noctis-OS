# The owner's list of 2026-10-09: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work through the ten items the owner raised on 2026-10-09:

- the UI, the Vault and the core: fix what is broken, make the core feel alive, add a clock;
- decide and plan the screen mirror, remote wake, identity, the Tauri shell, connectors, and a first selling workflow.

**Architecture:** The list is not one feature. It is nine workstreams, A to I, and their status splits them:

- **Ready to build (A, B, C):** full test-first steps, because nothing in them waits on the owner.
- **Waiting on a decision (D to I):** findings, a recommendation, the decision needed, and a task outline. Each gets its own detailed plan once the owner decides, because the code depends on the answer.

**Tech Stack:** TypeScript monorepo:

- `apps/core`: Node, SQLite.
- `apps/node-agent`.
- `apps/web`: React and Vite PWA, inline style props, no router.
- `packages/ui`: tokens and the Three.js core.
- `packages/domain`.
- Tests: vitest (node environment, no Testing Library) and Playwright e2e under `node --test` (`apps/web/e2e/*.test.mjs`).

## Global Constraints

- Node.js 22.23.2 and the exact package lock. No new dependency without the owner's agreement.
- Write a focused failing test first, then verify red and green (`AGENTS.md`).
- Models may propose semantic intent. Deterministic code owns authority, state, layout, routing, restore and physical window placement.
- Production capabilities are default-off. Get explicit approval before any of these:
  - registering services or scheduled tasks;
  - enabling autostart;
  - connecting new live accounts;
  - external writes (a marketplace listing is one);
  - using metered APIs.
- No destructive Git or filesystem commands. Never modify the live MindVault without the owner's say-so. Reading it is fine.
- Commit only when the owner asks (global `CLAUDE.md`). The commit steps below are where a commit would go, and each waits for that yes.
- Record evidence in `docs/acceptance/IMPLEMENTATION-STATUS.md` before claiming a task done.
- Keep the design language: tokens in `packages/ui/src/tokens/*` and `glass`, `buttonStyle` and `fieldStyle` from `apps/web/src/layout/Page.tsx`. 44 px touch floor.
- Live testing of v1 is deferred by the owner (2026-10-09). Don't block on it.

---

## Findings at a glance

| #   | Owner's item                                      | What is actually going on                                                                                                                                                                                                                                                                                                                                                                                                | Workstream |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Screen mirroring                                  | Nothing captures the screen today. The S4U boot node runs in session 0 and cannot see the desktop. RDP also evicts the console user, and the RDP path still drops each session after about 32 s (`remote-access.md` §9.8)                                                                                                                                                                                                | E          |
| 2   | Vault overloaded, junk nodes, agent brain merged? | **Not the agent brain.** It is one file, `agent/brain.md`, and has been in the Vault since Phase 7. The junk is **8,810 graphify notes** generated from a minified `mermaid.min.js` and filed under `MindVault/projects/jarvis-dashboard/codegraph/` on 14 Aug. They are 84% of entities and 98% of edges. The indexer takes every `.md`, and the 5,000-node read is sorted by key, so `$`/`_` names push real notes out | B          |
| 3a  | Outdated dropdown                                 | Five native `<select>`s. The popup is the OS's white list, because the field's background is 4% white                                                                                                                                                                                                                                                                                                                    | A5         |
| 3b  | Black area when scrolling                         | A screen-reader-only span in each message bubble is `position:absolute` with no positioned ancestor. It stretches the **document**, so the whole shell scrolls up and leaves black underneath                                                                                                                                                                                                                            | A1         |
| 3c  | Buttons scroll away                               | The page header (Conversations, Back) sits inside the scrolling body. Only the composer is sticky                                                                                                                                                                                                                                                                                                                        | A2         |
| 3d  | No back, stuck after Download                     | There is no router and nothing pushes history, so the phone's back gesture has nothing to pop. Download is a same-window `<a>`, and in the iPhone home-screen app that replaces the app with the file                                                                                                                                                                                                                    | A3, A4     |
| 4   | Mini Vesper looks like a static image             | It **is** the live WebGL core, but it is 76 px, masked, and never "listening". At idle the render loop stops by design and the only motion is a CSS breathing animation in an inline `<style>`, which the core's CSP blocks whenever no Gateway is configured. Only one page renders the core at a time, so nothing travels between pages the way the mockups' companion does                                            | A7, C      |
| 5   | Digital clock on Presence                         | Nothing exists. The greeting reads the hour once and goes stale                                                                                                                                                                                                                                                                                                                                                          | A6         |
| 6   | Tauri and Rust vs web dashboard                   | The Tauri 2 shell and `crates/noctis-windows` exist, but they are dormant: never bundled or installed, no TLS (they reach only a loopback core), no Rust toolchain on the work PC, and Smart App Control blocks local builds at home. The phone-first audit and S2 made the core-served PWA the front door                                                                                                               | H          |
| 7   | Adaptive workflows, connectors                    | P10 (tool routing) is partly built in the Tauri shell. P11 adapters have not started. Surfaces now has 11 of 15 kinds. Connector research is in Workstream I                                                                                                                                                                                                                                                             | I          |
| 8   | Photos to Vinted, eBay or Depop                   | eBay has a free official Sell API for individual sellers. Vinted and Depop have no API open to a personal seller: browser only, with real ban risk                                                                                                                                                                                                                                                                       | I          |
| 9   | Does Vesper know it's Vesper?                     | **No.** Claude and Codex turns get no persona. Only Jester (a Hermes `SOUL.md`) has one. The only per-prompt injection is Vault recall, which rarely matches anything                                                                                                                                                                                                                                                    | D          |
| 10  | Waking the home PC                                | Hardware is ready (S3 sleep, wake-armed NIC). The blocker is that nothing on the home LAN can send the magic packet: Tailscale routes IP packets and won't carry the LAN broadcast a magic packet needs                                                                                                                                                                                                                  | F          |

## Order

1. **A: UI fixes.** Small, no decisions, fixes daily pain.
2. **B: Vault.** Small, no decisions. Asks the owner whether to move the codegraph folder out of MindVault.
3. **C: The companion core.** The "alive" Vesper. Medium.
4. **D to I:** each after its decision. Suggested sequence D, E, F, I, H. D and F are cheap once decided. E and I are the largest. H is a strategy call and blocks nothing in v1.

## Decisions the owner needs to make

| Workstream | Question                                                                                                 | Recommendation                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B          | Move `projects/jarvis-dashboard/codegraph/` (8,810 files) out of MindVault, or only hide it from Noctis? | Hide it in code either way (B1). Also move it out: it is clutter in Obsidian and OneDrive too                                                                          |
| B          | Keep the agent brain out of the sphere?                                                                  | Yes (B2). It stays a file agents read, as before                                                                                                                       |
| D          | Who carries a persona?                                                                                   | A short identity card set **once per agent session**, not per prompt, for Vesper on Claude and Codex, plus a Vesper `SOUL.md` on Hermes                                |
| E          | May the mirror install ffmpeg on the home PC and register an at-logon task?                              | Yes. It is the smallest path to 15 to 30 fps                                                                                                                           |
| F          | Which device sends the wake packet?                                                                      | A small always-on box on the home LAN (a Raspberry Pi, about £20) running the Noctis node with a `lan.wake` capability. First check whether the router has remote wake |
| H          | Revive the Tauri shell now?                                                                              | Not before the v1 sign-off. Revive it for focus mode and window placement, with TLS added. The PWA stays the front door                                                |
| I          | First selling target                                                                                     | eBay through its official API, end to end. Vinted as a prepared form that the owner publishes, as in mockup 3                                                          |

### The owner's answers (2026-10-09)

- **B, moving the folder:** yes. The 8,812 files were moved, not deleted, to
  `C:\Users\mushaf.zarrar\Documents\MindVault-archive\jarvis-dashboard\codegraph` (outside OneDrive). The hub note
  `projects/jarvis-dashboard-codegraph.md` stays.
- **D, personas:** the identity card is **on by default** for Claude and Codex as well as Hermes and local.
- **E, the mirror:** yes, on both PCs. The home PC is offline, so every home-PC step goes into
  `docs/operations/HOME-SETUP.md` as it is built, for the owner to run there.
- **F, remote wake:** deferred until the owner is home.
- **I, selling:** start with eBay. Other platforms (Vinted, Depop and the rest) will be done by Hermes as an agent,
  which is the point of an agent harness in Noctis. So I.3 step 6 and I8 are dropped from Noctis code.
- **Execution:** subagent-driven, with no commits until the owner says yes (global `CLAUDE.md`).

---

# A. UI fixes

Files touched across A:

- `apps/web/src/layout/Page.tsx`: the page frame (scroll root and sticky header).
- `apps/web/src/index.css`: document never scrolls; the core's breathing keyframes.
- `apps/web/src/navigation/back.ts` (new): history entries for pages and layers.
- `apps/web/src/App.tsx`, `pages/Threads.tsx`, `pages/Files.tsx`: use `back.ts`.
- `apps/web/src/layout/Picker.tsx` (new): the styled picker that replaces the five `<select>`s.
- `apps/web/src/pages/clock.ts` (new) and `pages/Presence.tsx`: the clock.
- `packages/ui/src/intelligence/IntelligenceRenderer.tsx`: drop the inline `<style>`.
- Tests:
  - `apps/web/e2e/phone.test.mjs`, which already has the helpers `open`, `tabTo`, `waitFor`, `readPage`, `DESKTOP` and `PHONE`;
  - `apps/web/src/navigation/back.test.ts`;
  - `apps/web/src/pages/clock.test.ts`.

### Task A1: The document never scrolls

**Files:**

- Modify: `apps/web/src/layout/Page.tsx`, the `<section>` style at lines 27-41.
- Modify: `apps/web/src/pages/Presence.tsx`, the `<section>` style at lines 78-91.
- Modify: `apps/web/src/index.css`, after the `body` rule.
- Test: `apps/web/e2e/phone.test.mjs`.

- [ ] **Step 1: Write the failing test.** Add it after the "holds its place…" test.

```js
it(
  "never lets the document scroll under a long thread, so no black band opens below",
  { timeout: 120_000 },
  async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(WEB_URL);
    await open("Threads");
    // Each message's spoken label is placed where its bubble is; four long
    // messages put the last one far below the screen.
    for (let index = 0; index < 4; index += 1) {
      await tabTo(page, "Message Vesper");
      await page.keyboard.type(
        `${String(index)} ${"a long line to read back through ".repeat(60)}`,
      );
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.filter((m) => m.startsWith("You")).length > index,
        `message ${String(index)} never showed`,
        30_000,
      );
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    assert.ok(overflow <= 0, `the document scrolls ${String(overflow)}px past the screen`);
  },
);
```

- [ ] **Step 2: Run it and watch it fail.** Run `node --test --test-name-pattern="never lets the document scroll" apps/web/e2e/phone.test.mjs`. Expected: FAIL with "the document scrolls NNNNpx past the screen".

- [ ] **Step 3: Make the scrollers the containing block, and close the document.** In `Page.tsx`, add two keys to the `<section>` style:

```tsx
        // The containing block for anything absolutely placed inside a page
        // (the spoken labels in Threads), so it scrolls with the page instead
        // of stretching the document.
        position: "relative",
        overscrollBehavior: "contain",
```

Add the same `position: "relative"` to Presence's `<section>` style. Then append to `index.css`:

```css
/* The shell is exactly one screen tall and every page scrolls inside it. If the
   document could scroll too, a wheel at the end of a page would carry the whole
   shell up and leave the background showing underneath. */
html,
body {
  height: 100%;
  overflow: hidden;
}
```

- [ ] **Step 4: Run the test and the phone gate.** Run `node --test apps/web/e2e/phone.test.mjs`. Expected: PASS, including "THE GATE: every v1 page fits a phone".

- [ ] **Step 5: Commit, once the owner says yes.** `fix(web): the document never scrolls under a page`.

### Task A2: The page header stays on screen

**Files:**

- Modify: `apps/web/src/layout/Page.tsx`, the `<header>` at lines 54-85.
- Test: `apps/web/e2e/phone.test.mjs`.

- [ ] **Step 1: Write the failing test.**

```js
it(
  "keeps Conversations on screen after reading down a long thread",
  { timeout: 120_000 },
  async () => {
    await page.setViewportSize(PHONE);
    await page.goto(WEB_URL);
    await open("Threads");
    await tabTo(page, "Message Vesper");
    await page.keyboard.type(`${"a long line to read back through ".repeat(120)}`);
    await page.keyboard.press("Enter");
    await waitFor(
      readPage,
      (s) => s.messages.some((m) => m.startsWith("You")),
      "never sent",
      30_000,
    );

    await page.evaluate(() => {
      const list = document.querySelector('ul[aria-label="Conversation"]');
      let box = list;
      while (box !== null && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
      box.scrollTop = box.scrollHeight;
    });

    const button = await page.getByRole("button", { name: "Conversations" }).boundingBox();
    assert.ok(
      button !== null && button.y >= 0 && button.y < 200,
      `Conversations is at ${JSON.stringify(button)}`,
    );
  },
);
```

- [ ] **Step 2: Run it and watch it fail.** Run `node --test --test-name-pattern="keeps Conversations on screen" apps/web/e2e/phone.test.mjs`. Expected: FAIL, because the button's `y` is negative.

- [ ] **Step 3: Make the header sticky, on the page's own background.** Add to the imports in `Page.tsx`: `import { corner, depth, elevation, material, spacing, typography } from "@noctis/ui";`. Then add to the `<header>` style:

```tsx
            // Stays put while the page scrolls, so Back and Conversations are
            // never a long scroll away (owner, 2026-10-09).
            position: "sticky",
            top: -spacing.lg,
            zIndex: elevation.surface,
            marginInline: -spacing.sm,
            padding: `${String(spacing.lg)}px ${String(spacing.sm)}px ${String(spacing.sm)}px`,
            marginTop: -spacing.lg,
            background: `linear-gradient(${depth.floor} 75%, transparent)`,
```

`top: -spacing.lg` with `marginTop: -spacing.lg` cancels the section's top padding, so the header sits flush at the top once stuck.

- [ ] **Step 4: Run the test and the full phone suite.** Run `node --test apps/web/e2e/phone.test.mjs`. Expected: PASS. Take a desktop screenshot and a phone screenshot of Threads mid-scroll for the status log.

- [ ] **Step 5: Commit, once the owner says yes.** `fix(web): page headers stay on screen while the page scrolls`.

### Task A3: Download never strands the phone app

**Files:**

- Modify: `apps/web/src/pages/Files.tsx`, lines 526-539.
- Test: `apps/web/e2e/files.test.mjs`.

- [ ] **Step 1: Write the failing assertion.** Add it to the existing test that opens a file in `files.test.mjs`, after the viewer shows:

```js
const download = page.getByRole("link", { name: "Download" });
// Same-window, an iPhone Home Screen app navigates its only window to the file
// and has no way back; a new browsing context opens Safari's sheet over it.
assert.equal(await download.getAttribute("target"), "_blank");
assert.equal(await download.getAttribute("rel"), "noopener");
```

- [ ] **Step 2: Run it and watch it fail.** Run `node --test apps/web/e2e/files.test.mjs`. Expected: FAIL, because `target` is `null`.

- [ ] **Step 3: Add `target="_blank" rel="noopener"` to the Download `<a>`.**

- [ ] **Step 4: Run it and watch it pass.** Run `node --test apps/web/e2e/files.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit, once the owner says yes.** `fix(web): Download opens over the app instead of replacing it`.

### Task A4: Back works: pages, the conversation list, the file viewer

**Files:**

- Create: `apps/web/src/navigation/back.ts`.
- Create: `apps/web/src/navigation/back.test.ts`.
- Modify: `apps/web/src/App.tsx`, `select` at lines 188-201 plus a new effect.
- Modify: `apps/web/src/pages/Threads.tsx`, `listing` at line 374 and its open and close calls.
- Modify: `apps/web/src/pages/Files.tsx`, `opened` at line 95 and its `setOpened(undefined)` calls.
- Test: `apps/web/e2e/phone.test.mjs`.

**Interfaces:**

- Produces:
  - `HistoryEntry { page: RailItem; layer?: string }`
  - `pushPage(page: RailItem): void`
  - `entryPage(state: unknown): RailItem | undefined`
  - `useBackLayer(layer: string, isOpen: boolean, onBack: () => void): { pushed(): void; dismiss(): void }`

**Design.** Pages push one entry each. A layer (the conversation list, the file viewer, a delegated thread) pushes an entry when it opens.

- Back pops the entry, and the layer closes.
- Closing a layer by hand calls `dismiss()`, which goes back if the layer's entry is on top, so back never needs a second press.
- Nothing is pushed from inside an effect, so StrictMode's double effects can't duplicate entries.

- [ ] **Step 1: Write the failing unit test** for the pure part:

```ts
import { describe, expect, it } from "vitest";

import { entryPage } from "./back.js";

describe("entryPage", () => {
  it("reads the page a history entry was made on", () => {
    expect(entryPage({ page: "Files", layer: "file" })).toBe("Files");
  });

  it("ignores anything that is not one of the app's pages", () => {
    expect(entryPage(null)).toBeUndefined();
    expect(entryPage({ page: "Nowhere" })).toBeUndefined();
    expect(entryPage("Files")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run `npx vitest run apps/web/src/navigation/back.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Write `back.ts`.**

```ts
import { HIDDEN_ITEMS, NAV_ITEMS, type RailItem } from "@noctis/ui";
import { useEffect, useRef } from "react";

/** What one history entry remembers: the page, and the layer open over it, if any. */
export interface HistoryEntry {
  page: RailItem;
  layer?: string;
}

const PAGES: readonly string[] = [...NAV_ITEMS, ...HIDDEN_ITEMS, "Settings"];

export function entryPage(state: unknown): RailItem | undefined {
  const page = (state as { page?: unknown } | null)?.page;
  return typeof page === "string" && PAGES.includes(page) ? (page as RailItem) : undefined;
}

export function pushPage(page: RailItem): void {
  history.pushState({ page } satisfies HistoryEntry, "");
}

/**
 * Lets the phone's back gesture close something opened over a page.
 *
 * Call `pushed()` right after opening it and `dismiss()` instead of closing it
 * by hand. Back closes it through `onBack`.
 */
export function useBackLayer(
  layer: string,
  isOpen: boolean,
  onBack: () => void,
): { pushed(): void; dismiss(): void } {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const onPop = (event: PopStateEvent): void => {
      if ((event.state as HistoryEntry | null)?.layer !== layer) {
        onBackRef.current();
      }
    };
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
    };
  }, [layer, isOpen]);

  return {
    pushed() {
      const page = entryPage(history.state) ?? "Presence";
      history.pushState({ page, layer } satisfies HistoryEntry, "");
    },
    dismiss() {
      if ((history.state as HistoryEntry | null)?.layer === layer) {
        history.back();
      } else {
        onBackRef.current();
      }
    },
  };
}
```

Check that `NAV_ITEMS`, `HIDDEN_ITEMS` and `RailItem` are exported from `@noctis/ui`'s index. If they aren't, export them from `packages/ui/src/index.ts`.

- [ ] **Step 4: Run the unit test and watch it pass.** Run `npx vitest run apps/web/src/navigation/back.test.ts`. Expected: PASS.

- [ ] **Step 5: Wire up pages in `App.tsx`.** In `select`, push before switching:

```tsx
if (item !== active) {
  pushPage(item);
}
setActive(item);
```

Then add an effect next to the other hooks:

```tsx
// The first entry names the page the app opened on; back from any page
// lands on the one before it.
useEffect(() => {
  history.replaceState({ page: "Presence" } satisfies HistoryEntry, "");
  const onPop = (event: PopStateEvent): void => {
    const page = entryPage(event.state);
    if (page !== undefined) {
      setActive(page);
    }
  };
  addEventListener("popstate", onPop);
  return () => {
    removeEventListener("popstate", onPop);
  };
}, []);
```

Also wrap the delegated thread with the same hook:

- `const threadLayer = useBackLayer("thread", openThreadId !== undefined, () => setOpenThreadId(undefined));`
- Call `threadLayer.pushed()` wherever `setOpenThreadId(id)` opens a thread.
- Call `threadLayer.dismiss()` where Threads' "Back" calls `onOpenThread(undefined)`.

- [ ] **Step 6: Wire up the layers.**
  - Threads: `const list = useBackLayer("conversations", listing, () => setListing(false));`
    - The Conversations button calls `setListing(true); list.pushed();`.
    - Every place that closes the list calls `list.dismiss()`.
  - Files: `const viewer = useBackLayer("file", opened !== undefined, () => setOpened(undefined));`
    - Where a file opens, call `viewer.pushed()` after `setOpened(...)`.
    - Replace the `onClose={() => setOpened(undefined)}` handlers at lines 357 and 394 with `viewer.dismiss`.

- [ ] **Step 7: Write the e2e test.**

```js
it(
  "goes back with the phone's back gesture: viewer, then list, then page",
  { timeout: 120_000 },
  async () => {
    await page.setViewportSize(PHONE);
    await page.goto(WEB_URL);
    await open("Threads");
    await tabTo(page, "Conversations");
    await page.keyboard.press("Enter");
    await waitFor(readPage, (s) => s.body.includes("New conversation"), "the list never opened");

    await page.goBack();
    await waitFor(
      readPage,
      (s) => !s.body.includes("New conversation"),
      "back did not close the list",
    );
    assert.equal((await readPage()).heading, "Threads");

    await page.goBack();
    await waitFor(readPage, (s) => s.heading !== "Threads", "back did not leave Threads");
  },
);
```

Add the same pattern to `files.test.mjs`: open a file, `page.goBack()`, and assert the viewer is gone while Files is still the page.

- [ ] **Step 8: Run both suites.** Run `node --test apps/web/e2e/phone.test.mjs apps/web/e2e/files.test.mjs`. Expected: PASS.

- [ ] **Step 9: Commit, once the owner says yes.** `feat(web): the back gesture closes what opened and returns to the last page`.

  Not covered: deep links (the URL stays `/`). Add them when push notifications should open the thread they're about.

### Task A5: One picker in the design language

**Files:**

- Create: `apps/web/src/layout/Picker.tsx`.
- Modify: `apps/web/src/conversation/PromptForm.tsx` at lines 395 and 420, `apps/web/src/pages/Settings.tsx:317`, and `apps/web/src/pages/Nodes.tsx:215`.
- Leave alone: `packages/ui/src/surfaces/SurfaceFrame.tsx:111`, which is native on purpose and sits on a flagged page.
- Test: `apps/web/e2e/phone.test.mjs`, `chat.test.mjs`, and `PromptForm.test.ts` where it inspects the options.

**Interfaces:**

- Produces: `Picker<T extends string>({ label, value, options, onChange, disabled? })`, where `options: ReadonlyArray<{ value: T; label: string; detail?: string; disabled?: boolean }>`.

**Design.** A button that shows the current label and a chevron. It opens a `<dialog>` (the same pattern as the "More" sheet, `App.tsx:419-469`):

- **Phone:** a bottom sheet.
- **Desktop:** anchored under the button: `position: fixed`, placed from `getBoundingClientRect()`.
- **Inside:** a `role="listbox"` of `role="option"` rows in glass, 44 px tall.
  - The selected row shows a check and `aria-selected`.
  - Offline places show a muted "offline" pill instead of "(offline)" in the text.
  - Read-only places show a "read only" pill.
- **Keyboard:** Up and Down move, Enter picks, Escape closes (free from `showModal`).

  The options become rows rather than a native list, so the text that was crammed into `rootLabel()` splits into a label and a `detail` pill.

- [ ] **Step 1: Write the failing test.** Add to `phone.test.mjs`:

```js
it(
  "picks the PC and folder from a sheet in the app's own glass",
  { timeout: 120_000 },
  async () => {
    await page.setViewportSize(PHONE);
    await page.goto(WEB_URL);
    await open("Threads");
    await page.getByRole("button", { name: /PC and folder/ }).click();
    const list = page.getByRole("listbox", { name: "PC and folder" });
    await list.waitFor();
    const background = await list.evaluate(
      (el) => getComputedStyle(el.closest("dialog")).backgroundColor,
    );
    assert.notEqual(background, "rgb(255, 255, 255)");
    await page.getByRole("option").nth(1).click();
    await list.waitFor({ state: "hidden" });
    assert.equal(await page.locator("select").count(), 0, "a native select is still on the page");
  },
);
```

- [ ] **Step 2: Run it and watch it fail.** Run `node --test --test-name-pattern="picks the PC and folder" apps/web/e2e/phone.test.mjs`. Expected: FAIL, because there's no button with that name.

- [ ] **Step 3: Write `Picker.tsx`.**

```tsx
import { corner, depth, material, spacing, typography } from "@noctis/ui";
import { useId, useRef, type KeyboardEvent } from "react";

import { useIsMobile } from "./useIsMobile.js";
import { buttonStyle, fieldStyle, glass } from "./Page.js";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<PickerOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const mobile = useIsMobile();
  const id = useId();
  const current = options.find((option) => option.value === value);

  const show = (): void => {
    const sheet = dialog.current;
    const anchor = button.current?.getBoundingClientRect();
    if (sheet === null || anchor === undefined) return;
    if (!mobile) {
      sheet.style.top = `${String(Math.max(spacing.sm, anchor.top - 8 - Math.min(360, options.length * 48)))}px`;
      sheet.style.left = `${String(anchor.left)}px`;
      sheet.style.width = `${String(anchor.width)}px`;
    }
    sheet.showModal();
    sheet.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus();
  };

  const pick = (next: T): void => {
    onChange(next);
    dialog.current?.close();
    button.current?.focus();
  };

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="option"]:not([aria-disabled="true"])',
      ),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-label={`${label}: ${current?.label ?? ""}`}
        onClick={show}
        style={{
          ...fieldStyle,
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          textAlign: "left",
          cursor: "pointer",
          background: depth.layers[1],
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {current?.label}
        </span>
        <span aria-hidden="true" style={{ color: typography.color.muted }}>
          ⌄
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={id}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current.close();
        }}
        style={{
          ...glass,
          background: depth.layers[1],
          color: typography.color.primary,
          padding: spacing.xs,
          margin: mobile ? "auto 0 0" : 0,
          position: "fixed",
          ...(mobile
            ? {
                width: "100%",
                maxWidth: "100%",
                borderRadius: `${String(corner.xl)}px ${String(corner.xl)}px 0 0`,
              }
            : {}),
          maxHeight: "min(60dvh, 420px)",
          overflowY: "auto",
        }}
      >
        <p
          id={id}
          style={{
            margin: spacing.sm,
            fontSize: typography.scale.xs,
            color: typography.color.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </p>
        <ul
          role="listbox"
          aria-label={label}
          onKeyDown={move}
          style={{ listStyle: "none", margin: 0, padding: 0 }}
        >
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              tabIndex={option.disabled === true ? -1 : 0}
              aria-selected={option.value === value}
              aria-disabled={option.disabled === true}
              onClick={() => {
                if (option.disabled !== true) pick(option.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && option.disabled !== true) pick(option.value);
              }}
              style={{
                ...buttonStyle,
                display: "flex",
                alignItems: "center",
                gap: spacing.sm,
                border: "none",
                background: option.value === value ? material.fillElevated : "transparent",
                opacity: option.disabled === true ? 0.45 : 1,
              }}
            >
              <span style={{ flex: 1 }}>{option.label}</span>
              {option.detail !== undefined && (
                <span
                  style={{
                    fontSize: typography.scale.xs,
                    color: typography.color.muted,
                    border: `1px solid ${material.border}`,
                    borderRadius: corner.sm,
                    padding: "2px 6px",
                  }}
                >
                  {option.detail}
                </span>
              )}
              {option.value === value && <span aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
```

- [ ] **Step 4: Replace the selects.**
  - In `PromptForm.tsx`, build `PickerOption[]` from the same data the `<option>`s use. Replace each `<label style={pickerStyle}>…<select>` with `<Picker label="Agent" …/>` and `<Picker label="PC and folder" …/>`.
  - The empty "Wherever Noctis chooses" option needs a real value: use `"" as const`, and `T` accepts `""`.
  - Split `rootLabel()` into a label (`"Documents on home"`) and a detail (`"offline"` or `"read only"`).
  - Do the same in `Settings.tsx` and `Nodes.tsx`.
  - Where `PromptForm.test.ts` checks option text, check the options array instead.

- [ ] **Step 5: Run the test suites.** Run `npx vitest run apps/web/src` and then `node --test apps/web/e2e/{phone,chat,presence,jester}.test.mjs`. Expected: PASS. Take phone and desktop screenshots of the open sheet for the owner.

- [ ] **Step 6: Commit, once the owner says yes.** `feat(web): pickers in the app's own glass instead of the OS list`.

### Task A6: A digital clock on Presence, and a greeting that keeps time

**Files:**

- Create: `apps/web/src/pages/clock.ts` and `apps/web/src/pages/clock.test.ts`.
- Modify: `apps/web/src/pages/Presence.tsx`, lines 65-66 and the top of the section at line 104.
- Test: `apps/web/e2e/presence.test.mjs`.

**Interfaces:**

- Produces:
  - `clockText(date: Date): { time: string; day: string }`
  - `greetingFor(date: Date): string`
  - `msToNextMinute(date: Date): number`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";

import { clockText, greetingFor, msToNextMinute } from "./clock.js";

const at = (iso: string): Date => new Date(iso);

describe("the Presence clock", () => {
  it("shows 24-hour time and the day, the way the owner reads them in the UK", () => {
    expect(clockText(new Date(2026, 9, 9, 7, 5))).toEqual({
      time: "07:05",
      day: "Friday 9 October",
    });
  });

  it("greets by the hour it is now, not the hour the page opened", () => {
    expect(greetingFor(new Date(2026, 9, 9, 11, 59))).toBe("Good morning.");
    expect(greetingFor(new Date(2026, 9, 9, 12, 0))).toBe("Good afternoon.");
    expect(greetingFor(new Date(2026, 9, 9, 18, 0))).toBe("Good evening.");
  });

  it("ticks on the minute, not a second late", () => {
    expect(msToNextMinute(at("2026-10-09T07:05:59.250Z"))).toBe(750);
    expect(msToNextMinute(at("2026-10-09T07:06:00.000Z"))).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run `npx vitest run apps/web/src/pages/clock.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Write `clock.ts`.**

```ts
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function clockText(date: Date): { time: string; day: string } {
  return { time: TIME.format(date), day: DAY.format(date).replace(",", "") };
}

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  return hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
}

export function msToNextMinute(date: Date): number {
  return 60_000 - (date.getTime() % 60_000);
}
```

- [ ] **Step 4: Run it and watch it pass.** Run `npx vitest run apps/web/src/pages/clock.test.ts`. Expected: PASS.

- [ ] **Step 5: Use it in Presence.** Replace lines 65-66 with a minute-aligned tick:

```tsx
const [now, setNow] = useState(() => new Date());
useEffect(() => {
  let timer = window.setTimeout(function tick() {
    setNow(new Date());
    timer = window.setTimeout(tick, msToNextMinute(new Date()));
  }, msToNextMinute(new Date()));
  return () => {
    window.clearTimeout(timer);
  };
}, []);
const greeting = greetingFor(now);
const clock = clockText(now);
```

Make the top of the section a row. The Jester marker goes on the left, when it shows. The clock goes on the right on desktop and centred on the phone:

```tsx
<div
  style={{
    alignSelf: "stretch",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: mobile ? "center" : "space-between",
  }}
>
  {/* the existing JESTER · ACTIVE <p>, unchanged, moved in here */}
  <time
    dateTime={now.toISOString()}
    aria-label={`${clock.time}, ${clock.day}`}
    style={{
      display: "grid",
      justifyItems: mobile ? "center" : "end",
      marginLeft: "auto",
      marginRight: mobile ? "auto" : 0,
    }}
  >
    <span
      style={{
        font: `200 ${String(mobile ? 40 : 56)}px/1 ${typography.family}`,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
        color: typography.color.primary,
      }}
    >
      {clock.time}
    </span>
    <span
      style={{
        fontSize: typography.scale.sm,
        color: typography.color.muted,
        letterSpacing: "0.08em",
      }}
    >
      {clock.day}
    </span>
  </time>
</div>
```

- [ ] **Step 6: Add an e2e assertion and run the suites.** Add to the Presence gate in `presence.test.mjs`: `assert.match(await page.locator("time").first().innerText(), /^\d{2}:\d{2}/);`. Then run `node --test apps/web/e2e/{presence,phone}.test.mjs`. Expected: PASS, with the phone gate still clean.

- [ ] **Step 7: Commit, once the owner says yes.** `feat(web): a clock on Presence, and a greeting that keeps time`.

### Task A7: The idle core breathes under any CSP

**Files:**

- Modify: `packages/ui/src/intelligence/IntelligenceRenderer.tsx`, lines 907-918, to delete the `<style>` block.
- Modify: `apps/web/src/index.css`, to append the keyframes and rule there.
- Test: `apps/core/src/api/static.test.ts` (existing CSP tests) and `apps/web/e2e/presence.test.mjs`.

- [ ] **Step 1: Write the failing test.** In `presence.test.mjs`, with the page idle:

```js
const animation = await page.evaluate(
  () => getComputedStyle(document.querySelector(".noctis-intelligence > canvas")).animationName,
);
assert.equal(animation, "noctis-core-breathe");
```

The e2e web server runs with the production CSP from the core (`default-src 'self'`, no Gateways). If the harness serves through Vite instead, add the same assertion to `tokenless.test.mjs` or whichever suite serves the core's CSP. The inline `<style>` is refused there.

- [ ] **Step 2: Run it and watch it fail.** Expected: FAIL, because `animationName` is `"none"` under the core's CSP.

- [ ] **Step 3: Move the rule into `index.css`.**

```css
/* The idle core's only motion. Here rather than in the renderer, because the
   core's CSP has no 'unsafe-inline' and refused it as an inline <style>. */
@keyframes noctis-core-breathe {
  0%,
  100% {
    transform: scale(0.99) rotate(-0.6deg);
  }
  50% {
    transform: scale(1.015) rotate(0.6deg);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .noctis-intelligence[data-core-state="idle"][data-core-visible="true"] > canvas {
    will-change: transform;
    animation: noctis-core-breathe 7s ease-in-out infinite;
  }
}
```

Then delete the `<style>` element from `IntelligenceRenderer.tsx`.

- [ ] **Step 4: Run the suites.** Run `node --test apps/web/e2e/presence.test.mjs` and `npx vitest run packages/ui/src/intelligence`. Expected: PASS.

- [ ] **Step 5: Commit, once the owner says yes.** `fix(ui): the idle core breathes under the core's own CSP`.

---

# B. Vault: the second brain without the junk

Root cause: 8,810 graphify notes inside MindVault. The fix is in Noctis (B1, B2). Moving the folder out of the Vault is the owner's own housekeeping, and Noctis must not do it. The layout and renderer changes only happen if the cleaned graph still looks wrong (B3).

### Task B1: The indexer skips generated notes

**Files:**

- Modify: `packages/domain/src/vault/markdown.ts`, adding `isGeneratedNote`.
- Modify: `apps/core/src/vault/indexer.ts`, `scan()` around line 105.
- Test: `packages/domain/src/vault/markdown.test.ts` and `apps/core/src/vault/vault.integration.test.ts`.

**Interfaces:**

- Produces: `isGeneratedNote(note: ParsedNote): boolean`, exported from `@noctis/domain`.

- [ ] **Step 1: Write the failing unit test** in `markdown.test.ts`:

```ts
describe("isGeneratedNote", () => {
  it("knows a graphify code-graph note by its tags, block list or inline", () => {
    const block = parseNote(
      '---\nsource_file: "wiki/mermaid.min.js"\ntype: "code"\ntags:\n  - graphify/code\n  - community/G0\n---\n\n# $$t()\n',
    );
    const inline = parseNote("---\ntags: [graphify/EXTRACTED]\n---\n# x\n");
    expect(isGeneratedNote(block)).toBe(true);
    expect(isGeneratedNote(inline)).toBe(true);
  });

  it("leaves the owner's own notes alone, even ones that mention graphify", () => {
    expect(
      isGeneratedNote(
        parseNote("---\ntags: [projects]\n---\n# Graphify notes\n\nTried graphify/code today.\n"),
      ),
    ).toBe(false);
    expect(isGeneratedNote(parseNote("# No frontmatter\n"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run `npx vitest run packages/domain/src/vault/markdown.test.ts`. Expected: FAIL, because `isGeneratedNote` isn't exported.

- [ ] **Step 3: Implement it** in `markdown.ts`:

```ts
/** A graphify tag in the frontmatter, in a block list or an inline list. */
const GENERATED_TAG = /(^|[\s[,])graphify\//m;

/**
 * Notes a tool wrote about code, not notes the owner wrote. graphify drops
 * thousands of them into a Vault at once, and they drown the second brain.
 * Only the frontmatter is read, so prose that mentions graphify is kept.
 */
export function isGeneratedNote(note: ParsedNote): boolean {
  return note.frontmatter !== undefined && GENERATED_TAG.test(note.frontmatter.raw);
}
```

Export it alongside `parseNote` from the package index.

- [ ] **Step 4: Run it and watch it pass.** Run `npx vitest run packages/domain/src/vault/markdown.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing integration test** in `vault.integration.test.ts`, inside "indexing a test Vault":

```ts
it("THE GATE: leaves generated code-graph notes out, and drops ones indexed before", () => {
  const kernel = makeKernel();
  const root = vaultRoot();
  const generated = join(root.path, "projects/demo/codegraph");
  mkdirSync(generated, { recursive: true });
  const note = join(generated, "$$t().md");

  // First as an ordinary note, so it is indexed the way the live Vault's were.
  writeFileSync(note, "# $$t()\n\n## Connections\n- [[_0n()]]\n");
  indexVault(kernel, context, root, key());

  writeFileSync(
    note,
    '---\ntype: "code"\ntags:\n  - graphify/code\n---\n\n# $$t()\n\n## Connections\n- [[_0n()]]\n',
  );
  const after = indexVault(kernel, context, root, key());
  expect(after.ok).toBe(true);
  const rows = kernel.db
    .prepare(`SELECT COUNT(*) AS n FROM vault_items WHERE path LIKE 'projects/demo/codegraph/%'`)
    .get() as { n: number };
  expect(rows.n).toBe(0);
  expect(
    kernel.db.prepare(`SELECT id FROM vault_entities WHERE name = '_0n()'`).get(),
  ).toBeUndefined();
});
```

Add `mkdirSync` to the `node:fs` import.

- [ ] **Step 6: Run it and watch it fail.** Run `npx vitest run apps/core/src/vault/vault.integration.test.ts`. Expected: FAIL, with 1 row.

- [ ] **Step 7: Skip generated notes in `scan()`.** After `const raw = readFileSync(resolved); const text = raw.toString("utf8");` parse once and skip:

```ts
const note = parseNote(text);

if (isGeneratedNote(note)) {
  continue;
}
```

Then use `note` in the pushed object in place of `parseNote(text)`. Already-indexed generated notes fall out through the existing deleted-note path (`indexer.ts:366-376`), because they are no longer scanned.

- [ ] **Step 8: Run the vault suites.** Run `npx vitest run apps/core/src/vault packages/domain/src/vault`. Expected: PASS, including "repeated indexing is stable".

- [ ] **Step 9: Check the live Vault (read-only) on the work PC.**
  - Reindex the work PC's core from the Vault page, after a deploy and with the owner's go-ahead to deploy.
  - Expected from the core DB: about 171 items, no `projects/jarvis-dashboard/codegraph/` rows, and edges in the hundreds rather than about 59k.
  - Take a phone screenshot and a desktop screenshot of the sphere for the status log.

- [ ] **Step 10: Commit, once the owner says yes.** `fix(vault): generated code-graph notes stay out of the second brain`.

### Task B2: The agent brain stays out of the sphere

**Files:**

- Modify: `apps/core/src/api/http.ts`, `readGraph` at lines 700-739.
- Test: `apps/core/src/api/headless.integration.test.ts`, near line 867.

- [ ] **Step 1: Write the failing test.**
  - The test fixture must contain an `agent/` note. If `TEST_VAULT_FILES` in `packages/test-kit` has none, add `"agent/brain.md": "# Agent Brain\n\n- prefers short replies\n"`.

```ts
it("leaves the agents' own brain out of the owner's sphere", async () => {
  const graph = await read(await indexedCore(), "/vault/graph");
  const nodes = graph.body.nodes as Array<{ type: string }>;

  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes.filter((node) => node.type === "agent")).toHaveLength(0);
  expect(graph.body.total).toBe(nodes.length);
});
```

- [ ] **Step 2: Run it and watch it fail.** Run `npx vitest run apps/core/src/api/headless.integration.test.ts -t "agents' own brain"`. Expected: FAIL, because one `agent` node is returned.

- [ ] **Step 3: Filter `agent` entities out of both queries** in `readGraph`:
  - Count: `SELECT COUNT(*) AS count FROM vault_entities WHERE type <> 'agent'`.
  - Nodes: add `WHERE e.type <> 'agent'` before `ORDER BY e.key`.
  - Comment the filter: "The brain is the agents' shared notes, read by agents; the sphere is the owner's second brain (owner, 2026-10-09)."
  - Edges to it drop automatically, because of the `kept` filter.

- [ ] **Step 4: Run the graph tests.** Run `npx vitest run apps/core/src/api/headless.integration.test.ts -t "graph"`. Expected: PASS.

- [ ] **Step 5: Commit, once the owner says yes.** `fix(vault): the agent brain is the agents', not the sphere's`.

### Task B3 (only if needed): Light budget and spread

Go through this only if the cleaned graph screenshot from B1 step 9 still looks blown out or clustered. At about 200 nodes the additive halos and rays should already be calm. They washed out because there were about 5,000.

- **Light:** in `VaultSphere.tsx`, scale the per-node additive terms by `budget = Math.min(1, 300 / nodeCount)`:
  - halo colour multiplier at `:736` becomes `1.35 * budget`;
  - ray opacity `0.09` at `:512` becomes `0.09 * budget`;
  - pulse opacity `0.5` becomes `0.5 * budget`.
  - Test: a `sphere.ts` pure function `lightBudget(n)` with cases 100 → 1, 3000 → 0.1.
- **Spread:** in `packages/domain/src/vault/layout.ts`, widen a type's cap with its population: `spread = Math.min(Math.PI / 2, (Math.PI / 5) * Math.sqrt(Math.max(1, count / 150)))`. Pass `count` into `seedCoordinate`, and bump `LAYOUT_VERSION` to 2 so persisted coordinates are recomputed.
  - Test: `layout.test.ts`, where 2,000 seeded nodes of one type keep at least `SEPARATION` mean nearest-neighbour distance.

---

# C. The companion core: Vesper feels alive

**Problem:** the mockups have one core that lives across the whole interface:

- On Presence it is the large hero.
- Once work appears it shrinks and docks into the free corner next to the work (bottom-left beside the rail in Active Canvas, bottom-right over native work in Focus).
- It always carries a one-line "Vesper:" caption.

Today the core exists only on Presence and as a 76 px orb in the Threads composer, and every page switch builds and destroys a WebGL context. Nothing moves between places, so it reads as a sticker.

**Design (deterministic layout, per `AGENTS.md`):**

- **One renderer for the whole app.** Mount `CompanionCore` once in `App.tsx`, outside `<main>`, `position: fixed`. It owns the only WebGL context, and is given `identityId`, the **global** intelligence state (from the shared `conversation` and approvals in `App`) and a `dock`.
- **Dock is a pure function of the page:** `dockFor(page, isMobile): Dock`, where `Dock = { anchor: "hero" | "bottom-left" | "bottom-right" | "composer"; size: number }`.
  - Presence: hero, measured from a placeholder `<div data-core-slot>` that Presence still renders, so its layout is unchanged.
  - Threads: the composer slot (still in the composer).
  - Files, Nodes, Approvals: bottom-right, 96 px.
  - Vault: hidden. The Vault has its own core at the sphere's centre.
- **Moving between docks.** The fixed element reads the target slot's `getBoundingClientRect()` and animates `transform` and size with `motion.slow` and `easing.standard`, so going from Presence to Threads visibly flies the core down into the composer. Reduced motion jumps instead.
- **Caption.** A one-line "Vesper: …" beside a docked core:
  - while a turn runs, the newest status line (`last-exchange.ts` already derives it);
  - while waiting, the approval summary;
  - otherwise nothing.
- **Listening** comes from any focused composer, not just Presence's.
- **Budgets stay** (master plan §6): no rAF while idle, IntersectionObserver pause, reduced-motion static. A measured frame-rate check on the phone goes in the status log.

**Tasks:**

1. **C1 `dockFor` and `Dock`:**
   - **Create:** `apps/web/src/companion/dock.ts` and `dock.test.ts`.
   - **Test cases:** the table above, plus "a page with no slot never hides the core during an approval" (approval forces it visible bottom-right, even on Vault).
2. **C2 `CompanionCore`:**
   - **Create:** `apps/web/src/companion/CompanionCore.tsx`.
   - **Behaviour:**
     - It wraps `IntelligenceRenderer` in a fixed box.
     - It finds `[data-core-slot]` in the active page (a `ResizeObserver` plus a `resize` listener) and falls back to the corner dock.
     - It animates with `transform`.
     - It shows the caption.
3. **C3 Rewire the pages:**
   - **Presence:** keeps its core box but renders an empty `<div data-core-slot="hero">`.
   - **Threads:** the composer `aside` becomes `<div data-core-slot="composer" style={{ width: 76, height: 76 }} />`.
   - **Context:** only `App.tsx` mounts the renderer.
   - **Tests:** the existing e2e gates on `[data-core-state]` must hold. They now find one element app-wide.
4. **C4 E2E gate:**
   - **Flight:** "THE GATE (companion): one core follows the owner from Presence into Threads and to a corner on Files, showing the turn's state on each". Assert:
     - one `.noctis-intelligence` in the DOM throughout;
     - its bounding box moves between pages;
     - `data-core-state` is `thinking` on Files while a slow turn runs.
   - **Size:** add a phone-size run.
5. **C5 Evidence:**
   - **Owner review:** a screen recording of the flight on desktop and phone for the owner to approve, the same way S6 was approved.
   - **Measured:** frame rate on the phone.

This has a measurable gain on top of the look: one WebGL context for the app's lifetime instead of one per page visit.

---

# D. Identity: does Vesper know it is Vesper?

**Findings** (file references from the investigation):

- The turn frame carries `identityId` (`packages/contracts/src/runtime.ts:90`). No runtime reads it except Hermes.
- **Claude** (`apps/node-agent/src/runtimes/claude.ts:545-593`) has no `systemPrompt` option. It loads the owner's own setup (`settingSources`), so it believes it is Claude Code.
- **Codex** (`codex.ts:826-867`) gets no `developer_instructions` or `base_instructions`.
- **Hermes:** Jester's `SOUL.md` is written into Jester's own Hermes home when the process opens (`hermes.ts:213-223`), not on every prompt. Vesper's Hermes has no soul.
- **Local** (`local.ts:40-42`) has a generic system prompt.
- **Per-prompt injection today:** only Vault recall (`apps/core/src/conversation/recall-context.ts`): up to 6 quotes, with a `LIKE` over the whole prompt, which rarely matches a long prompt.
- **The master plan:** §6 asks for per-identity system prompts. That part is unmet for Vesper.

**The owner's worry, answered:** persona text does not have to ride on every prompt.

- Claude's Agent SDK takes `systemPrompt: { type: "preset", preset: "claude_code", append }` once per session.
- S1 keeps one process per thread, so it is sent once, prompt-cached by the provider, and adds no latency to follow-ups.
- Codex takes `developer_instructions` once at `thread/start` and `thread/resume`.
- Hermes reads `SOUL.md` once per process.

**Recommendation:**

1. **An identity card per identity:** 80 to 150 words, in `packages/contracts/src/identity-cards.ts`. It says who they are inside Noctis, that the owner reaches them from the phone, that consequential steps go through approvals, and the tone.
2. **Applied once per session:**
   - Claude: `append`.
   - Codex: `developer_instructions`.
   - Hermes and Vesper: a Vesper `SOUL.md`, the same mechanism as Jester's.
   - `local`: the card replaces the generic system prompt.
3. **The underlying model stays honest:** the card says "you are running on <model> through Noctis", so the master plan's "the selected runtime/model is truthful" holds.
4. **Behind a setting** ("Agents speak as Vesper"), on by default for Hermes and local, and the owner's choice for Claude and Codex. With it off, Claude and Codex stay plain workers, which is how they are used for code.
5. **Fix or drop per-prompt recall:** either match on keywords pulled from the prompt rather than the whole string, or move recall to a tool the agent calls (`noctis_recall`). The second means nothing is injected per prompt.

**Decision:** the owner picks 4's default, and whether 5 becomes a tool.

**Tasks once decided:**

- **D1:** add the identity cards.
- **D2:** Claude `append` (test: the `query()` options contain the card when `identityId` is vesper and the setting is on, and not otherwise).
- **D3:** Codex `developer_instructions` (test on the `thread/start` params).
- **D4:** a Vesper `SOUL.md` on Hermes (a test like Jester's).
- **D5:** recall as a tool or with keyword matching.
- **D6:** the Settings toggle.
- **Live check:** ask "who are you and what can you do here?" on each runtime.

---

# E. Screen mirroring (view-only, any device, no login)

**Why not RDP:** on Windows client editions RDP evicts the console user and locks the physical screen. The current path also logs off after about 32 s (unresolved, `remote-access.md` §9.8). A mirror shows the console desktop as it is, and nobody logs in or out.

**Constraints found:**

- The boot node runs as an S4U task in **session 0**, which cannot capture the interactive desktop. Capture has to run in the signed-in user's session.
- A locked screen and UAC's secure desktop can't be captured from user mode. The mirror says "PC is locked" rather than showing black.
- No capture code exists. `crates/noctis-windows` has no DXGI.
- Smart App Control on the home PC blocks unsigned local builds, but it let LM Studio and Hermes run. ffmpeg's widely distributed builds have reputation, which a custom Rust helper wouldn't.

**Design:**

1. **A capture helper in the user's session:**
   - **What:** a Node script shipped with the node agent (`apps/node-agent/src/screen/helper.ts`), started by an **at-logon** scheduled task with an interactive logon type (needs approval, per `AGENTS.md`). On the work PC the node already runs in-session, so it can spawn the helper directly.
   - **Endpoint:** the helper listens on `127.0.0.1` only, behind a random token file readable only by the owner. One endpoint, `GET /mirror?fps=&width=`, which spawns ffmpeg for that request only:
     ```
     ffmpeg -f gdigrab -framerate 30 -i desktop -vf scale=1280:-2 -q:v 7 -f mpjpeg -
     ```
     It kills ffmpeg when the request closes, so nothing captures while nobody watches. `ddagrab` (Desktop Duplication) can replace `gdigrab` for lower CPU later.
2. **A node capability, `screen.view`:**
   - read_inspect class, covered by a new grant that is default-off, granted per PC in Settings.
   - The core opens a job the way `file.read` does. The node pulls the helper's stream and pushes it through the existing long streaming `POST` path (`apps/node-agent/src/agent.ts:205-226` and `apps/core/src/files/gateway.ts`), and the core relays it to the browser.
3. **The browser:**
   - Endpoint: `GET /screen/live?node=…` on the cookie session returns `multipart/x-mixed-replace; boundary=…`.
   - Player: an `<img>` plays it natively on every browser, the iPhone included. It needs no WASM, no CSP widening and no client library.
   - Location: a new **Mirror** tab beside Remote desktop on the Nodes page, with fps (15 or 30) and quality presets and fullscreen.
4. **Bandwidth:** 1280 px JPEG at quality 7 is about 60 to 90 KB a frame, so roughly 15 to 20 Mbit/s at 30 fps. The default is 15 fps at 1280, with 30 fps as an option. The ceiling and the upgrade path is H.264 in fragmented MP4 over Media Source Extensions (MSE), a bigger job, done only if mobile data makes MJPEG hurt. Mark it `ponytail:` in the code.

**Decisions:**

- Install ffmpeg on the home PC (`winget install Gyan.FFmpeg`) and the work PC.
- Register the at-logon task.
- Turn on `screen.view` for each PC.

**Tasks once decided** (each test first):

- **E1:** the `screen.view` contract and grant (test: refused without the grant).
- **E2:** the helper.
  - Unit: argument building, loopback-only bind, token check, and ffmpeg killed when the client goes.
  - Real run: integration on the work PC with a short real capture, recording measured fps and CPU.
- **E3:** the node to core relay (test: an agent integration test with a fake helper that emits 3 JPEG frames, which arrive in order at the browser response).
- **E4:** the web Mirror tab (e2e: frames from the fake render in the `<img>`; the locked state shows text).
- **E5:** `home-node.ps1` registers the at-logon task, only with an explicit `-EnableMirror` flag.
- **E6:** a live run on both PCs from the phone, with fps, latency, CPU and bandwidth recorded.

---

# F. Waking the home PC remotely

**Findings** (`docs/operations/WOL.md`):

- **Ready:** S3 sleep, the Realtek NIC armed for wake (MAC `30-C5-99-59-9A-DA`, `192.168.1.163`), and Fast Startup on.
- **Missing:** a sender. A magic packet is a broadcast on the home LAN. Tailscale only carries routed IP traffic, and the only other devices on the LAN are the router and a phone.
- **Not yet checked:**
  - the UEFI "Power On By PCI-E" setting, needed to wake from shutdown (S5);
  - something that wakes the PC about 2 s after it sleeps, which needs fixing first or every test is noise.

**Options, cheapest first:**

1. **The router's own WoL.** Free if the ISP router has a remote-reachable wake page. The owner checks the model and its admin page.
2. **A Raspberry Pi Zero 2 W or similar on the home LAN (about £20, a purchase the owner decides on):**
   - It runs Tailscale and **the Noctis node agent** with one new capability, `lan.wake`, so no new service type is needed.
   - The packet is about 10 lines of `node:dgram`: 6 × `0xFF` then the MAC 16 times, broadcast to UDP port 9.
   - The core sees the Pi as a node, and wake becomes a normal job with an approval-free grant.
3. **A smart plug plus BIOS "restore on AC power loss":** this works from a full shutdown, but it is a hard power cut. Only as a fallback.

**Recommendation:** check 1 first, then 2.

**Tasks once a sender exists:**

- **F1:** the `lan.wake` contract and a `magicPacket(mac)` pure function. Test: 102 bytes, and the pattern is right.
- **F2:** the node's `lan.wake` handler, which sends the broadcast. Test: against a local UDP socket.
- **F3:** a core command `node.wake { nodeId }`, which picks a connected node with `lan.wake` and the target's MAC (stored on the node record from its last hello).
  - Track four separate states: wake requested, reachable, worker authenticated, desktop ready.
  - Time out at 120 s against "worker authenticated".
- **F4:** the Nodes page: a **Wake** button on an offline PC, which shows each of those states as it happens.
- **F5:** live, from the phone, from sleep and then from shutdown, with timings recorded.

---

# G. Testing deferred

As the owner directed on 2026-10-09, the v1 live checks stay open:

- from the phone after the latest deploy;
- S4 files on the home PC;
- a cold reboot;
- the §7 sign-off.

The full sweep (`npx vitest run`, `npm run test:e2e`) runs once A and B land, before the next deploy.

---

# H. Tauri and Rust: where the native app went

**What happened.** The master plan made the Tauri 2 shell the primary client.

- **The shell:** tray, Ctrl+Alt+N, `noctis://` links, a token proxy held in Rust, window restore.
- **`crates/noctis-windows`:** focus mode and placing VS Code or an emulator.
- **Both were built:** P4 finished, and P9 closed on the owner's judgement on 2026-09-10.

Then three things moved the front door to the PWA served by the core:

1. **The 2026-09-12 audit:** execution had to live on the node, because a phone can't drive a desktop shell.
2. **S2 (ADR-0028, cookie session plus SSE):** the phone became the main client.
3. **Practical blockers:**
   - the shell has no TLS, so it reaches only a loopback core;
   - no Rust toolchain on the work PC;
   - Smart App Control blocks local builds at home;
   - no installer.

**State today:** the shell compiles in CI (`.github/workflows/verify.yml`, `rust` job) and is used nowhere. The last desktop commit is `5e15c1c` (2026-09-22). Both clients render the same `apps/web`.

**Recommendation:** keep one UI (`apps/web`) and give the native shell back the jobs only native code can do:

- focus mode and window placement: the mockups' "Focus" screen;
- the companion core floating over native apps;
- a global shortcut and tray.

**Revival tasks**, for after v1 sign-off or when the owner wants focus mode:

- **H1:** a TLS backend for the Rust client (`reqwest` with `rustls-tls`) so the shell talks to the Tailscale core. Test: the existing proxy tests against an HTTPS fixture.
- **H2:** a signed or reputation-friendly bundle (an MSI from CI as an artifact). The owner decides on code signing.
- **H3:** the shell loads the core-served PWA, so there is one deploy path.
- **H4:** a transparent always-on-top companion core window for Focus, driven by the same `dockFor` logic as C.
- **H5:** install the Rust 1.98.0 toolchain on the work PC, with the owner's approval.

---

# I. Connectors, adaptive workflows, and the first selling workflow

## I.1 What each platform allows (researched 2026-10-09)

| Platform           | Route                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **eBay (EBAY_GB)** | **Official Sell APIs, free, self-serve**                                                       | Listing calls: OAuth authorization-code grant, Inventory API (`createOrReplaceInventoryItem` → `createOffer` → `publishOffer`). Supporting APIs: Media API `createImageFromFile` for photos, Taxonomy `getCategorySuggestions`, and Message and Fulfillment APIs for buyers and orders. Setup needs:<ul><li>business policies (payment, fulfillment and return), each offer referencing all three, through the Account API opt-in</li><li>production keys, active only after subscribing to account-deletion notifications or the opt-out (allowed when no eBay user data is stored)</li></ul>The sandbox has a known business-policy opt-in catch-22 |
| **Vinted**         | No API for a personal seller                                                                   | Pro Integrations are allowlisted for luxury and designer Pro sellers only. Automation breaks the terms, and people report sudden bans. Use **a form prepared in the owner's own browser, published by the owner** (mockup `noctis-vinted-03`)                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Depop**          | No API in practice                                                                             | The Selling API is private and partner-gated (by email). Same route as Vinted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Gmail**          | Google's official Gmail MCP (developer preview, read and draft only, no send) or the Gmail API | The owner's own Google Cloud project in Testing mode: an "unverified app" warning, and refresh tokens expire every 7 days. Send would need verification of restricted scopes                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **YouTube**        | Data API v3                                                                                    | `videos.insert` has its own bucket of 100 calls a day since June 2026. The docs conflict on whether uploads from unverified projects are locked private. Check with one test upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **TikTok**         | Content Posting API, **upload to drafts**                                                      | Public direct posting needs an audit that personal tools can't pass. Unaudited apps post private only. Drafts land in the TikTok inbox, and the owner posts from the app                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## I.2 How connectors fit Noctis

The master plan already defines the shape (P10 and P11, §12.3):

- **Generic surfaces with thin adapters:** no one-off dashboards. Adapters hold no coordinates, authority or provider choice.
- **Hard stop before acting:** stop before every send, publish or spend.
- **P10's tool registry:** a tool is a row (official API or CLI, isolated browser, visible handoff, manual), not new code. It currently lives in the dormant Tauri shell (`tool_registry.rs`).

**Recommended route:**

1. **Move the tool registry onto the core and node.** The phone has to be able to start a workflow, which is the same reason execution moved.
2. **Three connector kinds, chosen per platform:**
   - **Official API with tokens Noctis holds** (eBay, YouTube, TikTok drafts): deterministic, auditable, and every write is an authority request.
   - **Official or locally run MCP servers attached to the agents' runtimes** (Gmail): read and draft freely, and any send goes through approval.
   - **Visible browser handoff** (Vinted, Depop): the agent fills the real form in the owner's logged-in browser on a node, and the owner presses Publish. No unattended loops, no bumping.
3. **Tokens live on the core's machine,** encrypted to the Windows account with DPAPI, the same pattern as `core-token.dpapi`. They never go into prompts.
4. **Every adapter is default-off** behind its own setting, and every external write is a confirm-level authority request.

## I.3 The first workflow: "photos in, listing out"

**Target:** eBay end to end (official API), with Vinted's prepared form as the second step.

**The flow:**

1. **The owner attaches 1 to 8 photos** in Threads on the phone and says "sell this". The Attach control and turn attachments already exist.
2. **Claude drafts the listing** through a new structured tool `noctis_propose_listing`:
   ```
   { title (≤80), description, categoryHint, condition, brand?, size?, colour?,
     priceGBP, priceRationale, photoOrder }
   ```
   It looks at the images and, optionally, uses the eBay Browse API for asking prices of comparable live listings, since sold-price data is restricted.
3. **The core stores a Listing draft** (new table `listing_drafts`, migration 0014) with the photos as attachments, and shows a **Listing surface** on the phone (mockup `noctis-vinted-02`):
   - editable fields, photo strip and price rationale;
   - targets: eBay, and Vinted (prepared).
4. **Publish to eBay = one approval card,** then the adapter in `apps/core/src/adapters/ebay/`:
   - `getCategorySuggestions`;
   - `createImageFromFile` for each photo;
   - `createOrReplaceInventoryItem` (SKU = draft id);
   - `createOffer` (with the owner's three business policy ids from Settings);
   - `publishOffer`.
5. **Listing reference:** shows `listingId`, the eBay URL, and status read back from `getOffer` as a source observation with its freshness ("Live on eBay · checked just now"), as in mockup `noctis-vinted-04`.
6. **Vinted (second):** "Prepare on Vinted". A visible handoff opens `vinted.co.uk/items/new` in the owner's browser on the home PC, with the agent filling the fields and attaching photos. The owner publishes.

**Prerequisites (owner):**

- an eBay developer account and production keyset;
- marketplace account deletion: choose the opt-out (no eBay user data stored);
- a RuName with the accept URL set to the core's Tailscale address `/oauth/ebay/callback`;
- business policies created once in Seller Hub;
- approval for the first real external write.

**Tasks** (each test first; eBay calls tested against recorded fixtures, with no live calls in the tests):

- **I1:** the `ListingDraft` contract and `noctis_propose_listing` tool, validated with `.strict()` and no free-form geometry. Test: a malformed proposal is refused with a reason.
- **I2:** migration 0014 and the draft service: create, edit and attach photos. Test: an integration round trip.
- **I3:** the Listing surface in `apps/web` (e2e: the photo strip reorders, fields edit, Publish asks for approval).
- **I4:** eBay OAuth: authorize URL, callback, refresh, storage with DPAPI. Test: state mismatch refused, refresh on expiry.
- **I5:** the eBay adapter's publish pipeline. Test: with a fake HTTP server replaying eBay's documented responses, including a failed `publishOffer` that leaves a resumable offer rather than a duplicate.
- **I6:** a status observation from `getOffer`.
- **I7:** live: one real listing of a real item, then ended. Needs the owner's explicit approval at that moment.
- **I8 (later):** the Vinted prepared form through a visible handoff on a node.

## I.4 Further out

- **Adaptive Surfaces (P6):**
  - registry: 11 of 15 kinds exist (Document/Editor, Media, Timeline, Verification missing);
  - compositor: built;
  - pages: v1 uses fixed pages.
  - A listing workflow is a good first real use of the compositor instead of another fixed page. I3 can be built as Surfaces in the Workbench.
- **Gmail:** attach Google's Gmail MCP to Claude's runtime config (read and draft only) once the owner creates the Google Cloud project. A good second connector, because it needs no Noctis adapter code.
- **YouTube and TikTok:** they come with the Thought Unfolds workflow (P11 "Song" / channel). Upload to YouTube as private with the Data API, and TikTok as drafts.

---

## Self-review

- **Spec coverage:**

  | Item                       | Covered by    |
  | -------------------------- | ------------- |
  | 1 mirror                   | E             |
  | 2 Vault                    | B1, B2, B3    |
  | 3 UI pass                  | A1 to A5      |
  | 4 alive core               | A7, C         |
  | 5 clock                    | A6            |
  | 6 Tauri                    | H             |
  | 7 workflows and connectors | I.1, I.2, I.4 |
  | 8 listing workflow         | I.3           |
  | 9 personas                 | D             |
  | 10 wake                    | F             |

  Testing deferral: G.

- **Placeholders:** these are deliberate, because their code depends on the owner's decision. Each has a design, decisions, tasks and the test for each task:
  - D to F, H and I: decision-gated, with a task outline rather than step code.
  - B3: conditional.
- **Names used across tasks:** `useBackLayer`, `pushPage`, `entryPage`, `HistoryEntry` (A4); `Picker`, `PickerOption` (A5); `clockText`, `greetingFor`, `msToNextMinute` (A6); `isGeneratedNote` (B1); `dockFor`, `Dock`, `CompanionCore` (C).
