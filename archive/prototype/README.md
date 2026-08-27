# Prototype (klar-era, March 2026)

The original standalone prototype, built under the working name **klar**: an
AI-native intermediate representation authored through a fluent builder API,
checked, projected into six human-readable views, and transpiled to a Hono
server.

It is kept for provenance. **Nothing in `src/` imports it**, and it is not
maintained. `output/` holds the demo artifacts it produced.

The ideas that carried forward into the current tool, rewritten rather than
reused:

- the effect taxonomy (`EffectKind`) — now recovered from real code by an
  analyzer rather than declared by an author
- the proof kinds (`by_constraint`, `by_human`) — now the evidence tiers
  (`verified`, `inferred`, `model`)
- the six projections (PLP) — now the report lenses
- the change journal — now the finding set

See `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`.
