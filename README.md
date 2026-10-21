# Generative Engine Monitor

**English** · [Français](README.fr.md)

Most detailed documentation under [docs/](docs/) is currently written in French; the production runbook and the
measurement methodology are in English.

A self-hosted observatory for generative visibility, based on the responses actually observed through provider APIs.

![Desktop view of the signal room](docs/screenshots/signal-room.png)

Generative Engine Monitor reports medians, confidence intervals, and the breakdown of every score.
Analyses can be replayed from the stored responses, without hiding the sample size or the method used.

The application is distributed to be **self-hosted**: each user installs and operates their own instance,
on their own machine or server, with their own database and secrets. It is not a centralized SaaS. No telemetry
or public sharing is enabled implicitly, and publishing the source code makes neither your instance nor your data
public. Provider keys are encrypted at rest.

[Install your instance](docs/02-installation.md#installer-sa-propre-instance) ·
[Read the methodology](docs/measurement-methodology.md) ·
[Prepare for production](docs/production-runbook.md)

## Quick start — self-hosted instance

```bash
cp .env.example .env
npm install             # `keygen` runs via tsx, which ships with the dependencies
npm run keygen          # generates NEXTAUTH_SECRET, CREDENTIAL_KEYS and the pepper — paste them into .env
docker compose up
```

The stack includes PostgreSQL, a one-shot migrator, the web application at http://localhost:3000 and a separate worker.
The web and worker services wait for the migrator to finish. Without a worker, analyses are scheduled but do not progress.

Start with the [self-hosted installation guide](docs/02-installation.md#installer-sa-propre-instance). Local access
or access through an SSH tunnel can remain private; network exposure requires your own HTTPS configuration. Backups,
updates, and secret retention remain your responsibility.

For a production deployment, follow the [runbook](docs/production-runbook.md): stop the old web and worker processes
before migrating, with no rolling deployment mixing two versions. Prepare your secrets from
`.env.production.example`; do not reuse `.env.example` or the demo data. Actual Docker qualification has not been run
in the local Windows environment. For this commit, however, the Ubuntu GitHub Actions `containers` job qualifies
the three images, Compose, the migrator and its gate, web readiness, worker health, non-root execution, and the mocked
HTTP flow. The following remain outside the qualification scope: real providers, credentials, and billing; load and
P99 latency; multi-replica operation and draining; restore and PITR; production TLS/proxy; and external scientific
validity; see the [validation boundary](docs/production-runbook.md#validation-boundary-and-external-work).

Calls to real engines use your provider accounts, send the requested content to their APIs, and
may incur charges. The application's volume limits are not a spending cap.

## Verifiable findings, not a magic score

### Signal findings

The summary pairs the same **query × provider** across the parametric and grounded modes. It surfaces
three readable situations: invisibility in both modes, erosion when search degrades the signal,
and recovery when search improves it.

These findings are descriptive, not causal. The observed variation, the support size, the method, and the low-sample
indicator stay visible so that a fragile trend is not turned into a certainty.

### Measurement passport

From the interface, a measurement can be previewed, then copied as Markdown or downloaded as JSON. The passport
states the version, the run, the support, and the method that make the result interpretable.

The export is prepared locally in the browser. It includes no raw responses, no internal identifiers,
no provider keys, and no authentication secrets.

<p align="center">
  <img src="docs/screenshots/signal-room-mobile.png" width="390" alt="Mobile view of the signal room">
</p>

A growing share of brand discovery no longer goes through a results page but through a written answer:
the user asks ChatGPT, Claude, Gemini, or Perplexity a question, reads a paragraph, and often opens no link at all.
Measuring a brand's presence in these answers is not the same discipline as measuring a ranking. There is no stable
position 3 to track: there is a distribution of answers, each draw of which names brands in a different order,
may or may not rely on sources, and changes depending on whether the engine consults the web or recites what it
learned. A tool that reduces all of this to a single number per query mostly measures its own sampling noise.

## What this tool does differently

### Two axes, never mixed

Each query is asked twice: in **PARAMETRIC** mode, with all search tools disabled — what the model
retained from its training — and in **GROUNDED** mode, with the provider's native web search enabled — what it
goes looking for at answer time. The two medians are reported side by side and never averaged, because their
difference is the only actionable diagnostic they carry together. A positive **retrieval gap** means that
search works in your favor and that the worthwhile investment is the content the engines will retrieve; a negative
gap means that the models know you but stop citing you as soon as they consult their sources,
and the worthwhile investment becomes those sources.

### Intervals, never a bare number

Two identical calls to the same model do not produce the same answer: the brand cited first in one draw
can be absent from the next. Each cell (query × engine × mode) is therefore sampled N times — three by default.
The current method builds summaries and intervals over **clusters of independent queries**, keeping their count
distinct from the number of repeats: repeating a call does not create a new independent query. A task limited
to a single query remains descriptive, with no cluster-based interval. The bootstrap resampling is deterministic and
`lowN` depends on the number of queries; see the [measurement methodology](docs/measurement-methodology.md) for the
current methods, historical compatibility, and interpretation limits.

### Explainable, replayable scores

A score is never an opaque number: it is the signed sum of per-rule contributions, each accompanied by
the evidence that triggered it — character offsets in the response, URLs of the retained citations, the majority
sentiment verdict. This breakdown is persisted exactly as it was computed, then rendered exactly as it was persisted.
Because the raw text and the JSON payload of every response are stored in full, an eligible analysis can be
**replayed** under a different scoring or extraction version, without acquiring new responses. Any new call to the
sentiment judge may, however, incur a cost. A replay goes through the same job queue as a real run,
with its progress tracking, retries, and cancellation; its conditions are described in the
[measurement methodology](docs/measurement-methodology.md).

## Architecture

The Next.js application never makes a provider call within the lifecycle of an HTTP request. Launching an analysis
**materializes the entire plan** — a `Run`, its `RunTask` records (one per cell), its `RunSample` records (one per
billable call), and the corresponding jobs — in a single PostgreSQL transaction, then responds `202`. Execution belongs
to one or more separate **worker** processes that drain a durable, Postgres-backed queue: claiming via
`SELECT … FOR UPDATE SKIP LOCKED` (concurrent workers take disjoint batches without blocking each other), heartbeat
leases (a killed worker hands its jobs back to the sweeper instead of stranding them), and a token bucket shared in the
database (the limit that matters is the provider's, not a container's). Progress is tracked by counters decremented
in the transaction that writes the result: `pendingSamples` reaching zero triggers the task's aggregation, and
`pendingTasks` reaching zero triggers the run's. Nothing polls, and the web container can restart mid-run without
losing work.

## Development and demo

The commands below are intended only for **development against an isolated database**.

### Local

Prerequisites: Node ≥ 20.11 and PostgreSQL 16.

```bash
./setup.sh              # creates .env, installs dependencies, generates secrets, then stops
#                         now point DATABASE_URL at your instance in that .env
./setup.sh              # Prisma client, migrations, seed
npm run dev             # web application
npm run worker          # analysis runner, in a second terminal
```

`setup.sh` generates secrets only when it creates the `.env` itself: copying the file by hand before running the script
skips that step and leaves the example encryption key in place.

The **`mock`** engine requires no API key: it produces realistic fixture responses in both modes,
with mentions and sources. The whole pipeline — scheduling, queue, execution, extraction, scoring, aggregation,
intervals, replay, export — can therefore be demonstrated end to end without spending a cent, before a single key has
even been entered. It is scheduled **only as long as no valid key exists**: its responses are fixtures, and aggregation
does not distinguish their origin, so scheduling them alongside a real engine would amount to publishing a median and
a confidence interval that no provider produced.

Its fixtures name a fixed panel of CRM vendors. To see a populated dashboard, start from the demo project
created by `SEED_DEMO=true`, whose tracked brand belongs to that panel: a project whose brand is not in the panel will
legitimately produce zero scores, which reads like a broken installation even though the measurement is accurate. As
soon as a real API key is configured, the issue no longer arises.

## Supported engines

| Code | Label | Parametric | Grounded | Citation origin | Model variable |
|---|---|---|---|---|---|
| `openai` | OpenAI ChatGPT | yes | yes | `url_citation` annotations from the Responses API (NATIVE), supplemented by URLs found in the text | `OPENAI_MODEL` |
| `claude` | Anthropic Claude | yes | yes | `web_search_tool_result` blocks and `web_search_result_location` citations (NATIVE), supplemented by URLs from the text | `ANTHROPIC_MODEL` |
| `gemini` | Google Gemini | yes | yes | `groundingMetadata.groundingChunks` (NATIVE), supplemented by URLs from the text | `GEMINI_MODEL` |
| `perplexity` | Perplexity | no | yes | `search_results` (NATIVE), falling back to `citations` when that field is absent | `PERPLEXITY_MODEL` |
| `mock` | Mock (demo) | yes | yes | fixture sources, marked NATIVE in grounded mode | none |

Perplexity always queries the web: parametric mode is meaningless for this engine, and scheduling skips the
cell instead of failing it. Citations taken from native metadata (`NATIVE`) are distinguished from those
merely written in the response (`INLINE_MARKDOWN`, `BARE_URL`): a link typed from memory is not proof that a
document was retrieved. The origin is carried by each citation, resolves collisions after normalization in favor
of the native source, and remains visible in a sample's detail view. What the `citation` rule does with it depends
on the scoring version: `v2` counts all retained sources, while `v3` — the current version — credits only those the
provider actually returned. The scoring change took the form of a new version file registered in the registry,
never an edit to the previous one: that is what keeps a score persisted under `v2` reproducible
under `v2`.

**Model identifiers are configuration, never code.** Each provider retires its models on its own
schedule, and a hard-coded identifier becomes a silent failure the day it is retired. Defaults
live in [`.env.example`](.env.example), can be overridden through environment variables, and the worker logs
the resolved models at startup.

## The scoring model

A sample's score ranges from 0 to 100 and reads as the sum of its rules.

| Rule | Weight | What it measures |
|---|---|---|
| `presence` | 35 | the brand appears, weighted by match quality (exact, alias, domain, fuzzy) |
| `prominence` | 15 | position of the first mention in the text and order of appearance among all entities |
| `frequency` | 10 | number of occurrences, logarithmically saturated |
| `shareOfVoice` | 20 | brand occurrences versus competitor occurrences, smoothed |
| `citation` | 15 | sources from the brand's domain among the retained sources, or among native sources only, depending on the scoring version |
| `sentiment` | signed, floor −10 | majority tone of the passages mentioning the brand |
| `competitorLead` | signed, floor −8 | competitors named before the brand, relative to the number of competitors mentioned |

The `citation` rule requires that something was retrieved. In parametric mode, nothing is, by construction;
in grounded mode, a response with no sources at all says something about the provider, not about the brand. Scoring
it 0 out of 15 in both cases would mechanically cap the parametric axis at 85 and make the two axes incomparable — the
retrieval gap would measure nothing more than a scoring artifact. The rule's budget is therefore **redistributed** to
the four positive rules that remain applicable (`presence`, `prominence`, `frequency`, `shareOfVoice`), in proportion
to their weights: each is multiplied by 95/80, and the contribution carries the `redistributed` flag so that the
breakdown stays readable. Both axes are thus expressed on the same scale, and their difference remains meaningful.

A published scoring version is never modified: any change in behavior is a new version file.
This is the only guarantee that makes a persisted score reproducible, and therefore a replay comparable.

## Security

- Provider API keys are **encrypted at rest with AES-256-GCM**, with the owner pair
  `(userId, providerId)` authenticated as AAD: a ciphertext copied onto another user's row fails
  decryption instead of handing that user a paid key.
- **Versioned rotation**: each row records the key version that wrote it, and decryption looks up that
  specific version. Adding a version and moving `CREDENTIAL_KEY_CURRENT` is sufficient; existing rows remain readable.
- **No route returns a key in plaintext** — responses carry only a four-character mask, and a peppered HMAC
  fingerprint is used to detect duplicates without decrypting anything.
- **Ownership check on every route**: every project resource goes through a single helper that verifies the session
  and then ownership, and child identifiers are looked up together with their `projectId` so that a valid identifier
  from another project cannot be found.
- **Rate limiting** on sign-up, on analysis launches, and on each provider, via a token bucket
  persisted in the database and therefore shared across all processes. Sign-up is limited twice: by a global bucket,
  debited first, and by a per-address bucket that exists only when `TRUSTED_PROXY_HOPS` makes the address knowable —
  otherwise a client able to write its own `X-Forwarded-For` would mint itself a fresh bucket on every request.
- **Strict CSP and security headers**: the policy is emitted per request from `src/proxy.ts`, with a nonce and
  `strict-dynamic` — without a nonce, the App Router's inline bootstrap would be blocked and pages would remain
  unhydrated. `default-src 'self'`, `connect-src 'self'` (the browser never talks to a provider API),
  `frame-ancestors 'none'`, `object-src 'none'`. Request-independent headers — `nosniff`, `X-Frame-Options`,
  `Referrer-Policy`, HSTS in production — come from `next.config.mjs`.
- **Formula injection neutralized in CSV export**: competitor names and URLs come from model outputs,
  and any cell starting with `=`, `+`, `-`, `@`, a tab, or a carriage return is defused before being quoted.
- The application **refuses to start in production** with the example secrets.

Threat model details and reporting procedure: [SECURITY.md](SECURITY.md).

## Stack

Next.js 16 (App Router) · React 19 · strict TypeScript · PostgreSQL 16 · Prisma 5 · NextAuth 4 · Tailwind CSS · Recharts ·
Vitest · Docker Compose. No external queue dependency: durability comes from Postgres.

## Project structure

```
src/
  app/(auth)/        sign-in and sign-up pages
  app/(dashboard)/   project views: summary, queries, sources, analyses, configuration
  app/api/           REST routes, one per resource
  components/        UI primitives and score presentation components
  lib/api/           authentication, ownership checks, validation, error shape
  lib/crypto/        envelope encryption of provider keys
  lib/parsing/       extraction versions: mentions, offsets, citations, URL normalization
  lib/providers/     AIProvider contract and one implementation per engine
  lib/queue/         durable queue, token bucket, recovery sweeper
  lib/runs/          run planning, sample extraction and scoring
  lib/scoring/       scoring versions, statistics, aggregation, replay
  lib/sentiment/     content-addressed sentiment judge
  types/             API contract shared by routes and pages
  worker/            worker loop, graceful shutdown, job handlers
```

## Scripts

| Command | Effect |
|---|---|
| `npm run dev` | web application in development mode |
| `npm run worker` | analysis runner; without it, runs stay pending |
| `npm run build` | production build |
| `npm run test` | Vitest suite |
| `npm run test:coverage` | same suite, with coverage — this is the form CI runs |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint via the Next configuration |
| `npm run db:migrate` | creates and applies a migration in development |
| `npm run db:deploy` | applies existing migrations; in production, follow the runbook with the old web and worker processes stopped |
| `npm run db:seed` | engines and rate-limit buckets; under `NODE_ENV=production`, preserves existing settings without demo data; `SEED_DEMO=true` is reserved for development |
| `npm run keygen` | generates the session secret, encryption keys, and fingerprint pepper |

## Documentation

| | |
|---|---|
| [02 — Installation](docs/02-installation.md#installer-sa-propre-instance) | start here: your self-hosted instance, private access, and configuration |
| [Production runbook](docs/production-runbook.md) | first installation, upgrades, health, backup, and recovery |
| [Measurement methodology](docs/measurement-methodology.md) | query clusters, paired delta, per-context sentiment, history, and limits |
| [01 — Architecture](docs/01-architecture.md) | path of a request, queue, worker loop, recovery, cancellation |
| [03 — Database](docs/03-database.md) | Run → RunTask → RunSample grain, evidence, and distributions |
| [04 — API reference](docs/04-api-reference.md) | every route, its body, and its response |
| [05 — Engines](docs/05-providers.md) | `AIProvider` contract, the two modes, adding an engine |
| [06 — Measurement](docs/06-measurement.md) | extraction, scoring rules, statistics, replay |
| [07 — Pipeline](docs/07-pipeline.md) | job lifecycle, run state machine |
| [08 — Dashboard](docs/08-dashboard.md) | what each view shows and how to read it |
| [09 — User guide](docs/09-user-guide.md) | complete walkthrough, from empty project to diagnosis |

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Trademarks

The names and logos of the engines mentioned belong to their respective owners. Their presence indicates technical
support for the integration and does not constitute endorsement, partnership, or affiliation.
