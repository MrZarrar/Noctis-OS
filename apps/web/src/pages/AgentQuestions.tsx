import type { RuntimeItem } from "@noctis/contracts";
import { identityAccent, material, spacing, typography } from "@noctis/ui";
import { useState } from "react";
import { z } from "zod";

import { buttonStyle, glass } from "../layout/Page.js";

/** Claude Code's AskUserQuestion input. Not ours, so only what is shown is read. */
const QuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
      }),
    )
    .min(1),
});

export type AgentQuestion = z.infer<typeof QuestionsSchema>["questions"][number];

export function questionsOf(item: RuntimeItem): AgentQuestion[] | undefined {
  if (item.kind !== "tool_call" || item.tool !== "AskUserQuestion") {
    return undefined;
  }

  const parsed = QuestionsSchema.safeParse(item.input);

  return parsed.success ? parsed.data.questions : undefined;
}

/**
 * What the agent stopped to ask. Anything said since makes a newer turn, so
 * only the latest one can still be waiting on an answer.
 */
export function openQuestions(
  turns: readonly { status: string; items: readonly RuntimeItem[] }[],
): AgentQuestion[] {
  const turn = turns.at(-1);
  if (turn === undefined || turn.status === "queued" || turn.status === "running") return [];
  return turn.items.flatMap((item) => questionsOf(item) ?? []);
}

/** One line per answered question, so the agent can tell which pick answers which. */
export function answerText(questions: readonly AgentQuestion[], picks: string[][]): string {
  return questions
    .flatMap((q, index) => {
      const chosen = picks[index] ?? [];
      return chosen.length === 0 ? [] : [`${q.question} ${chosen.join(", ")}`];
    })
    .join("\n");
}

/**
 * The agent's questions, asked in the thread rather than as an approval: the
 * agent ended its turn to wait, so the answer is simply the next message.
 */
export function AgentQuestions({
  questions,
  answerable,
  onAnswer,
}: {
  questions: readonly AgentQuestion[];
  /** False once anything was said after it, so an old question is not answered twice. */
  answerable: boolean;
  onAnswer: (text: string) => void;
}): JSX.Element {
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const text = answerText(questions, picks);

  function pick(index: number, label: string, multi: boolean): void {
    setPicks((current) =>
      current.map((chosen, at) => {
        if (at !== index) return chosen;
        if (chosen.includes(label)) return chosen.filter((l) => l !== label);
        return multi ? [...chosen, label] : [label];
      }),
    );
  }

  return (
    <div
      data-agent-questions
      style={{
        ...glass,
        padding: spacing.md,
        display: "grid",
        gap: spacing.md,
        color: typography.color.primary,
        fontSize: typography.scale.sm,
      }}
    >
      {questions.map((q, index) => (
        <fieldset key={q.question} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend style={{ padding: 0, marginBottom: spacing.xs, fontWeight: 600 }}>
            {q.question}
            {q.multiSelect === true && (
              <span style={{ fontWeight: 400, color: typography.color.muted }}> (pick any)</span>
            )}
          </legend>
          <div style={{ display: "grid", gap: spacing.xs }}>
            {q.options.map((option) => {
              const chosen = picks[index]?.includes(option.label) === true;

              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={!answerable}
                  aria-pressed={chosen}
                  onClick={() => pick(index, option.label, q.multiSelect === true)}
                  style={{
                    ...buttonStyle,
                    padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
                    textAlign: "left",
                    border: `1px solid ${chosen ? identityAccent.vesper.primary : material.border}`,
                  }}
                >
                  <span style={{ display: "block" }}>{option.label}</span>
                  {option.description !== undefined && (
                    <span
                      style={{
                        display: "block",
                        fontWeight: 400,
                        fontSize: typography.scale.xs,
                        color: typography.color.muted,
                      }}
                    >
                      {option.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}>
        <button
          type="button"
          disabled={!answerable || text === ""}
          onClick={() => onAnswer(text)}
          style={buttonStyle}
        >
          Send answer
        </button>
        <span style={{ color: typography.color.muted, fontSize: typography.scale.xs }}>
          Or type your own answer below.
        </span>
      </div>
    </div>
  );
}
