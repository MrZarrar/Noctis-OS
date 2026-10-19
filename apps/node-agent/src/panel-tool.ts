import {
  OptionsProposalSchema,
  PAGE_PANEL_PAGES,
  PANEL_PROPOSABLE_KINDS,
  PathPanelProposalSchema,
  SURFACE_PAYLOAD_SCHEMAS,
} from "@noctis/contracts";
import type { z } from "zod";

const PAGES = PAGE_PANEL_PAGES.map((page) => `"${page}"`).join("|");

/** Shared by the SDK and stdio MCP routes; read by the model each turn. */
export const PANEL_TOOL_DESCRIPTION =
  'Show your work in a panel beside this conversation; panels are where the owner watches it. Keep a few useful ones and update them as you go, not only at the end: progress, the result, and decisions. Panels are quick and cheap, never a build of their own. Give it a panelId (lowercase letters, digits and dashes, e.g. "readme-drafts") and propose the same kind with the same panelId again to update it in place, in this turn or a later one; without a panelId each turn gets a new panel. Noctis validates it and decides position and size. Fastest: show an existing file by path, {title, path} with an absolute path inside a shared folder, nothing copied: kind document for text and markdown (a README renders with its relative images and ```mermaid diagrams, and refreshes when you edit the file), media for an image, video or audio file, visual for an interactive .html or .svg page you built (a small hand-written page; it runs sandboxed with no network, so inline every script, style, font and image, max 2 MB). A mermaid diagram in a document is the default visual. Files you write or edit in a shared folder already open as panels by themselves, and so does anything saved in noctis-show/ in your working folder by any means, so a page a script builds or a screenshot needs no call at all. Other kinds: document {title, format: "markdown"|"text", content: {from: "inline", text}} for text that is not a file, max 50000 chars, where markdown images use absolute paths inside a shared folder; list {items: [{id, label, detail?}]} for choices; detail {fields: [{label, value}]} for facts; evidence {items: [{id, claim, source, status: "current"|"stale"|"unavailable"|"unknown"}]}; attention {headline, detail} for a blocker; timeline {title, items: [{id, start?, end?, label, detail?, due?}]} (times shown as given) for progress; verification {title, items: [{id, claim, status: "verified"|"partial"|"required"|"blocked", reason?}]}; page {page: ' +
  PAGES +
  '} opens that Noctis page itself, as when the owner says "open the vault"; options {title, options: [{id, title, price?, detail?, image: {path}?, url?, action: {label, message}?}]} (1 to 8) for things the owner picks between, each with a screenshot by absolute path inside a shared folder, an http(s) link the owner can open, and its own choice. Any kind but media can add actions: [{label, message}] (max 8; label 80 chars, message 4000 chars), choices that send a message to this conversation only. Timeline/verification max 50 items. role: primary for main work, supporting or context beside it. Never supply commands, URLs or file access as actions.`';

const FILE_KINDS = new Set(["document", "media", "visual"]);

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${["payload", ...issue.path.map(String)].join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Why the core would not show this panel, or nothing when it would. The core
 * still decides; this only means the agent hears about a bad shape in the same
 * turn instead of telling the owner a panel is up that never appeared.
 */
export function surfaceProblem(args: {
  surfaceKind: string;
  payloadVersion: number;
  payload: unknown;
}): string | undefined {
  const { surfaceKind: kind, payload } = args;
  const contract = SURFACE_PAYLOAD_SCHEMAS[kind];

  if (!PANEL_PROPOSABLE_KINDS.has(kind) || contract === undefined) {
    return `Not shown: "${kind}" is not a panel an agent can open. Use one of ${[...PANEL_PROPOSABLE_KINDS].join(", ")}.`;
  }

  if (contract.payloadVersion !== args.payloadVersion) {
    return `Not shown: payloadVersion for ${kind} is ${String(contract.payloadVersion)}.`;
  }

  if (kind === "page" && typeof payload === "object" && payload !== null && "folder" in payload) {
    return "Not shown: a page panel cannot name a folder; open the page without one.";
  }

  if (FILE_KINDS.has(kind) && PathPanelProposalSchema.safeParse(payload).success) {
    return undefined;
  }

  if (kind === "visual" || kind === "media") {
    return `Not shown: a ${kind} panel shows a file by its path: {title, path}.`;
  }

  const parsed = (kind === "options" ? OptionsProposalSchema : contract.schema).safeParse(payload);

  const shape =
    kind === "options"
      ? " Shape: {title, options: [{id, title, price?, detail?, image: {path}?, url?, action: {label, message}?}]}."
      : "";

  return parsed.success
    ? undefined
    : `Not shown, send it again fixed: ${issues(parsed.error)}.${shape}`;
}
