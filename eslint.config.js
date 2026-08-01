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
// `boundaries()` below exists to make that re-listing the only way to write a
// block: it emits `no-restricted-imports` AND `no-restricted-syntax` together
// from one boundary list, so a block can never re-list one and silently drop
// the other. `no-restricted-globals` is a separate key that no block overrides,
// so the kernel's bare-`fetch` ban survives without re-listing.
//
// Each boundary is a REGEX over the import specifier string, not a glob (#134).
// Two reasons, both load-bearing:
//   - one string drives both gates. `no-restricted-imports` only inspects
//     static `ImportDeclaration`/`Export*Declaration`, so `await import("...")`
//     walked straight through every boundary here (measured on eslint 10.8.0:
//     exit 0). The dynamic half is `no-restricted-syntax` on `ImportExpression`,
//     generated from the same regex so the two cannot drift apart.
//   - globs matched too much. `**/services/**` matches the *specifier text*,
//     so an unrelated external package (`@vendor/services/client`) was rejected
//     for merely having "services" in its path. The layer regexes below anchor
//     to a relative specifier (`../services/...`) or to an explicit in-repo
//     path, which no external package subpath can look like.
// Known limit: only literal specifiers are visible to either gate —
// `import(someVariable)` is not statically analyzable and is not covered.

// Layer reaches are written relative (`../services/x.js`) inside a package;
// the `packages/<pkg>/src/<layer>/` alternative keeps the in-repo path form
// covered too, mirroring how NOT_MORI already spells out `packages/mori/`.
const layerReach = (pkg, dirs) => {
  const alt = dirs.join("|");
  return `^\\.{1,2}/(?:\\.\\./)*(?:${alt})/|(?:^|/)packages/${pkg}/src/(?:${alt})/`;
};

const NOT_KERNEL_INTERNALS = {
  // `@mori/kernel` (the public entry) stays allowed; `@mori/kernel/anything`
  // does not. The second alternative closes the relative reach Codex found:
  // `../../../kernel/dist/services/...` resolves to the same internals but
  // matched no pattern. It requires the `src`/`dist` segment so mori's own
  // local wiring dir (`../kernel/index.js`) is untouched.
  regex: "^@mori/kernel/|(?:^|/)(?:packages/)?kernel/(?:src|dist)/",
  message:
    "Import the kernel's public entry point (`@mori/kernel`) only — internal paths (`@mori/kernel/src/...`, or a relative reach like `../../kernel/dist/...`) are not a stable surface.",
};

const NOT_MORI = {
  regex: "^@shakystar/mori(?:/|$)|(?:^|/)packages/mori/|(?:^|/)mori/(?:src|dist)/",
  message:
    "kernel must not depend on mori (the host harness) — the dependency is host -> kernel only, never the reverse.",
};

const DOMAIN_NOT_UPPER_LAYERS = {
  regex: layerReach("kernel", ["storage", "projections", "services"]),
  message:
    "domain is the kernel's core model — storage/projections/services depend on it, not the reverse.",
};

const STORAGE_NOT_UPPER_LAYERS = {
  regex: layerReach("kernel", ["projections", "services"]),
  message:
    "storage sits below projections/services in the kernel's layering — it must not import from them.",
};

const PROJECTIONS_NOT_UPPER_LAYERS = {
  regex: layerReach("kernel", ["services"]),
  message: "projections sit below services — services orchestrate projections, not the reverse.",
};

const SHARED_NOT_ANY_LAYER = {
  regex: layerReach("kernel", ["domain", "storage", "projections", "services"]),
  message:
    "shared is a dependency-free utility layer used by every other kernel layer — it must not import from any of them.",
};

const NOT_AGENT_OR_CLI = {
  regex: layerReach("mori", ["agent", "cli"]),
  message: "tools/auth/external are leaf adapters — agent/cli wire them, not the reverse.",
};

const NOT_CLI = {
  regex: layerReach("mori", ["cli"]),
  message: "agent sits below cli in mori's layering — cli composes agent, not the reverse.",
};

const KERNEL_NO_NETWORK =
  "kernel must not perform network I/O — network access belongs behind mori's injected Embedder/ConsolidatorLlm seams (#82).";

