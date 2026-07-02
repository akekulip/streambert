# autoresearch — recs-engine-v2

## Goal
Maximize `hit_rate_at_20` on `server/lib/recommendations.js`. Higher is better.

## What the Agent Can Change
- Only `server/lib/recommendations.js` — this is the single file being optimized.
- Everything inside that file is fair game unless constrained below.

## What the Agent Cannot Change
- The evaluation script (`evaluate.py` or the eval command). It is read-only.
- Dependencies — do not add new packages or imports that aren't already available.
- Any other files in the project unless explicitly noted here.
- Additional constraints: eval/recs/ (harness + fixtures) is READ-ONLY. The module must stay pure CommonJS: no network, DB, fs, or new dependencies — TMDB data only via the injected fetchTmdb, and only paths present in fixtures/tmdb-cache.json exist (recommendations, similar, details for history titles; trending/top_rated/popular lists; discover pages). Keep the exported signature recommend({history, fetchTmdb, limit, now}) stable so app integration stays possible. Never call Date.now() — always use the injected now.

## Strategy
1. First run: establish baseline. Do not change anything.
2. Profile/analyze the current state — understand why the metric is what it is.
3. Try the most obvious improvement first (low-hanging fruit).
4. If that works, push further in the same direction.
5. If stuck, try something orthogonal or radical.
6. Read the git log of previous experiments. Don't repeat failed approaches.

## Simplicity Rule
A small improvement that adds ugly complexity is NOT worth it.
Equal performance with simpler code IS worth it.
Removing code that gets same results is the best outcome.

## Stop When
You don't stop. The human will interrupt you when they're satisfied.
If no improvement in 20+ consecutive runs, change strategy drastically.

## Learnings (updated 2026-07-02)

**Metric v2 (2026-07-02):** primary metric changed from `hit_rate_at_20` to
`row_score` = 0.6*hit@20 + 0.4*hit@10 (synthetic users only). Rationale: pure
hit@20 rewarded reorderings that buried good picks below position 10, and
synthetic-only keeps the metric comparable when real-user fixtures land
(`real_row_score` is tracked separately). results.tsv was reset; pre-reset
history under the old metric:

| run | hit@20 | status  | change |
|-----|--------|---------|--------|
| 1   | 0.8750 | keep    | baseline: v1 port (seed-concat union) |
| 2   | 0.7333 | discard | round-robin interleave of seed lists |
| 3   | 0.8833 | keep    | consensus-weighted ranking, linear decay (hit@10 fell 0.867→0.808) |
| 4   | 0.8833 | discard | genre-affinity exploration slots (tie; displaced tail hits) |

**Patterns:**
- Recency dominance is signal: the newest seed's recommendations predict the
  next watch far better than older seeds. Never dilute its top ranks.
- Cross-seed consensus recovers deep-tail titles but must not reshuffle the
  newest seed's top picks (hit@10 regression in run 3).
- ~12 of 120 synthetic holdouts are pure taste-jumps (fresh popular titles
  outside every seed's rec/similar lists) — only global trending/popular or
  genre-discover data can reach them; exploration must not displace strong
  personalized picks.
