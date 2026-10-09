import { corner, depth, material, spacing, typography } from "@noctis/ui";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { buttonStyle, fieldStyle, glass } from "./Page.js";
import { useIsMobile } from "./useIsMobile.js";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  /** A short fact beside the label, drawn as a pill: "offline", "read only". */
  detail?: string;
  disabled?: boolean;
}

/** The room kept between an open list and the screen's edge. */
const EDGE = spacing.sm;

const pillStyle = {
  flexShrink: 0,
  fontSize: typography.scale.xs,
  color: typography.color.muted,
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: "2px 6px",
} as const;

function Chevron(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Check(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * A choice from a short list, in the app's own glass rather than the
 * operating system's white popup. A bottom sheet on a phone; on a desktop, a
 * list anchored to its button, below it when there is room and above it when
 * there is not (the composer lives at the foot of the screen).
 *
 * A modal `<dialog>`, like the More sheet: Escape, the focus trap and the top
 * layer come with it, so no ancestor's overflow or blur can clip the list.
 */
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
  const scrollPositions = useRef(new Map<Element, { left: number; top: number }>());
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const id = useId();
  const current = options.find((option) => option.value === value);
  // The one row Tab lands on: the chosen one, or the first that can be chosen.
  const entry = current ?? options.find((option) => option.disabled !== true);

  useEffect(() => {
    const closeOnMove = (event: Event): void => {
      const sheet = dialog.current;
      if (sheet?.open !== true) return;
      if (event.type === "scroll") {
        const target = event.target === document ? document.scrollingElement : event.target;
        if (!(target instanceof Element)) return;
        const before = scrollPositions.current.get(target);
        if (
          before === undefined ||
          (before.left === target.scrollLeft && before.top === target.scrollTop)
        )
          return;
      }
      sheet.close();
    };
    window.addEventListener("resize", closeOnMove);
    window.addEventListener("scroll", closeOnMove, true);
    return () => {
      window.removeEventListener("resize", closeOnMove);
      window.removeEventListener("scroll", closeOnMove, true);
    };
  }, []);

  const show = (): void => {
    const sheet = dialog.current;
    const anchor = button.current?.getBoundingClientRect();

    if (sheet === null || anchor === undefined) {
      return;
    }

    sheet.showModal();
    setOpen(true);

    if (mobile) {
      // Left behind by a desktop opening before the window narrowed.
      sheet.style.removeProperty("top");
      sheet.style.removeProperty("left");
    } else {
      const below = window.innerHeight - anchor.bottom - spacing.xs - EDGE;
      const above = anchor.top - spacing.xs - EDGE;
      const width = Math.min(Math.max(anchor.width, 240), window.innerWidth - 2 * EDGE);

      sheet.style.width = `${String(width)}px`;
      sheet.style.left = `${String(Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - width)))}px`;
      sheet.style.maxHeight = `${String(Math.min(420, Math.max(below, above)))}px`;

      // Measured once it is open and sized, so "is there room below" is
      // answered for this list rather than guessed from its length.
      const height = sheet.offsetHeight;
      const top =
        height <= below || below >= above
          ? anchor.bottom + spacing.xs
          : anchor.top - spacing.xs - height;

      sheet.style.top = `${String(top)}px`;
    }

    sheet.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    scrollPositions.current.clear();
    for (
      let parent = button.current?.parentElement;
      parent != null;
      parent = parent.parentElement
    ) {
      scrollPositions.current.set(parent, { left: parent.scrollLeft, top: parent.scrollTop });
    }
  };

  const pick = (option: PickerOption<T>): void => {
    if (option.disabled === true) {
      return;
    }

    dialog.current?.close();

    if (option.value !== value) {
      onChange(option.value);
    }
  };

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="option"]:not([aria-disabled="true"])',
      ),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: at + 1 >= rows.length ? 0 : at + 1,
      ArrowUp: at <= 0 ? rows.length - 1 : at - 1,
      Home: 0,
      End: rows.length - 1,
    }[event.key];

    if (next !== undefined) {
      event.preventDefault();
      rows[next]?.focus();
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-expanded={open}
        aria-label={
          current === undefined
            ? label
            : `${label}: ${current.label}${current.detail === undefined ? "" : `, ${current.detail}`}`
        }
        onClick={show}
        style={{
          ...fieldStyle,
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          textAlign: "left",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.55 : 1,
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
          {current?.label ?? <span style={{ color: typography.color.muted }}>Choose</span>}
        </span>
        {current?.detail !== undefined && <span style={pillStyle}>{current.detail}</span>}
        <span style={{ display: "flex", color: typography.color.muted }}>
          <Chevron />
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={id}
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
        onClick={(event) => {
          const sheet = dialog.current;
          const box = sheet?.getBoundingClientRect();

          // A click on the dialog itself that falls outside its box is the backdrop.
          if (
            sheet !== null &&
            box !== undefined &&
            event.target === sheet &&
            (event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom)
          ) {
            sheet.close();
          }
        }}
        style={{
          ...glass,
          // Over the glass gradient, an opaque floor: the list must hide what is under it.
          background: `${glass.background}, ${depth.layers[1]}`,
          color: typography.color.primary,
          fontFamily: typography.family,
          boxSizing: "border-box",
          padding: spacing.xs,
          overflowY: "auto",
          ...(mobile
            ? {
                margin: "auto 0 0",
                width: "100%",
                maxWidth: "100%",
                maxHeight: "min(70dvh, 520px)",
                borderRadius: `${String(corner.xl)}px ${String(corner.xl)}px 0 0`,
                borderBottom: "none",
                paddingBottom: `calc(${String(spacing.md)}px + env(safe-area-inset-bottom))`,
              }
            : { position: "fixed", margin: 0, maxWidth: "none" }),
        }}
      >
        <p
          id={id}
          style={{
            margin: `${String(spacing.sm)}px ${String(spacing.md)}px`,
            fontSize: typography.scale.xs,
            color: typography.color.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </p>
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          onKeyDown={move}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}
        >
          {options.map((option) => {
            const selected = option.value === value;
            const off = option.disabled === true;

            return (
              <li
                key={option.value}
                role="option"
                tabIndex={option === entry ? 0 : -1}
                aria-selected={selected}
                aria-disabled={off}
                onClick={() => {
                  pick(option);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    pick(option);
                  }
                }}
                style={{
                  ...buttonStyle,
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.sm,
                  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
                  border: "none",
                  background: selected ? material.fillElevated : "transparent",
                  opacity: off ? 0.45 : 1,
                  cursor: off ? "default" : "pointer",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {option.label}
                </span>
                {option.detail !== undefined && (
                  <>
                    {/* Heard between the label and the pill; a flex row draws no space. */}{" "}
                    <span style={pillStyle}>{option.detail}</span>
                  </>
                )}
                <span
                  style={{
                    display: "flex",
                    width: 14,
                    visibility: selected ? "visible" : "hidden",
                  }}
                >
                  <Check />
                </span>
              </li>
            );
          })}
        </ul>
      </dialog>
    </>
  );
}
