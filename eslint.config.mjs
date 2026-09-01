import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/target/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts"],
  })),
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts"],
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
    files: ["apps/**/*.ts", "packages/**/*.ts"],
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
);
