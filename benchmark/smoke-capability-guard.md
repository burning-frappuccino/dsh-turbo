# DSH OVERDRIVE three-arm benchmark

Generated 2026-11-04T11:11:56.193Z on DSH 0.2.0-rc.2, catalog `benchmark/tasks.json`, 1 tasks × 1 repeat(s), Latin-square interleaved arms.
Latency and token aggregates include machine-validated runs only. Task deltas include only rounds where every requested arm passed.

> Smoke test only: this single run verifies that the exact-model capability gate still allows supported Fast (`low`) and Max (`high`) requests. It is not evidence of a fixed speedup or token saving.

| arm | runs | passed | median | mean | p90 | first token p50 | steps | tools | max calls/step | runs with parallel step | input tok | output tok | reasoning tok | cache read tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fast | 1 | 1/1 | 22701 ms | 22701 ms | 22701 ms | 6292 ms | 9 | 8 | null | 0/1 | 9087 | 1315 | 0 | 60032 |
| max | 1 | 1/1 | 57612 ms | 57612 ms | 57612 ms | 3355 ms | 17 | 16 | null | 0/1 | 11548 | 6553 | 0 | 166784 |

| task | valid paired rounds | default | fast | fast Δ | max | max Δ |
|---|---|---|---|---|---|---|
| sum-js | 1 | n/a ms | 22701 ms | n/a | 57612 ms | n/a |
