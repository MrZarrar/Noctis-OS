import { describe, expect, it } from "vitest";

import { isGeneratedNote, isSensitiveNote, normalizeKey, parseNote, titleFor } from "./markdown.js";

const NOTE = `---
title: Jarvis Project
aliases: [Jarvis, jarvis-os]
tags:
  - project
  - active
---

# Jarvis Project

Started with [[Alex Kerr]] in 2026. See also [[Acme Travel|the client]] and
[[Runbook#deploy]]. An embed counts too: ![[Diagram]].

A literal [[Alex Kerr]] again, later in the note.
`;

describe("parsing a note", () => {
  it("never alters the prose it was given", () => {
    const parsed = parseNote(NOTE);

    expect(parsed.raw).toBe(NOTE);
    expect(NOTE.slice(parsed.bodyOffset)).toBe(parsed.body);
  });

  it("separates frontmatter from body without reformatting either", () => {
    const parsed = parseNote(NOTE);

    expect(parsed.frontmatter?.raw).toContain("title: Jarvis Project");
    expect(parsed.body.startsWith("\n# Jarvis Project")).toBe(true);
    expect(parsed.body).not.toContain("---");
  });

  it("reads the frontmatter fields link resolution needs", () => {
    const parsed = parseNote(NOTE);

    expect(parsed.frontmatter?.title).toBe("Jarvis Project");
    expect(parsed.frontmatter?.aliases).toEqual(["Jarvis", "jarvis-os"]);
  });

  it("reads a block-list alias as well as an inline one", () => {
    const parsed = parseNote("---\naliases:\n  - One\n  - Two\n---\nbody\n");

    expect(parsed.frontmatter?.aliases).toEqual(["One", "Two"]);
  });

  it("treats a note with no frontmatter as all body", () => {
    const parsed = parseNote("# Plain\n\nJust prose.\n");

    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.bodyOffset).toBe(0);
  });

  it("does not treat a mid-note rule as frontmatter", () => {
    const parsed = parseNote("# Heading\n\n---\n\nnot frontmatter\n");

    expect(parsed.frontmatter).toBeUndefined();
  });

  it("finds every wikilink form the donor grammar accepts", () => {
    const keys = parseNote(NOTE).wikilinks.map((link) => link.key);

    expect(keys).toEqual([
      "alex-kerr",
      "acme-travel",
      "runbook",
      "diagram",
      // The same target twice: occurrences, not a de-duplicated set, because
      // each one is its own piece of provenance.
      "alex-kerr",
    ]);
  });

  it("keeps the alias and heading rather than discarding them", () => {
    const links = parseNote(NOTE).wikilinks;

    expect(links.find((link) => link.key === "acme-travel")?.alias).toBe("the client");
    expect(links.find((link) => link.key === "runbook")?.heading).toBe("deploy");
  });

  it("THE GATE: every wikilink span points back at its own text", () => {
    const parsed = parseNote(NOTE);

    expect(parsed.wikilinks.length).toBeGreaterThan(0);

    for (const link of parsed.wikilinks) {
      const quoted = NOTE.slice(link.span.start, link.span.end);

      expect(quoted.startsWith("[[") || quoted.startsWith("![[")).toBe(true);
      expect(quoted).toContain(link.target);
      expect(quoted.endsWith("]]")).toBe(true);
    }
  });

  it("ignores a wikilink inside a fenced code block", () => {
    const parsed = parseNote("Text\n\n```\n[[Not A Link]]\n```\n\n[[Real Link]]\n");

    expect(parsed.wikilinks.map((link) => link.key)).toEqual(["real-link"]);
  });

  it("ignores an empty or whitespace-only target", () => {
    expect(parseNote("[[]] and [[   ]]\n").wikilinks).toEqual([]);
  });
});

describe("normalizing a key", () => {
  it.each([
    ["Jarvis Project", "jarvis-project"],
    ["jarvis_project", "jarvis-project"],
    ["  Spaced  Out  ", "spaced-out"],
    ["Note.md", "note"],
    ["NOTE.MD", "note"],
    ["Already-Fine", "already-fine"],
  ])("folds %s to %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it("is idempotent", () => {
    expect(normalizeKey(normalizeKey("Jarvis  Project"))).toBe(normalizeKey("Jarvis  Project"));
  });
});

describe("choosing a title", () => {
  it("prefers frontmatter, then a heading, then the filename", () => {
    expect(titleFor("projects/x.md", parseNote(NOTE))).toBe("Jarvis Project");
    expect(titleFor("projects/x.md", parseNote("# From Heading\n\nbody"))).toBe("From Heading");
    expect(titleFor("projects/my-note.md", parseNote("no heading"))).toBe("my-note");
  });
});

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

  it("reads only the tags field, never other frontmatter lines", () => {
    for (const line of [
      "source: graphify/out",
      "description: tried graphify/code",
      "aliases: [graphify/x]",
    ]) {
      expect(isGeneratedNote(parseNote(`---\n${line}\ntags: [projects]\n---\n# x\n`))).toBe(false);
    }

    expect(
      isGeneratedNote(parseNote("---\ntags:\n  - projects\nsource: graphify/out\n---\n# x\n")),
    ).toBe(false);
  });

  it("accepts quoted tags and a comma list", () => {
    expect(isGeneratedNote(parseNote('---\ntags: ["graphify/code", other]\n---\n# x\n'))).toBe(
      true,
    );
    expect(isGeneratedNote(parseNote("---\ntags:\n  - 'graphify/code'\n---\n# x\n"))).toBe(true);
    expect(isGeneratedNote(parseNote('---\ntags:\n  - "graphify/code"\n---\n# x\n'))).toBe(true);
    expect(isGeneratedNote(parseNote("---\ntags: a, graphify/code\n---\n# x\n"))).toBe(true);
    expect(isGeneratedNote(parseNote("---\ntags:\n  - a\n  - graphify/code\ntype: x\n---\n"))).toBe(
      true,
    );
  });
});

describe("isSensitiveNote", () => {
  it("is sensitive only when the frontmatter says sensitive: true", () => {
    expect(isSensitiveNote(parseNote("---\nsensitive: true\n---\n# x\n"))).toBe(true);
    expect(isSensitiveNote(parseNote('---\ntitle: x\nsensitive: "true"\n---\n# x\n'))).toBe(true);
    expect(isSensitiveNote(parseNote("---\nsensitive: false\n---\n# x\n"))).toBe(false);
    expect(isSensitiveNote(parseNote("# No frontmatter\n\nsensitive: true\n"))).toBe(false);
    expect(isSensitiveNote(parseNote("---\ndescription: sensitive: true\n---\n# x\n"))).toBe(false);
  });
});
