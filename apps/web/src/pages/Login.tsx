import { corner, depth, material, semantic, spacing, typography } from "@noctis/ui";
import { useState } from "react";

import { LoginRefused, login } from "../session/login.js";

/**
 * The front door: the one screen a page with no token can draw.
 *
 * The token is typed once, posted once, and forgotten — it is never written to
 * `localStorage`, `sessionStorage`, a cookie, or a URL, and the input is
 * cleared on a refusal so a retry does not leave the last attempt sitting in a
 * field. What survives is the CSRF value the core issues, held in React state
 * above this component; the credential itself is the `HttpOnly` cookie, which
 * script cannot read at all.
 */

export interface LoginProps {
  baseUrl: string;
  onAuthenticated: (csrf: string) => void;
}

export function Login({ baseUrl, onAuthenticated }: LoginProps): JSX.Element {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);

    try {
      const { csrf } = await login(baseUrl, token);

      setToken("");
      setError(undefined);
      onAuthenticated(csrf);
    } catch (failure: unknown) {
      setToken("");
      setError(
        failure instanceof LoginRefused
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : "The core could not be reached",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        display: "flex",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
        background: depth.floor,
        color: typography.color.primary,
        fontFamily: typography.family,
        padding: spacing.lg,
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        style={{
          display: "grid",
          gap: spacing.md,
          width: "100%",
          maxWidth: 360,
          border: `1px solid ${material.border}`,
          borderRadius: corner.md,
          background: material.fill,
          padding: spacing.lg,
        }}
      >
        <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
          Noctis
        </h1>
        <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
          The token is exchanged once for a session this browser keeps. Noctis does not store it —
          your browser may offer to, the way it would any password.
        </p>

        <label style={{ display: "grid", gap: spacing.xs }}>
          <span>Core token</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
            style={{
              background: material.fillElevated,
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              color: "inherit",
              font: "inherit",
              padding: spacing.xs,
            }}
          />
        </label>

        <div>
          <button
            type="submit"
            disabled={busy || token === ""}
            style={{
              background: material.fillElevated,
              color: "inherit",
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
              cursor: busy || token === "" ? "default" : "pointer",
            }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>

        {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
      </form>
    </main>
  );
}
