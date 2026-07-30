// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Type-aware, but scoped to two async-safety rules only — see #85: the
  // full recommendedTypeChecked ruleset OOM-killed the lint run on this
  // monorepo's dependency graph well past the ~1min CI budget (#47), so we
  // pay type info's cost for just the rules that catch missed `await`.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./packages/kernel/tsconfig.eslint.json", "./packages/mori/tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  eslintConfigPrettier,
);
