# Changelog

## 0.1.4 — 2026-10-23

First public release.

- Adds a native Web UI Turbo toggle for each DSH session.
- Applies a Host-authoritative runtime execution policy without replacing the agent loop.
- Persists per-session state and exposes revision-safe Host endpoints.
- Adds optional request-level reasoning-effort control with refusal-safe fallback.
- Replaces the technical `?` popup with a user-facing benefit summary and test invitation.
- Documents a single same-prompt UI pilot: 29% less elapsed time, 51% lower displayed token usage, and 42% fewer steps/tool calls. This is pilot evidence, not a universal performance guarantee.
- Includes 40 automated tests, reproducible benchmark tooling and generated runtime bundles.
