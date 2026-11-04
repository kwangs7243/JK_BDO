# Archived scheduler candidate experiments

This branch preserves offline research and is not the production scheduler.
Do not merge its policy hooks into main as part of the local route refinement.

The optional `__schedulerExperiment` hooks compare region ordering, tier-5
priority, source reserves, terminal target caps and coin ordering. Default
generation was checked against 13 frozen inputs. Candidate comparison uses
`plan-experiment.mjs`; `verify-plan-experiment.mjs` checks repeatability and
unchanged original row counts for the selected conservative plans.

Personal inputs, results and original source snapshots remain outside Git.
Pass new output paths: these tools refuse to overwrite existing results.

```powershell
node tools/scheduler/plan-experiment.mjs --cases <cases.json> --baseline <baseline.json> --out <new-report.json>
node tools/scheduler/verify-plan-experiment.mjs --cases <cases.json> --baseline <baseline.json> --experiment <new-report.json> --out <new-verification.json>
```

The conservative selector is an experimental baseline-preservation filter,
not a proof of global optimality or a complete economic objective. Its
selection predicate does not enforce original row counts or nonincreasing
parley; observed selected plans were checked separately. Shortage sums use
raw item counts rather than economic values. Policy variants do not combine
all search dimensions. No experimental policy was deployed to the user app.

Production local-route refinement and its follow-up instructions live on main
in `docs/agents/SCHEDULER-FOLLOWUP.md`. Future work must preserve the user's
tier-5 batch and tier-6-to-7 completion requirements and must not add long
tier-7 repeat voyages without explicit authorization.
