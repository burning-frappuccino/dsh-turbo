# Prompt policy v2 — draft (not yet applied)

Observation from sweep 1: on `fix-offbyone`, default took 98s / 24 tool calls and
passed, while turbo took 25s / 8 tool calls and failed. The likely cause is that
v1's "skip optional tests" clause removed the model's own proof step on a change
it could not verify by reading.

The brief requires keeping verification that an explicit acceptance condition
depends on (§2.2 阶段 D), so v2 states the *cheapest proof* rule explicitly
instead of leaving it to the model's judgement.

Proposed addition, placed after the "Do not open optional review" paragraph:

```
Before you call a code change finished, run the single cheapest check that would
catch a wrong result — one test file, one typecheck, or one script that exercises
the change. That check is part of finishing the task, not an optional stage.
```

and the tests paragraph becomes:

```
Do not start full suites, builds, formatters, or linters that the user did not ask
for and that the acceptance criteria do not require. One targeted check is not a
suite.
```

Plan: apply to `src/prompts/turbo-policy.ts`, rebuild, run a second sweep over the
task subset that failed or diverged (`--tasks fix-offbyone,fix-async,fix-import,
retry-js,todo-list,parse-json`), and compare pass rate + wall clock against sweep 1.
