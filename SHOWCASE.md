# Showcase: real migrations, real diffs

Runs of bumpwright on forks of well-known open-source repos. Every diff below was
produced by `bumpwright <pkg> --test <cmd>` with no manual edits, then verified by
running the repo's own lint/test suite.

## Express: ESLint 8.47 → 9.39 (flat config migration)

- **Diff:** https://github.com/nipunhsud/express/compare/master...bumpfix/eslint-9
- **Command:** `bumpwright eslint@9 --test "npm run lint"`
- **What broke:** ESLint 9 drops `.eslintrc.yml`/`.eslintignore` entirely and
  changes the `no-unused-vars` default for `catch` bindings.
- **What the agent did (2 fix iterations):** wrote a direct flat
  `eslint.config.js` translation (rules, ES2022, Node globals via the `globals`
  package, ignore list folded in), deleted the two legacy files, then restored
  ESLint 8's `caughtErrors: 'none'` behavior after the second red run.
- **Result:** lint green, all 1,261 Express tests passing, zero source files
  touched.

## ottehr (healthcare OSS): vite 6.3 → 8.3 + @types/node 18 → 22

- **PR (upstream, addresses their #9419):** https://github.com/masslight/ottehr/pull/9625
- **What broke:** vite 8's peer range conflicts with the repo's @types/node ^18
  pin (npm refuses the install — the classic red-Dependabot failure), and
  vite 8's types are exports-only, invisible to node10 resolution.
- **Result:** companion bump first, then vite; 22/22 turbo build + lint tasks
  green. This run is why bumpwright now does companion bumps automatically.

## SDEverywhere (climate modeling, pnpm monorepo): vite 7 → 8

- **Branch:** https://github.com/nipunhsud/SDEverywhere/compare/main...bumpfix/vite-8
- **Findings report on their #906:** four packages plus the Svelte vite-plugin
  companion migrated green; the finish is blocked by plugin-check overriding
  vite's internal `vite:resolve` plugin, which vite 8's Rolldown core removed.
- **The honest lesson:** bumpwright reached green on everything a dependency bump
  can fix, and correctly refused to ship the part that needs a real rework.
  Red that never ships is the feature.*
