# DSH OVERDRIVE three-arm benchmark

Generated 2026-10-23T13:45:08.556Z on DSH 0.2.0-rc.2, catalog `benchmark/tasks-overdrive.json`, 1 tasks × 1 repeat(s), Latin-square interleaved arms.
Latency and token aggregates include machine-validated runs only. Task deltas include only rounds where every requested arm passed.

| arm | runs | passed | median | mean | p90 | first token p50 | steps | tools | max calls/step | runs with parallel step | input tok | output tok | reasoning tok | cache read tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | 1 | 1/1 | 91063 ms | 91063 ms | 91063 ms | 2503 ms | 23 | 33 | null | 0/1 | 10041 | 10539 | 0 | 307840 |
| fast | 1 | 1/1 | 50595 ms | 50595 ms | 50595 ms | 2216 ms | 16 | 20 | null | 0/1 | 5336 | 5992 | 0 | 165888 |
| max | 1 | 1/1 | 94827 ms | 94827 ms | 94827 ms | 3432 ms | 23 | 29 | null | 0/1 | 17303 | 11782 | 0 | 344832 |

| task | valid paired rounds | default | fast | fast Δ | max | max Δ |
|---|---|---|---|---|---|---|
| regional-totals | 1 | 91063 ms | 50595 ms | -44.4% | 94827 ms | 4.1% |
