// Run from the repo root: node apps/web/src/larp/fixtures/make-vault.mjs
// The app imports vault.json. This script only regenerates that fictional fixture.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { URL } from "node:url";

import { settle } from "@noctis/domain";

const at = "2026-10-22T10:40:00.000Z";
const id = (key) => {
  const hex = createHash("sha256").update(`larp-vault:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// All people, businesses and observations below were invented for this fixture.
const topics = [
  {
    name: "Hardware panel",
    owner: "Mira Tallow",
    partner: "Orin Valecrest",
    goal: "Show CPU, RAM, GPU and VRAM for Home PC and Work PC in one readable panel.",
    facts: [
      "The hardware panel uses one card per PC. CPU and GPU bars share a percentage scale; RAM and VRAM also show used and available capacity.",
      "A two-second sample interval keeps the sparkline readable. Retain the last sixty samples and pause sampling when the panel is hidden.",
      "Claude owns the collector contract. Codex owns the bar rendering and the tests for missing GPU counters. Hermes can explain a spike from the same sample window.",
      "A disconnected PC keeps its last sample with a stale timestamp. An unavailable GPU counter gets an unavailable state rather than a zero reading.",
      "The first review found a memory unit bug: bytes were labelled as gigabytes. Convert once at the adapter boundary and cover a 16 GiB example.",
      "The load preset raises the CPU and GPU bars over several samples, then eases them back. Keep the previous sixty samples while changing presets.",
      "Keyboard focus follows the panel title, then the node controls. At phone width the cards stack and every metric keeps its unit beside its value.",
      "The restart approval names Home PC and the node agent. The panel arrives only after the approval is accepted, so a pending restart stays visible.",
    ],
  },
  {
    name: "Glucose pattern notebook",
    owner: "Selka Fenrow",
    partner: "Tovin Ashmere",
    goal: "Explain how a fictional glucose day becomes a useful pattern review.",
    facts: [
      "The glucose examples are invented teaching data. Five-minute readings cover a complete day and each observation links to its meal or overnight window.",
      "Breakfast has a repeating early rise across four fictional weekdays. The report compares similar meals before offering a pattern to review.",
      "An overnight correction is shown beside the preceding trend. A single unusual night has lower confidence than a pattern repeated over several nights.",
      "A basal suggestion waits for review and cites the nights behind it. Keep the suggestion separate from any accepted change and its later outcome.",
      "The helped marker compares the week after a reviewed change with the week before. Show the count of comparable days beside the improvement.",
      "Time in range is computed from covered intervals. A sensor gap reduces coverage and stays visible on the chart instead of being filled with invented readings.",
      "Meal labels are contextual evidence. Keep the glucose trace visible while opening a finding so the reader can check the timing.",
      "Codex checks interval boundaries and missing readings. Claude reviews the report contract; the local model drafts a short explanation from validated findings.",
    ],
  },
  {
    name: "Lantern kit pricing",
    owner: "Ivara Mosswick",
    partner: "Neris Quillbrook",
    goal: "Choose a sustainable pricing model for a small digital template business.",
    facts: [
      "Lantern Kit sells planning templates for independent makers. The pricing worksheet compares a GBP 18 starter pack with a GBP 34 bundle.",
      "The bundle includes a release checklist and a weekly planning sheet. Buyers receive the same editable files regardless of the checkout route.",
      "Allow GBP 3 per order for support time and refunds in the margin exercise. Keep that assumption visible beside the price calculation.",
      "The research notes favour a one-time purchase for the first release. A subscription would require a dependable schedule of new useful material.",
      "The landing page should show a filled example before asking for a purchase. The useful comparison is the time saved during a real release week.",
      "A small interview round asked which sheet people would reuse next month. The release checklist had the clearest repeat use among the fictional responses.",
      "Codex caught a rounding error in the pricing calculator when a discount and a refund allowance were combined. Round at the displayed total.",
      "The next experiment compares the starter pack with the bundle on the same page. Record the decision and the assumptions before changing either price.",
    ],
  },
  {
    name: "Pebble timer",
    owner: "Elian Brackenby",
    partner: "Vessa Cloudmere",
    goal: "Build a focused work timer that survives sleep and browser tab changes.",
    facts: [
      "Pebble Timer stores the intended finish instant in memory while a session is running. Rendering derives the remaining duration from the clock.",
      "The first bug appeared after laptop sleep: the timer resumed with twelve minutes left even though its finish instant had passed.",
      "Codex wrote a failing clock-jump test before replacing the decrementing counter. The same test covers a background tab resuming late.",
      "The bell has one explicit enable control. A visual finished state remains available when the browser refuses audio playback.",
      "A short break starts only when requested. Closing a completed session keeps a useful summary of focused minutes for the current view.",
      "Hermes drafted the keyboard help. Space pauses an active timer only when focus is outside a text field or another interactive control.",
      "Claude reviewed the timestamp boundary and kept scheduling independent of animation frames. Animation frames update the display while the clock owns time.",
      "The phone layout places the remaining time above the session controls. A long task name wraps without moving the pause button off screen.",
    ],
  },
  {
    name: "Thread reconnect repair",
    owner: "Dara Wrenford",
    partner: "Kael Pinemark",
    goal: "Keep a streamed conversation readable when a connection drops and resumes.",
    facts: [
      "The reconnect bug duplicated the last assistant paragraph after a short network interruption. The event cursor was advanced after rendering instead of after acceptance.",
      "Every accepted event has a stable identifier. Replaying an already accepted event leaves the transcript unchanged.",
      "Codex reproduced the duplicate with a sequence containing two repeats and one new event. The test checks the final transcript rather than callback counts.",
      "Claude separated transport reconnect state from turn state. A connection retry can coexist with a turn that is still working.",
      "The resumed stream starts after the last accepted cursor. A gap produces an explicit refresh request instead of silently dropping intermediate text.",
      "The scroll position stays anchored when reading older messages. New tokens move the viewport only when the reader was already following the end.",
      "Hermes suggested a compact reconnect message beside the composer. It clears when the next accepted event confirms that the stream has resumed.",
      "The review includes cancellation during reconnect and a completed turn arriving twice. Both paths settle in a single visible final state.",
    ],
  },
  {
    name: "Quiet shelf research",
    owner: "Soren Briarwick",
    partner: "Luma Dewhurst",
    goal: "Make a research reading queue useful for one decision at a time.",
    facts: [
      "Quiet Shelf groups reading by the decision it supports. A source card records the question, a short finding and the reason to return to it.",
      "A saved link is a starting point. The useful note contains a claim in plain language and the passage that supports it.",
      "The first research question compares a local index with a hosted index for a small catalogue. Record maintenance effort beside search quality.",
      "Claude condensed the source notes into a comparison with explicit unknowns. Codex checked the example filters against the saved catalogue fixture.",
      "The reading queue has a small active set. Move a source back to the shelf when it stops affecting the current decision.",
      "A contradictory source stays beside the earlier claim. The conclusion records why one explanation currently fits the evidence better.",
      "The local model drafts short reading summaries from supplied excerpts. It keeps the source title attached so the owner can inspect the original passage.",
      "The next review will test whether the chosen catalogue query still works after a title changes and a tag is removed.",
    ],
  },
  {
    name: "Pocket inventory",
    owner: "Fenna Reedwell",
    partner: "Arlen Copperfen",
    goal: "Track a small craft shop inventory without making every sale a bookkeeping task.",
    facts: [
      "Pocket Inventory records an item, a stock movement and a reason. Current stock is the sum of accepted movements for that item.",
      "A cancelled sale creates a reversal with a link to the original movement. The history stays readable when a quantity changes later.",
      "The pricing sheet separates materials, packaging and time. A discount can reduce margin below the owner's minimum, which requires a visible warning.",
      "Codex found that a repeated import could double the stock count. A source row key now identifies the same movement across retries.",
      "Low stock alerts use the available count after reserved orders. A partly packed order keeps its reservation until it ships or is cancelled.",
      "Claude kept the initial import local to the review screen. The owner checks quantities before accepting the batch as inventory movements.",
      "The week review compares fast sellers with slow stock. The proposed next batch is small enough to fit one packing session.",
      "Hermes drafts a reorder reminder with the item name and remaining quantity. The reminder links back to the stock history.",
    ],
  },
  {
    name: "Atlas release checklist",
    owner: "Cira Hollowmere",
    partner: "Oren Flintward",
    goal: "Make a small app release easy to inspect and repeat.",
    facts: [
      "Atlas records the build identifier, targeted checks and the release decision in one checklist. Every check names the behaviour it protects.",
      "A preview build runs from the exact lockfile. The review includes the empty state, a populated account and an expired session.",
      "Claude reviews the migration ordering before any release step. A migration that cannot be reversed needs a tested recovery route.",
      "Codex found a configuration mismatch between preview and packaged builds. The release check now reads the resolved configuration for each target.",
      "The change note explains what a user can do differently after updating. Internal refactors stay in the engineering notes unless behaviour changes.",
      "The rollback exercise restores a previous build against a disposable dataset. Record the time taken and any manual step that needs simplifying.",
      "The local model drafts a release summary from the accepted change list. The owner checks it against the diff before publishing.",
      "The next release has a small compatibility check for older saved settings. Unknown settings are preserved while supported values are validated.",
    ],
  },
  {
    name: "Tideboard weekly planning",
    owner: "Tessa Marrowfield",
    partner: "Ruvan Birchstone",
    goal: "Plan a week around concrete outcomes while leaving room for interruptions.",
    facts: [
      "Tideboard starts with the outcome that would make Friday feel useful. Each task names the smallest visible result that moves that outcome forward.",
      "The calendar reserves a block for unexpected work. A full calendar has no capacity for the interruptions already seen in previous weeks.",
      "A task moves to waiting when it needs an answer from someone else. The waiting list records the question and a reasonable follow-up day.",
      "Hermes prepares a morning digest from accepted tasks and reminders. Codex checks that completed tasks disappear from the active queue.",
      "The week review keeps useful evidence: a shipped fix, a tested assumption or a decision recorded with its reason.",
      "A deferred task keeps its original context when moved to next week. The owner can then see whether the priority still makes sense.",
      "Claude suggested grouping short maintenance jobs into one block. Deep work remains attached to a single project outcome.",
      "The phone view opens today's commitments first. The complete week remains one control away without compressing every day into a narrow column.",
    ],
  },
  {
    name: "Signal garden accessibility",
    owner: "Nola Ferncrest",
    partner: "Evan Larkspurrow",
    goal: "Make a dashboard usable with keyboard navigation and reduced motion.",
    facts: [
      "Signal Garden uses the same reading order in the DOM and on screen. Keyboard focus follows the task the owner is currently completing.",
      "A focused card has a visible outline across every theme. Information carried by colour also has a word or a shape beside it.",
      "Reduced motion replaces panel travel with a short fade. The panel's arrival still has an accessible announcement.",
      "Codex found that closing a dialog lost focus at the page root. Focus now returns to the control that opened the dialog.",
      "Claude reviewed the status labels so a stale metric differs from an unavailable metric in both text and presentation.",
      "A chart has a short textual account of its trend and a way to inspect individual values. Hover remains an enhancement to keyboard controls.",
      "Phone targets retain enough room for a thumb even when labels wrap. The page can zoom without hiding the confirmation control.",
      "The final review uses the actual task flow from opening a card to confirming its change. A static screenshot covers only part of the experience.",
    ],
  },
  {
    name: "Moss archive search",
    owner: "Yara Stonewillow",
    partner: "Perrin Embervale",
    goal: "Find useful notes through titles, body words and explicit links.",
    facts: [
      "Moss Archive preserves note titles and relative paths. A recalled passage points to the exact note so the reader can check its surrounding context.",
      "Title matches rank ahead of incidental body matches. An exact phrase gets more weight than separated words in a long daily note.",
      "Codex checks case folding, punctuation and an empty query. Search returns a useful empty state when every candidate misses.",
      "A renamed note keeps its stable entity identifier. Incoming links can update their displayed title without changing recall targets.",
      "Sensitive notes disappear from the graph, recall and direct reads together. An unlock refreshes each of those views from the same state.",
      "Claude separates the indexed metadata from the Markdown body. A stale index says when it was last checked and keeps the source path available.",
      "The graph uses dense local links around topic hubs with a smaller set of cross-project connections. The overview stays readable when zoomed out.",
      "The next experiment compares short excerpts with a full-note preview. Keep the query visible while opening a result and returning to the graph.",
    ],
  },
  {
    name: "Ember queue automation",
    owner: "Malin Thistledown",
    partner: "Zerin Brookhaven",
    goal: "Run small background tasks with clear ownership and visible outcomes.",
    facts: [
      "Ember Queue gives each job a stable key, a requested action and an explicit destination. The queue accepts validated jobs before scheduling them.",
      "A retry reuses the same operation key. The result of an accepted job can be read again without performing the action twice.",
      "Claude owns the state transitions between queued, running and settled. Codex checks cancellation while a job is waiting for a worker.",
      "A failed job keeps a short reason and its last accepted progress. The owner can inspect the input before requesting another attempt.",
      "A worker reconnect announces the jobs it still owns. The scheduler reconciles that list before assigning more work to the same worker.",
      "The local model can propose a task description. Deterministic validation chooses whether the task is allowed and where it can run.",
      "The activity view groups repeated progress messages while preserving the final result. A cancelled job remains distinct from a completed one.",
      "The next exercise simulates two workers becoming available together. A job must acquire a single owner even when both offer to take it.",
    ],
  },
];

const projectFacets = [
  "overview",
  "scope",
  "decisions",
  "implementation",
  "bug diary",
  "test report",
  "review",
  "next steps",
];
const referenceFacets = [
  "data contract",
  "failure modes",
  "keyboard flow",
  "comparison",
  "worked example",
  "research notes",
  "timing",
  "checklist",
  "glossary",
  "tradeoffs",
];
const inboxFacets = [
  "field note",
  "open question",
  "review follow-up",
  "experiment",
  "rough sketch",
  "week reflection",
];
const notes = [];
const targets = new Map();
function add(folder, title, text, links, sensitive = false) {
  const path = `${folder}/${slug(title)}.md`;
  const modifiedAt = new Date(Date.parse(at) - (notes.length % 24) * 86400000).toISOString();
  const note = {
    id: id(`entity:${path}`),
    itemId: id(`item:${path}`),
    path,
    title,
    type: {
      projects: "project",
      people: "person",
      reference: "reference",
      daily: "daily",
      inbox: "capture",
      agent: "agent",
    }[folder],
    text: `# ${title}\n\n${text}\n\nRelated: ${[...new Set(links)]
      .filter((name) => name !== title)
      .map((name) => `[[${name}]]`)
      .join(", ")}.\n`,
    sensitive,
    modifiedAt,
    indexedAt: at,
  };
  notes.push(note);
  targets.set(title, note);
  return note;
}

for (const topic of topics) {
  for (const [folder, facets] of [
    ["projects", projectFacets],
    ["reference", referenceFacets],
    ["inbox", inboxFacets],
  ]) {
    facets.forEach((facet, index) => {
      const title = folder === "projects" && index === 0 ? topic.name : `${topic.name}: ${facet}`;
      const fact = topic.facts[index % topic.facts.length];
      const next = topic.facts[(index + (folder === "reference" ? 3 : 1)) % topic.facts.length];
      const context =
        folder === "inbox"
          ? `Captured for the next review with ${topic.owner}. Check this against the current decision before filing it.`
          : folder === "reference"
            ? `Reference for ${facet}. Keep this explanation beside the worked example when the implementation changes.`
            : `Working ${facet} for ${topic.name}. ${topic.owner} is following the implementation with ${topic.partner}.`;
      add(
        folder,
        title,
        `${topic.goal}\n\n${context}\n\n${fact}\n\n${next}`,
        [
          topic.name,
          topic.owner,
          topic.partner,
          `${topic.name}: test report`,
          `${topic.name}: data contract`,
          "Claude working notes",
          "Codex working notes",
        ],
        folder === "inbox" && facet === "rough sketch",
      );
    });
  }
  for (const [name, role] of [
    [topic.owner, "project lead"],
    [topic.partner, "review partner"],
  ]) {
    add(
      "people",
      name,
      `${name} is the ${role} for ${topic.name}.\n\n${topic.goal}\n\nThey prefer a concrete example before discussing a change. The current review focuses on ${topic.facts[4]}\n\nThe next conversation should open the test report and check the open question from the inbox. Decisions belong beside the project so another reviewer can follow the reasoning.`,
      [
        topic.name,
        `${topic.name}: review`,
        `${topic.name}: open question`,
        "Tideboard weekly planning",
        "Claude working notes",
        "Codex working notes",
      ],
    );
  }
}

for (let day = 0; day < 28; day += 1) {
  const date = new Date(Date.parse(at) - day * 86400000).toISOString().slice(0, 10);
  const first = topics[day % topics.length];
  const second = topics[(day + 5) % topics.length];
  const facet = projectFacets[(day % 7) + 1];
  add(
    "daily",
    `${date} work journal`,
    `Today's main block was ${first.name}. ${first.facts[day % 8]}\n\nReviewed the ${facet} with ${first.owner}. The useful outcome was a written example that another person could check without replaying the whole discussion.\n\nLater: ${second.facts[(day + 2) % 8]}\n\nCarry forward: ask ${second.partner} to check the ${second.name} worked example, then update the weekly plan with the answer.`,
    [
      first.name,
      second.name,
      first.owner,
      second.partner,
      `${first.name}: ${facet}`,
      `${second.name}: worked example`,
      "Tideboard weekly planning",
    ],
  );
}

