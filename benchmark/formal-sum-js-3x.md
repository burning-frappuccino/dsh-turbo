# DSH OVERDRIVE three-arm benchmark

Generated 2026-10-23T14:08:06.341Z on DSH 0.2.0-rc.2, catalog `benchmark/tasks.json`, 1 tasks × 3 repeat(s), Latin-square interleaved arms.
Latency and token aggregates include machine-validated runs only. Task deltas include only rounds where every requested arm passed.

| arm | runs | passed | median | mean | p90 | first token p50 | steps | tools | max calls/step | runs with parallel step | input tok | output tok | reasoning tok | cache read tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | 3 | 3/3 | 31413 ms | 33270 ms | 37481 ms | 3603 ms | 11 | 11 | null | 0/3 | 2940 | 3417 | 0 | 87592 |
| fast | 3 | 3/3 | 41606 ms | 37664 ms | 47248 ms | 3099 ms | 14 | 13 | null | 0/3 | 3421 | 3422 | 0 | 119125 |
| max | 3 | 3/3 | 28625 ms | 38874 ms | 67102 ms | 3420 ms | 11 | 11 | null | 0/3 | 3391 | 4062 | 0 | 107605 |

| task | valid paired rounds | default | fast | fast Δ | max | max Δ |
|---|---|---|---|---|---|---|
| sum-js | 3 | 31413 ms | 41606 ms | 32.4% | 28625 ms | -8.9% |
