# Incremental optimization validation — 2026-10-24

Runtime: DSH 0.2.0-rc.2, `deepseek-official/deepseek-flash`.

## Accepted

- Metrics now count Default and Turbo steps consistently.
- Verification detection recognizes `ops_bash` plus Python `unittest` commands.
- Fast policy now asks the model to keep planning compact and put implementation into tool calls.
- The `orders-py` regression task preserves the workload that exposed the 8,000-token step.

All repository tests pass: 46/46.

| workload | Default | Fast | pass | note |
|---|---:|---:|---:|---|
| `sum-js`, 3 rounds | 35.1 s median | 20.5 s median | 3/3 each | compact-planning sweep |
| `regional-totals`, 2 rounds | 106.3 s median | 85.8 s median | 2/2 each | compact-planning sweep |
| `orders-py`, 2 Fast rounds | — | 37.2 s median | 2/2 | exact regression workload |

Provider variance remains large, so these numbers validate non-regression rather than a fixed speedup claim.

## Rejected and reverted

A Fast-only `maxTokens: 4096` request cap reduced time and output tokens on small tasks, but `orders-py` ended with `turnEnd: "max-tokens"` and passed only 1/2 runs. The cap was fully reverted. Response-length limits must not be used as a hard optimization until the harness can continue a truncated step safely.
