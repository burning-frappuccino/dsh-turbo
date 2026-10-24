# Changelog

## 0.2.3 — 2026-10-24

- Counts model steps in both default and Turbo modes so ON/OFF comparisons use the same metric.
- Recognizes `ops_bash` and Python `unittest` runs in verification evidence.
- Keeps Turbo planning compact and moves implementation into tool calls sooner.
- Adds an `orders-py` regression benchmark and documents the measured, non-guaranteed results.
- Documents the GitHub/market installation path to avoid the unrelated npm package with the same name.

## 0.2.1 — 2026-10-23

- Adopts **DSH OVERDRIVE** as the public product name and the tagline “少走弯路，火力全开”。
- Keeps the package id, plugin id, API routes and repository URL as `dsh-turbo` for compatibility.
- Updates the composer and result panel branding without changing Fast/Max behavior.

## 0.2.0 — 2026-10-23

- Adds a draggable two-position Fast/Max gear control while preserving the Turbo OFF fallback.
- Fast keeps the existing low-cost direct path; Max permits extra token/tool spend for parallel context gathering and independent work.
- Makes the gear Host-authoritative, revision-guarded and persistent per session; version 1 state migrates to Fast automatically.
- Adds separate Fast/Max reasoning-effort configuration and records the selected gear in execution evidence.
- Expands the suite from 40 to 44 automated tests, including gear migration, conflicts, Max policy rendering and request behavior.

## 0.1.4 — 2026-10-23

First public release.

- Adds a native Web UI Turbo toggle for each DSH session.
- Applies a Host-authoritative runtime execution policy without replacing the agent loop.
- Persists per-session state and exposes revision-safe Host endpoints.
- Adds optional request-level reasoning-effort control with refusal-safe fallback.
- Replaces the technical `?` popup with a user-facing benefit summary and test invitation.
- Documents a single same-prompt UI pilot: 29% less elapsed time, 51% lower displayed token usage, and 42% fewer steps/tool calls. This is pilot evidence, not a universal performance guarantee.
- Includes 40 automated tests, reproducible benchmark tooling and generated runtime bundles.
