# Measurement methodology

## Versioned estimands

The legacy sample-level `bootstrapMedianCI` and `aggregate` helpers retain their
existing behavior for replay compatibility. They must not be relabeled as
query-cluster intervals. The new method is explicitly `query-cluster-v1` for a
single mode and `paired-query-cluster-v1` for a retrieval difference. Keep this
method identifier with the result; the scoring version and the interval method
describe different parts of a measurement.

## Query-cluster summaries

`clusterBootstrap` accepts successful repeats with `queryId`, `providerId` and
`value`. Its estimand is a summary across equally weighted query means:

1. Average successful repeats within each query/provider cell.
2. Average the observed provider-cell means equally within each query.
3. Report the mean and median of the query means, giving each query equal weight.

The default point estimand for the interval is the median of query means. The
`statistic: "mean"` option instead bootstraps their mean; the output states which
statistic its interval targets. MAD, IQR and stability also describe query means,
not within-query repeatability. A task with only one query has descriptive
statistics but no cluster-based confidence interval.

This avoids weighting queries or providers by the number of successful repeats.
It does not repair missing data. Failed calls are not zero scores, missing cells
are not imputed, and a query with an absent provider is summarized over its
remaining observed providers. Failure-dependent missingness or a changing
provider panel can bias comparisons. Always inspect coverage, errors and the
provider panel alongside the estimate.

### Uncertainty and sample size

The percentile bootstrap samples whole query means with replacement, with a
deterministic seeded PRNG and 2,000 draws by default. Providers and repeats are
nested observations, not independently resampled units. Stable sorting makes
replayed results independent of database row ordering. The default central
interval is 95%; `alpha` and the number of draws can be set explicitly.

`n` counts independent query identifiers; `rawN` counts successful repeats and
`cellN` counts observed query/provider cells. Copying repeats does not increase
`n` or narrow the interval. Fewer than two query clusters yield null bounds;
empty input also yields null point summaries. `lowN` is based on query count and
defaults to fewer than 30 queries. This warning threshold is an operational
guardrail, not a validated minimum for nominal interval coverage. A constant
observed panel can produce equal bounds even with several queries; that is not
proof that the underlying system is deterministic.

The interval is conditional on the fixed, observed provider panel and the
observed within-cell repeat means. It measures variation across the sampled
queries, not uncertainty over all possible providers, future model changes or
unobserved response variability. Providers are not assumed to be a random sample
of a larger population. More repeats can improve a cell mean, but do not create
new independent questions.

Treating `queryId` as the independent cluster assumes the questions are distinct
and sufficiently independent. Duplicate questions under different identifiers,
correlated paraphrases, and shared topic families are not detected or clustered
by these helpers. A convenience query set is not automatically representative of
customer demand, the web, or any other population. No claim of calibrated nominal
coverage or scientific validation is made without a suitable empirical study.

## Paired retrieval difference

`pairedRetrievalDelta` uses only the intersection of query/provider cells with at
least one successful repeat in both modes. For each such cell it subtracts the
PARAMETRIC repeat mean from the GROUNDED repeat mean. It then equally averages
paired provider differences within each query and equally averages queries.
The reported retrieval delta is therefore **`mean`**, not `median`; the interval
resamples query-level differences and targets that mean.

A GROUNDED-only provider cannot create a retrieval difference by being pooled
against another provider's PARAMETRIC responses. Explicit capability metadata
that lacks either mode excludes that provider even if contradictory historical
rows contain both modes. When capability metadata is absent, the helper does not
invent it: an observed within-cell pair may be used and the provider is counted
in `unknownSupportProviders`. Callers should pass the recorded capability panel
when available and flag unknown metadata in their presentation.

Support diagnostics accompany the estimate:

- `pairedQueries` / `n`: independent paired query count.
- `pairedCells` / `cellN`: paired query/provider count.
- `rawN` / `rawRepeats`: all successful input repeats, by mode.
- `pairedRepeats`: repeat counts retained in the matched subset, by mode.
- `excludedModeOnlyCells`: observed cells missing one mode.
- `excludedUnsupportedCells` and `excludedUnsupportedProviders`: exclusions
  based on explicit capability metadata.
