// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

// Module-boundary gate (#55), locking in the structure #51-#54 cleaned up.
// Plain ESLint core rules (no plugin, no separate CI step) — cheapest way to
// hold the ~1min CI budget (#47/#69) while still failing the build on a
// violation. Each group below is one forbidden dependency direction, with its
// own one-line `message` explaining what it violates and why.
//
// IMPORTANT: flat config does not merge `rules` objects across matching
// blocks — for a given file, the *last* matching block that sets a rule key
// wins outright, it does not concatenate with earlier blocks' patterns. So
// every block below re-lists the full pattern set that applies to its files
// (e.g. the domain block repeats NOT_MORI alongside its own layering rule)
// instead of relying on an earlier, more general block to add to it.

const NOT_KERNEL_INTERNALS = {
  group: ["@mori/kernel/*"],
  message:
    "Import the kernel's public entry point (`@mori/kernel`) only — internal paths (`@mori/kernel/src/...`) are not a stable surface.",
};

const NOT_MORI = {
  group: ["@shakystar/mori", "@shakystar/mori/*", "**/packages/mori/**", "**/mori/src/**"],
  message:
    "kernel must not depend on mori (the host harness) — the dependency is host -> kernel only, never the reverse.",
};

const DOMAIN_NOT_UPPER_LAYERS = {
  group: ["**/storage/**", "**/projections/**", "**/services/**"],
  message:
    "domain is the kernel's core model — storage/projections/services depend on it, not the reverse.",
};

const STORAGE_NOT_UPPER_LAYERS = {
  group: ["**/projections/**", "**/services/**"],
  message:
    "storage sits below projections/services in the kernel's layering — it must not import from them.",
};

const PROJECTIONS_NOT_UPPER_LAYERS = {
  group: ["**/services/**"],
  message: "projections sit below services — services orchestrate projections, not the reverse.",
};

const SHARED_NOT_ANY_LAYER = {
  group: ["**/domain/**", "**/storage/**", "**/projections/**", "**/services/**"],
  message:
    "shared is a dependency-free utility layer used by every other kernel layer — it must not import from any of them.",
};

const NOT_AGENT_OR_CLI = {
  group: ["**/agent/**", "**/cli/**"],
  message: "tools/auth/external are leaf adapters — agent/cli wire them, not the reverse.",
};

const NOT_CLI = {
  group: ["**/cli/**"],
  message: "agent sits below cli in mori's layering — cli composes agent, not the reverse.",
};

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
  // mori (the host) may depend on the kernel only through its public entry
  // point — `@mori/kernel/src/...` would reach past the package's declared
  // `exports` and couple the host to internals that can move freely.
  {
    files: ["packages/mori/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_KERNEL_INTERNALS] }],
    },
  },
  // The kernel is the replaceable core; mori is one harness wiring it up (see
  // packages/kernel/src/index.ts). The dependency is host -> kernel, never
  // kernel -> host. This is the base rule for every kernel file; the more
  // specific layering blocks below each repeat it (see note above).
  {
    files: ["packages/kernel/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_MORI] }],
      // Kernel network boundary: the injected Embedder/ConsolidatorLlm seams
      // (#82) exist precisely so the kernel never talks to the network
      // directly. `fetch` is unused in the kernel today, so this closes the
      // door before anything reopens it.
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "kernel must not perform network I/O — network access belongs behind mori's injected Embedder/ConsolidatorLlm seams (#82).",
        },
      ],
    },
  },
  // Kernel internal layering: domain (core model) < storage < projections <
  // services (orchestration). Each layer may depend on the ones below it, not
  // above — `shared` is dependency-free and used by all of them.
  {
    files: ["packages/kernel/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_MORI, DOMAIN_NOT_UPPER_LAYERS] }],
    },
  },
  {
    files: ["packages/kernel/src/storage/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_MORI, STORAGE_NOT_UPPER_LAYERS] }],
    },
  },
  {
    files: ["packages/kernel/src/projections/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_MORI, PROJECTIONS_NOT_UPPER_LAYERS] }],
    },
  },
  {
    files: ["packages/kernel/src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_MORI, SHARED_NOT_ANY_LAYER] }],
    },
  },
  // mori internal layering: tools/auth/external are leaf adapters; agent
  // wires them together; cli composes agent (+ tools/auth directly) into the
  // prompt loop. Leaves must not import the layers that wire them. Each block
  // repeats NOT_KERNEL_INTERNALS alongside its own layering rule (see note
  // above on why the base mori block above doesn't cover these files too).
  {
    files: [
      "packages/mori/src/tools/**/*.ts",
      "packages/mori/src/auth/**/*.ts",
      "packages/mori/src/external/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_KERNEL_INTERNALS, NOT_AGENT_OR_CLI] }],
    },
  },
  {
    files: ["packages/mori/src/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOT_KERNEL_INTERNALS, NOT_CLI] }],
    },
  },
  eslintConfigPrettier,
);
