# Showcase: real migrations, real diffs

Runs of bumpfix on forks of well-known open-source repos. Every diff below was
produced by `bumpfix <pkg> --test <cmd>` with no manual edits, then verified by
running the repo's own lint/test suite.

## Express: ESLint 8.47 → 9.39 (flat config migration)

- **Diff:** https://github.com/nipunhsud/express/compare/master...bumpfix/eslint-9
- **Command:** `bumpfix eslint@9 --test "npm run lint"`
- **What broke:** ESLint 9 drops `.eslintrc.yml`/`.eslintignore` entirely and
  changes the `no-unused-vars` default for `catch` bindings.
- **What the agent did (2 fix iterations):** wrote a direct flat
  `eslint.config.js` translation (rules, ES2022, Node globals via the `globals`
  package, ignore list folded in), deleted the two legacy files, then restored
  ESLint 8's `caughtErrors: 'none'` behavior after the second red run.
- **Result:** lint green, all 1,261 Express tests passing, zero source files
  touched.

*More runs coming: Vite major bumps and React 19 migrations on repos with open
upgrade issues.*