- `unknownSupportProviders`: observed providers without capability metadata.

Mode-only and unsupported exclusions can overlap and must not be summed as
disjoint categories. The matched subset can differ from either single-mode
panel, so the paired delta need not equal the difference of the two displayed
single-mode summaries. Pairing controls the observed query/provider mix; it is
not randomized assignment, and does not identify a causal effect of retrieval.

## Context-level sentiment

`judge-v2-context` returns a map keyed by
`sentimentKey(entityId, originalContext)`. A positive context and a negative
context for the same entity remain separate; there is no entity-wide selection
of the most negative verdict. Whitespace-equivalent contexts share a lookup key.
The key hashes the complete normalized context and the entity identifier.

The judge still receives at most 400 normalized characters per excerpt and 50
distinct cache misses per call. Its content-addressed cache stores only a hash,
judge version and verdict fields, not the raw excerpt. Distinct long contexts
may share the same truncated judge evidence and therefore the same cached
judgment, while retaining distinct occurrence lookup keys. Truncation can omit
relevant nuance; this is an explicit limitation, not evidence of agreement.

The cache version changes rather than rewriting older cache records. Existing
historical analysis must retain its original attribution/scoring version unless
explicitly rescored under a new version. Missing credentials, throttling,
unparseable replies, omitted items and provider failures leave verdicts absent,
never synthetic NEUTRAL values. Available cached verdicts survive a failure to
judge other contexts. Arbitrary provider/cache error messages are not logged
because they can echo private inputs or credentials.

These changes remove a deterministic negative-selection bias; they do not prove
that the model judge itself is unbiased or accurate. Assess sentiment quality
against a human-labeled, representative benchmark before making such claims.

## Immutable history and replay

The measurement concerns connector API responses under the recorded parameters,
not the personalized public ChatGPT, Gemini or Perplexity interfaces, and not
market share. Compare common provider panels and observed modes. A plan snapshots
entity names, aliases and domains, query text, locale, provider capabilities and
the requested model. The request hash identifies that versioned, non-secret
request specification; it is not a hash of the exact network prompt or response.
Backfilled snapshots are explicitly marked reconstructed and cannot restore
information already changed before the migration.

Catalogue deletion archives entries for future plans; historical readers use the
snapshots. A new scoring version is activated only after all eligible successful
samples and both task/run aggregates have complete coverage under the current
interval method. Until then readers retain the original version and matching
extraction evidence. Legacy intervals keep their legacy method and sample-based
N until explicitly recomputed. Missing analysis is reported separately from
provider failure and never silently means a zero visibility score.

Replay only targets COMPLETED samples with stored responses on non-cancelled,
terminal runs. FAILED samples with raw responses are reported as excluded, not
silently repaired; a terminal repair workflow is outside this implementation.
Permanent sample/version deduplication prevents unlimited retry purchases. A
terminal job missing its target returns an explicit conflict; operator review or
a new scoring version is required. Optional fresh sentiment judging can cost
money, so replay is not described as universally free. Complete SampleScores can
instead receive a database-only aggregation refresh, keyed by interval-method
version, without requesting a new answer or judgment. A project operation may
schedule both kinds of work. Historical sample scores and evidence are immutable.

## Reservation limits

The validated defaults are 1,000 samples per operation, 10,000 reserved samples
per user/UTC day, three active runs per user and 1,000 unarchived queries per
project. These are volume safeguards, not exact currency budgets. Unknown token
usage or cost must remain unknown, not zero. New runs and new sample replay jobs
reserve volume under the same owner-row lock, atomically with durable jobs.
Rejected transactions and deduplicated requests do not make new reservations.

Daily reservations live in a dedicated non-refilling key, independent of project
foreign keys and provider rate limiting. Cancellation and project deletion do not
refund them. On transition, the first reservation uses the surviving same-day
sample/replay rows as a conservative floor; project deletion first materializes
that floor under the same owner lock before cascading rows. A configured ceiling
increase cannot refill an existing day's key, and lowering the ceiling preserves
consumption even when it already exceeds the new limit. This cannot reconstruct
legacy consumption deleted before deployment; that historical information is no
longer available.