const agentNotes = [
  [
    "Claude working notes",
    "Review contracts before implementation. Keep runtime responsibilities with the worker that owns them and use validated samples when checking a new panel.",
  ],
  [
    "Codex working notes",
    "Write the failing example first, run it, then make the smallest change that satisfies the behaviour. Record the targeted test output beside the decision.",
  ],
  [
    "Hermes working notes",
    "Prepare short digests from accepted tasks and visible evidence. A reminder should name the next action and link to the note that explains it.",
  ],
  [
    "Local model working notes",
    "Draft concise explanations from the passages supplied for the task. Keep source titles attached to claims so the owner can inspect them.",
  ],
  [
    "Vault filing guide",
    "Capture rough observations in the inbox. File durable decisions with their project and keep people notes linked to the work they help explain.",
  ],
  [
    "Morning review routine",
    "Open the weekly plan, check waiting questions and choose one useful project outcome. Read the last work journal before scheduling another task.",
  ],
  [
    "Review evidence checklist",
    "A completion claim needs current evidence. Check the changed behaviour with a focused test and keep any remaining uncertainty beside the result.",
  ],
  [
    "Fictional workspace map",
    "Home PC holds the active projects. Work PC has review documents. Phone is the place for short captures and checking pending decisions.",
  ],
];
for (const [title, text] of agentNotes) {
  add(
    "agent",
    title,
    `${text}\n\nThis workspace connects small software projects, research and a template business. Use explicit links between the current question and its evidence. Keep an earlier decision when a new observation changes the plan, and record the reason for the change.`,
    topics.map((topic) => topic.name),
  );
}

