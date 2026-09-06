import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // vite.config.ts is Vite's own loader config, not part of the apps/web
    // TypeScript project (its "include" is src/** only) — nothing else under
    // apps/** sits outside its project's include, so this is the one exception.
    ignores: ["**/dist/**", "**/node_modules/**", "**/target/**", "apps/web/vite.config.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "tests/**/*.ts"],
  })),
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:sqlite",
              message:
                "Import the database through apps/core/src/db/connection.ts — it is the only module that may name the driver.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/core/src/db/connection.ts", "apps/core/src/db/sqlite-availability.test.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // The E2E suite is plain Node ESM driving a browser. `document` belongs to
    // neither environment exactly: those callbacks are written here but execute
    // inside the page, so the file legitimately names both sets of globals.
    files: ["apps/web/e2e/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        document: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
);
