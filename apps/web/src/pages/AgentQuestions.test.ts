import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentQuestions, answerText, openQuestions, questionsOf } from "./AgentQuestions.js";

const asked = {
  itemId: "tu-1",
  kind: "tool_call",
  status: "declined",
  tool: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Which repos should I cover?",
        header: "Scope",
        multiSelect: false,
        options: [
          { label: "Public portfolio", description: "Skip stubs and duplicates" },
          { label: "Everything", description: "All 17" },
        ],
      },
      {
        question: "Where should changes land?",
        header: "Branch",
        multiSelect: true,
        options: [
          { label: "main", description: "Push straight" },
          { label: "A PR", description: "One per repo" },
        ],
      },
    ],
  },
} as const;

describe("agent questions", () => {
  it("reads the questions an AskUserQuestion call carried, and nothing from other tools", () => {
    expect(questionsOf(asked)?.map((q) => q.question)).toEqual([
      "Which repos should I cover?",
      "Where should changes land?",
    ]);
    expect(questionsOf({ ...asked, tool: "Read" })).toBeUndefined();
    expect(questionsOf({ ...asked, input: { questions: "nope" } })).toBeUndefined();
  });

  it("waits on the questions only of the latest turn, and only once it has ended", () => {
    const said = { itemId: "m1", kind: "agent_message", status: "completed", text: "Hi" } as const;
    const ended = { status: "completed", items: [said, asked] } as const;

    expect(openQuestions([ended]).map((q) => q.header)).toEqual(["Scope", "Branch"]);
    expect(openQuestions([{ ...ended, status: "running" }])).toEqual([]);
    expect(openQuestions([ended, { status: "completed", items: [said] }])).toEqual([]);
    expect(openQuestions([])).toEqual([]);
  });

  it("answers in one message, each question beside what was picked, skipping the unanswered", () => {
    const questions = questionsOf(asked) ?? [];

    expect(answerText(questions, [["Public portfolio"], ["main", "A PR"]])).toBe(
      "Which repos should I cover? Public portfolio\nWhere should changes land? main, A PR",
    );
    expect(answerText(questions, [[], ["main"]])).toBe("Where should changes land? main");
    expect(answerText(questions, [[], []])).toBe("");
  });

  it("shows every question with its options, and says a typed reply works too", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentQuestions, {
        questions: questionsOf(asked) ?? [],
        answerable: true,
        onAnswer: () => undefined,
      }),
    );

    expect(markup).toContain("Which repos should I cover?");
    expect(markup).toContain("Public portfolio");
    expect(markup).toContain("Skip stubs and duplicates");
    expect(markup).toContain("Where should changes land?");
    expect(markup).toContain("type your own answer");
  });

  it("disables the options once the conversation has moved on", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentQuestions, {
        questions: questionsOf(asked) ?? [],
        answerable: false,
        onAnswer: () => undefined,
      }),
    );

    expect(markup.match(/<button[^>]*disabled/g)?.length).toBe(markup.match(/<button/g)?.length);
  });
});