// `no-restricted-globals` only reports bare identifier references, so
// `globalThis.fetch(url)` and `const { fetch } = globalThis` — the ordinary
// Node spellings — walked past the network ban (#134). These cover the member
// and destructuring paths; both `globalThis` and Node's `global` alias.
const KERNEL_NO_NETWORK_SYNTAX = [
  {
    selector:
      'MemberExpression[object.name=/^(?:globalThis|global)$/]:matches([property.name="fetch"], [property.value="fetch"])',
    message: KERNEL_NO_NETWORK,
  },
  {
    selector:
      'VariableDeclarator[init.name=/^(?:globalThis|global)$/] > ObjectPattern > Property:matches([key.name="fetch"], [key.value="fetch"])',
    message: KERNEL_NO_NETWORK,
  },
];

// esquery reads `/.../` as a regex literal terminated by the first unescaped
// slash, so path separators have to be escaped going in.
const asDynamicImport = ({ regex, message }) => ({
  selector: `ImportExpression[source.value=/${regex.replace(/\//g, "\\/")}/]`,
  message,
});

// The only way to declare a block's boundaries: static and dynamic gates are
// emitted as a pair from one list, so neither can be re-listed without the
// other. `extraSyntax` carries non-import bans that must survive the same
// per-block re-listing (the kernel's fetch selectors).
const boundaries = (list, extraSyntax = []) => ({
  "no-restricted-imports": ["error", { patterns: list }],
  "no-restricted-syntax": ["error", ...list.map(asDynamicImport), ...extraSyntax],
});

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
    rules: boundaries([NOT_KERNEL_INTERNALS]),
  },
  // The kernel is the replaceable core; mori is one harness wiring it up (see
  // packages/kernel/src/index.ts). The dependency is host -> kernel, never
  // kernel -> host. This is the base rule for every kernel file; the more
  // specific layering blocks below each repeat it (see note above).
  {
    files: ["packages/kernel/**/*.ts"],
    rules: {
      ...boundaries([NOT_MORI], KERNEL_NO_NETWORK_SYNTAX),
      // Kernel network boundary: the injected Embedder/ConsolidatorLlm seams
      // (#82) exist precisely so the kernel never talks to the network
      // directly. `fetch` is unused in the kernel today, so this closes the
      // door before anything reopens it. This key is set here only — no block
      // below overrides it, so it applies to every kernel file. The member and
      // destructuring spellings ride in KERNEL_NO_NETWORK_SYNTAX instead,
      // which every kernel block must re-list (see note at the top).
      "no-restricted-globals": ["error", { name: "fetch", message: KERNEL_NO_NETWORK }],
    },
  },
  // Kernel internal layering: domain (core model) < storage < projections <
  // services (orchestration). Each layer may depend on the ones below it, not
  // above — `shared` is dependency-free and used by all of them.
  {
    files: ["packages/kernel/src/domain/**/*.ts"],
    rules: boundaries([NOT_MORI, DOMAIN_NOT_UPPER_LAYERS], KERNEL_NO_NETWORK_SYNTAX),
  },
  {
    files: ["packages/kernel/src/storage/**/*.ts"],
    rules: boundaries([NOT_MORI, STORAGE_NOT_UPPER_LAYERS], KERNEL_NO_NETWORK_SYNTAX),
  },
  {
    files: ["packages/kernel/src/projections/**/*.ts"],
    rules: boundaries([NOT_MORI, PROJECTIONS_NOT_UPPER_LAYERS], KERNEL_NO_NETWORK_SYNTAX),
  },
  {
    files: ["packages/kernel/src/shared/**/*.ts"],
    rules: boundaries([NOT_MORI, SHARED_NOT_ANY_LAYER], KERNEL_NO_NETWORK_SYNTAX),
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
    rules: boundaries([NOT_KERNEL_INTERNALS, NOT_AGENT_OR_CLI]),
  },
  {
    files: ["packages/mori/src/agent/**/*.ts"],
    rules: boundaries([NOT_KERNEL_INTERNALS, NOT_CLI]),
  },
  eslintConfigPrettier,
);
