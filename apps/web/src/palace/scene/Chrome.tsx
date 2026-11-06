import { ArrowLeft, ChevronUp, Search } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

export type SearchScope = "palace" | "room";

export interface ChromeProps {
  roomName: string;
  query: string;
  onQuery: (query: string) => void;
  scope: SearchScope;
  onScope: (scope: SearchScope) => void;
  exploring: boolean;
  onExplore: (exploring: boolean) => void;
  onLeave?: () => void;
  onReturnToAtrium?: () => void;
}

export function Chrome({
  roomName,
  query,
  onQuery,
  scope,
  onScope,
  exploring,
  onExplore,
  onLeave,
  onReturnToAtrium,
}: ChromeProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <>
      {onReturnToAtrium !== undefined && (
        <button
          type="button"
          className="palace-back palace-back-atrium"
          onClick={onReturnToAtrium}
          style={{ pointerEvents: "auto" }}
        >
          <ArrowLeft size={16} aria-hidden /> Back to the atrium
        </button>
      )}
      {onLeave !== undefined && (
        <button
          type="button"
          className="palace-back palace-back-noctis"
          onClick={onLeave}
          style={{ pointerEvents: "auto" }}
        >
          <ArrowLeft size={16} aria-hidden /> Back to Noctis
        </button>
      )}

      <div className="palace-heading-anchor">
        <motion.div
          className="palace-heading"
          animate={{ y: exploring ? -10 : 0 }}
          transition={{ duration: reduced ? 0 : 0.6, ease: [0.2, 0, 0, 1] }}
        >
          <h1>Thought Palace</h1>
          <hr aria-hidden />
          <div className="palace-search">
            <Search size={17} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder={scope === "room" ? `Search ${roomName.toLowerCase()}` : "Search"}
              aria-label={scope === "room" ? `Search ${roomName}` : "Search the whole palace"}
              style={{ pointerEvents: "auto" }}
            />
          </div>
          <div className="palace-search-scope" role="radiogroup" aria-label="Where to search">
            {(
              [
                ["palace", "All of the palace"],
                ["room", roomName],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                onClick={() => onScope(value)}
                style={{ pointerEvents: "auto" }}
              >
                {label}
              </button>
            ))}
          </div>
        </motion.div>
      </div>

      <div className="palace-explore-anchor" data-exploring={exploring}>
        <button
          type="button"
          className="palace-explore"
          onClick={() => onExplore(!exploring)}
          aria-pressed={exploring}
          style={{ pointerEvents: "auto" }}
        >
          <ChevronUp
            size={17}
            aria-hidden
            style={{ transform: exploring ? "rotate(180deg)" : "none" }}
          />
          {exploring ? "Return to the desk" : "Explore the palace"}
        </button>
      </div>
    </>
  );
}
