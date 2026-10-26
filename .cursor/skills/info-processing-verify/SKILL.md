---
name: info-processing-verify
description: Run the info-processing test suite before changing CLI flags, the agy argv, package.json test, or the GitHub Actions workflow. Use when editing src/cli-tool.ts, src/llm/runners.ts, tests, or .github/workflows/test.yml.
---

# info-processing verify

## When to run

Run this from the repository root before committing a change that touches any of:

- `src/cli-tool.ts` or an `agy` argv list in `src/llm/runners.ts`
- `tests/*.test.mjs`
- the `test` script in `package.json`
- `.github/workflows/test.yml`

Also run it when a pull request claims the suite is green.

## Commands

Node.js 22 or newer, from the repository root:

```bash
npm ci
npm test
```

`npm test` is `node --test tests/*.test.mjs && vitest run`. node:test runs `tests/conversation-knowledge.test.mjs` and `tests/cli-tool.test.mjs`. Vitest runs `tests/snapshots.snap.test.ts`, which prints CLI flag combinations and the capture → distill → search report as inline snapshots. `.github/workflows/test.yml` runs the same `npm test`.

## What failure means

- The assertion message `fix: use --sandbox instead of --mode plan` means `--mode plan` was combined with `--disable-slash-commands`. That pair is a no-op: agy ignores plan mode when slash commands are disabled. `new CliInvocation` throws `IncompatibleFlagsError`, and the type of that argv is `{ fix: "use --sandbox instead of --mode plan" }` rather than a string array. Pass `--sandbox` and do not pass `--mode plan`. This is the failure recorded in commit `e5da1d4`.
- A `conversation-knowledge` failure means review-gated candidate ingest broke: approve, reject, duplicate detection, or the path check on candidate ids.
- An inline snapshot mismatch means a sample's readable output changed. Read the diff before updating it with `npx vitest run -u`.
- Output `Error: no test specified` with exit code 1 means `package.json` `test` is not `node --test tests/*.test.mjs && vitest run`. The files under `tests/` did not run.
- A red `test` check on a pull request is the same `npm test` failure in GitHub Actions. Do not merge on a script that only echoes an error.
