# Project status and validation

Generative Engine Monitor is a self-hosted reference application for measuring
recorded AI API responses. It includes a mock demonstration, versioned measurement
methods, a durable worker queue and an operator runbook. These capabilities do not
constitute a production certification or a validation of results in personalized
consumer chat interfaces.

The package version is `2.0.0`. Deployments must identify an exact Git commit;
the package version alone does not distinguish subsequent changes on `main`.
No stable GitHub release is asserted by this document.

## Reproducible environment

- The development reference and CI use Node **22.23.4** from [`.nvmrc`](../.nvmrc).
  Node **24.19+** within the 24 LTS line is also supported by the package manifest.
- Both Dockerfiles use `node:22.23.4-alpine`. Rebuild images when updating this
  reference; do not assume an existing image contains a dependency correction.
- Use `npm ci` with the committed lockfile. Keep Next and `eslint-config-next`
  on the same version; update Vitest and its coverage provider together.
- PostgreSQL integration tests need an isolated PostgreSQL 16 database. Without
  `DATABASE_URL`, the two database suites are intentionally skipped. A unit-only
  run is not evidence that database concurrency or recovery works.

## Dependency review — 22 October 2026

The maintenance change updates Next and its ESLint configuration to **16.3.8**,
Vitest and its coverage provider to **4.1.12**, and vulnerable transitive packages
through the lockfile. `tailwindcss-animate` is a build-time plugin used only by
`tailwind.config.ts`; it now belongs to `devDependencies`, so it does not pull the
Tailwind build toolchain into the production worker dependency graph.

The `postcss-selector-parser` override to **7.1.7** addresses
[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) while the
Tailwind 3 dependency ranges still select version 6. The
[upstream changelog](https://github.com/postcss/postcss-selector-parser/blob/main/CHANGELOG.md)
records the fix in 7.1.6. The application builds with 7.1.7 and its generated CSS
was byte-identical before and after this override. Remove the override when the
upstream dependency ranges accept a corrected version, after repeating the build.

### Remaining upstream issue

The local maintenance audit reported **seven high-severity dependency entries**.
The subsequent [CI audit on 22 October 2026](https://github.com/alebgl77/generative-engine-monitor/actions/runs/39750168004/job/119728449698)
reported **eight high-severity dependency entries**, also counting
`tailwindcss-animate` in the transitive chain. Both reports concern the same
unresolved advisory, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
in `braces` 3.0.3 and its build/lint dependants; they are not seven or eight
independent advisories. GitHub lists **no patched version** as of this review.
Both the Tailwind 3 toolchain and Next's ESLint plugin pull this
dependency through their glob tooling. Updating Tailwind alone does not remove
the other path. An automatic forced audit fix proposes incompatible package
changes and is not a reviewed remediation.

The local `npm audit --omit=dev` reported **zero advisories** for the production
dependency graph. That narrower result does not qualify container images or
the complete supply chain: build stages and the one-shot migrator still retain
development dependencies. Do not process untrusted source trees or glob patterns
with those tools. The absence of a demonstrated application exploit does not
close the advisory.

The existing `npm audit --audit-level=moderate` gate remains blocking and unchanged.
The full CI cannot be represented as green while this finding remains. Recheck
the advisory and dependency paths before publishing a release; audit results
change when upstream advisories or packages change.

## Recorded checks

Before this maintenance change, commit
[`3a377934`](https://github.com/alebgl77/generative-engine-monitor/commit/3a37793404c2d19efe5d22b7caf16f70552c48c2)
had a successful [container qualification job](https://github.com/alebgl77/generative-engine-monitor/actions/runs/39606857833/job/119245181260)
and successful lint, typecheck, tests, build and mock HTTP smoke. Its overall CI
failed at the dependency audit. That result does not qualify a later commit.

Local maintenance validation on Node 22.23.4 passes lint (with six existing React
warnings), typecheck, production build, and **553 tests**. **24 database tests are
skipped**, because no PostgreSQL server was available in that environment. Those
local results alone did not qualify the database integration or container images.
No real provider calls, credentials, deployments or migrations against an existing
instance were part of this maintenance check.

### CI qualification of the maintenance revision

[CI run 39750168004](https://github.com/alebgl77/generative-engine-monitor/actions/runs/39750168004)
for source revision
[`248858c6406500d22330ac805274525caa12fbcc`](https://github.com/alebgl77/generative-engine-monitor/commit/248858c6406500d22330ac805274525caa12fbcc)
completed on **22 October 2026 at 08:47:57 UTC**. It tested the pull-request merge
with base `3a37793404c2d19efe5d22b7caf16f70552c48c2`, using Node **22.23.4**
and npm **10.9.9** in the verification job.

- The [verification job](https://github.com/alebgl77/generative-engine-monitor/actions/runs/39750168004/job/119728449698)
  applied all six PostgreSQL migrations, seeded and verified five providers,
  and passed lint (six existing warnings), typecheck and production build.
- **577 tests across 38 files passed**, including the 18 PostgreSQL queue tests
  and six PostgreSQL plan/reservation tests that were skipped locally.
- The production HTTP smoke passed: health endpoints, anonymous rejection,
  authenticated session, immutable mock run, archived catalog, dashboard/exports,
  nullable confidence intervals and **v3 → v2 → v3** replay/promotion with unchanged
  stored responses and original scores.
- The [container job](https://github.com/alebgl77/generative-engine-monitor/actions/runs/39750168004/job/119728449379)
  passed qualification of all three images, migrator completion, readiness,
  worker health, non-root runtime, mock HTTP workflow and refusal to start after
  a failed migration.

The only failing step was the unchanged full dependency audit: **eight high-severity
entries from the single `braces` advisory above**. The overall run is therefore
**failed**, despite the successful functional and container checks. These results
qualify the stated revision and mock workflow, not later commits or real-provider
production behavior.

For each revision, use the [CI runs](https://github.com/alebgl77/generative-engine-monitor/actions/workflows/ci.yml)
to verify the complete database and container jobs. Runtime dependency audit,
full dependency audit, functional checks and operational qualification answer
different questions; report their results separately.

## Before relying on an instance

Follow the [production runbook](production-runbook.md). Real-provider behavior and
billing, representative load and P99 latency, multi-replica draining, restore/PITR,
TLS/proxy configuration and external scientific validation require separate
evidence. A mock demonstration or a successful build does not establish them.

Replay reuses stored provider responses. A new optional sentiment judgment may
still incur a provider charge; replay is not described as universally free.
