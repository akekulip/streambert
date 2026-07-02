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
