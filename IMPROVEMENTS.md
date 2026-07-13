# IMPROVEMENTS.md — ML scoring: goal, metrics, and the road ahead

## The goal

The Match Score (Potential col K) should converge on one number: **the
probability that Eric actually applies to this job**. Everything in the ML
pipeline serves that:

- **Anchor** — a prior that works with zero labels. Today that's the
  hand-edited `rubric.yml` (preferred domains, titles, keyword buckets, YOE
  gate), which replaced plain resume-cosine after eval showed it ranks real
  applies ~2.2× higher.
- **Feedback model** — a logistic-regression head on MiniLM embeddings,
  retrained on every `/apply` run from apply/ignore labels. Its influence
  ramps with data: `score = (1−α)·anchor + α·modelProb`, `α = min(0.7,
  nLabels/200)`.

The optimization loop is: change one thing → measure on stored labels →
adopt only if it wins. Nothing ships on intuition; several intuitive ideas
(below) lost to the data.

## The metrics

Two questions, two metric sets (full detail in README → "Evaluation metrics"):

| Question | Harness | Metrics |
|---|---|---|
| Is the feedback model learning? | `node src/train.mjs` | Precision & recall on the positive class, stratified 80/20 holdout, judged over ~7 seeded splits (never accuracy — 9% positive rate makes it meaningless) |
| Does the anchor rank well? | `node scripts/eval-rubric.mjs` | **Mean positive rank** (primary target; random ≈ 196) + precision@25/@50 (top-of-sheet sanity check) |

**Decision rule:** adopt only changes that move mean rank ~10%+ with
flat-or-better precision@25. Reject trades that improve the middle of the
ranking while degrading the top. At 36 positives, small deltas are noise.

**Current state (2026-07-12):** anchor mean rank **80.8** vs resume 178.7;
p@25 40% vs 20%; p@50 32% vs 12%. Feedback model: precision 21.6% / recall
65.3% on holdout, 36 pos / 355 neg labels.

## Tried and rejected (don't re-litigate without new data)

- **Structured features** (YOE/intern/remote flags alongside embeddings) — hurt recall even after scaling.
- **Hard-negative weighting** in the LR loss — crashed recall 65% → 25%.
- **Phrase-level domain embeddings** — lost ~18 rank points, twice-confirmed.
- **Additive/top-2/mean/softmax domain aggregation** — max-over-domains wins every time.
- **Per-keyword statistical weights** — low-count weights flip sign under resampling; cost 8 pts of p@25.
- **Continuous anti-preference penalty** — safe but ~zero gain on current data.
- **Positive keyword tuning** — pure noise at 36 applies (negative keywords at high counts are real signal).

## Future improvements worth implementing

Ordered roughly by expected value per unit effort.

### 1. More labels (the boring one that beats everything)
Every experiment above is starved at 36 positives. Each `/apply` cycle adds
labels for free; at ~100 positives, α reaches its 0.7 cap, holdout metrics
stabilize, and several rejected ideas (per-keyword weights with a
`totalHit ≥ 25` floor, anti-preferences, joint interactions) deserve a
re-test. **Action:** none — just keep using the pipeline, and re-run
`eval-rubric.mjs` + a 7-seed `train.mjs` sweep at 75 and 100 positives.

### 2. Upgrade the embedding model
all-MiniLM-L6-v2 (2021, 384-dim) is the floor of modern sentence encoders.
`bge-small-en-v1.5` or `gte-small` are drop-in @xenova/transformers swaps
(same dims, similar latency) that score meaningfully higher on retrieval
benchmarks. Requires re-embedding the rubric + stored training texts (all
snapshotted in `data/training-data.json`, so this is cheap) and re-running
both harnesses. The stored `embedding` fields must be versioned or
regenerated — add a `model` field to the store to prevent mixing vector
spaces.

### 3. Pairwise / ranking loss for the feedback head
We evaluate by ranking but train by classification. A pairwise logistic loss
(RankNet-style: for each apply/ignore pair, push the apply's score higher)
optimizes what we actually measure, and 36 × 355 ≈ 12.8k pairs is far more
training signal than 391 independent points. Still pure JS, still <1s.

### 4. Score calibration + confidence display
The blended score is a rank, not a probability. Platt-scale it on holdout
predictions so "8/10" means something stable across retrains, and surface
low-confidence scores (few similar training examples) differently in the
sheet — e.g. a `?` suffix when the nearest labeled neighbor is far away.

### 5. Time-decayed labels
Preferences drift (the kubernetes/devops stated-vs-revealed tension is
already documented). Weight training labels by recency — e.g. half-life of
~6 months on `labeledAt` — so the model tracks current taste instead of
January's. Trivial to add to the LR loss; verify with the multi-seed
harness since it effectively shrinks the dataset.

### 6. Cross-encoder rerank of the top-K
Bi-encoder cosine (what we do) compresses each text to one vector before
comparing. A small cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) reads
rubric-summary + JD *together* and is much sharper — too slow for 400 jobs,
fine for reranking the top 30 after the cheap pass. Two-stage retrieval is
the standard pattern; measure with p@25 since that's exactly what it targets.

### 7. Active-learning hints in the sheet
The most informative labels are the ones the model is unsure about. Flag
mid-score rows (model prob ≈ 0.4–0.6) with a marker in Notes so borderline
jobs get deliberate review — each such decision teaches the model more than
another obvious ignore.

### 8. β and blend re-tuning as data grows
`TITLE_BETA = 0.3` and `α = min(0.7, n/200)` were tuned at today's data
size. Both deserve a periodic sweep (the eval harness already supports the
β sweep pattern) — especially α's cap once the model sees 100+ positives.

### 9. LLM-as-judge spot audit (not a scorer)
Don't put an LLM in the scoring loop (cost, drift, unmeasurable). But a
one-off audit — "here are the 20 jobs the model ranked highest that Eric
ignored; hypothesize why" — is cheap and has already paid off once (the
title-signal insight came from exactly this kind of error analysis).

### 10. Fine-tune the encoder (only past ~300 positives)
Contrastive fine-tuning of MiniLM on apply/ignore pairs is the ceiling, but
it needs an order of magnitude more positives than we have, plus a
Python/ONNX export step. Parked until the label count earns it.