const edges = notes.flatMap((note) =>
  [...note.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => {
    const target = targets.get(match[1]);
    if (!target) throw new Error(`Unresolved fictional link ${match[1]}`);
    return {
      id: id(`edge:${note.id}:${target.id}`),
      source: note.id,
      target: target.id,
      type: "link",
      lifecycle: "resolved",
    };
  }),
);
const layout = settle({
  placed: new Map(),
  incoming: notes.map((note) => ({
    entityId: note.id,
    key: note.title.toLowerCase(),
    type: note.type,
    neighbourIds: edges.filter((edge) => edge.source === note.id).map((edge) => edge.target),
  })),
});
for (const note of notes) Object.assign(note, layout.placed.get(note.id));

const hardware = targets.get("Hardware panel");
const pricing = targets.get("Lantern kit pricing");
const fact = "The hardware panel review uses the same units on Home PC and Work PC.";
hardware.text += `\n${fact}\n`;
const edits = [
  {
    id: id("edit:hardware-units"),
    kind: "fact",
    path: hardware.path,
    source: "inbox/hardware-panel-review-follow-up.md",
    text: fact,
    status: "applied",
    createdAt: at,
    decidedAt: at,
  },
  {
    id: id("edit:sample-rate"),
    kind: "revision",
    path: hardware.path,
    source: "inbox/hardware-panel-experiment.md",
    text: "A two-second sample interval keeps the sparkline readable.",
    replaceText:
      "A one-second sample interval keeps the sparkline readable during a short load test.",
    status: "pending",
    createdAt: at,
  },
  {
    id: id("edit:starter-price"),
    kind: "revision",
    path: pricing.path,
    source: "inbox/lantern-kit-pricing-experiment.md",
    text: "GBP 18 starter pack",
    replaceText: "GBP 20 starter pack",
    status: "pending",
    createdAt: "2026-10-21T16:20:00.000Z",
  },
  {
    id: id("edit:old-plan"),
    kind: "revision",
    path: pricing.path,
    source: "inbox/lantern-kit-pricing-rough-sketch.md",
    text: "one-time purchase",
    replaceText: "monthly subscription",
    status: "declined",
    createdAt: "2026-10-20T09:00:00.000Z",
    decidedAt: "2026-10-20T11:15:00.000Z",
  },
];
const promotions = topics.slice(0, 4).map((topic) => ({
  id: id(`promotion:${topic.name}`),
  kind: "revision",
  path: targets.get(topic.name).path,
  source: `inbox/${slug(`${topic.name}: field note`)}.md`,
  text: topic.facts[0],
  replaceText: `${topic.facts[0]} The latest review includes a checked worked example.`,
  status: "pending",
  createdAt: at,
}));

writeFileSync(
  new URL("vault.json", import.meta.url),
  `${JSON.stringify({ at, promotionTurnId: id("promotion-turn"), notes, edges, edits, promotions }, null, 2)}\n`,
  "utf8",
);
