# Temporary Minimatch audit exception — proposal for review

**Status: draft, not activated on `main`.** This proposal is based on the Zod
security branch. Merging it into that branch and subsequently into `main`
requires explicit maintainer approval. It does not dismiss any GitHub alert.

The exception expires on **16 November 2026 at 00:00 Europe/Paris**
(`2026-11-15T23:00:00Z`). The expiry is fixed in both the policy and the gate;
there is no environment variable or command-line override.

## Why this specific exception is proposed

The complete npm audit reports 16 moderate findings propagated from one advisory,
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The production-only audit is clear. The affected dependency graph is development
tooling used for linting and build-time checks.

The published advisory describes pattern amplification in
`firstPhasePreProcess()` with `optimizationLevel >= 2`. The two installed copies
are:

| Copy | Reviewed exposure |
| --- | --- |
| Minimatch 3.1.5 | Its implementation has neither `firstPhasePreProcess` nor `optimizationLevel`. The described preprocessing path is absent. |
| Minimatch 10.2.6 under TypeScript-ESLint | The installed caller supplies `{ dot: true }`; Minimatch's default optimization level is 1. |

These are bounded observations about the pinned source, not a claim that all
Minimatch usage is safe. An attacker-controlled pattern with different options
must not be treated as covered. The installed parents still require the old
callable export and, in some cases, `makeRe`. A blanket override to Minimatch 11
would change those APIs and is deliberately excluded.

## What the gate admits

`security/minimatch-audit-exception.json` binds the proposal to the exact
`package-lock.json` bytes, the two copies' paths, versions and integrity values,
and the full reviewed finding graph. Every involved lock entry must be marked
development-only.

The report contains a legitimate peer cycle between `eslint` and
`@eslint-community/eslint-utils`. The gate computes strongly connected
components, admits only that exact component and its exact internal edges, and
then evaluates the condensed acyclic graph. Every admitted component must reach
a real leaf for the single advisory, and every outgoing path must also be
admitted. A previously visited node never grants an exception by itself.

The command still requests npm's **moderate** audit threshold, explicitly includes
development dependencies and prints the complete unfiltered report. If the
exception is used, it states that all 16 moderate findings remain and prints the
advisory and expiry. It does not report zero vulnerabilities.

It fails closed when an exception is needed and any of the following occurs:

- The fixed expiry is reached, the lock or a reviewed path/version/integrity
  changes, or a finding is no longer development-only.
- Another advisory, severity, graph edge, cyclic component or internal cycle
  edge appears; a component has no productive approved leaf.
- npm cannot complete the audit, its status and counts disagree, or the report,
  reference graph or policy schema is unknown or malformed.

A normally passing audit remains independent of this exception, including after
the expiry. Any remaining low-only findings retain npm's existing moderate
threshold behavior. When an exception is needed, no additional finding is
silently folded into it.

## Review and removal

Run `npm run audit:security` to see the complete report and gate decision.
The ordinary test suite exercises the real report and negative cases for expiry,
scope drift, runtime copies, other advisories, unknown schemas, network failures
and unproductive or changed cycles.

Before approval, inspect the policy's lock hash and graph, the installed callers,
the expiry and the original advisory. The original Zod change has its own review;
this policy proposal does not authorize its merge.

Prefer an upstream-compatible dependency fix or a corrected advisory range.
Once the ordinary audit passes, remove the policy, gate and their dedicated
tests and restore the direct npm audit command. Any proposed extension of this
exception requires a new explicit review; it does not renew itself.
