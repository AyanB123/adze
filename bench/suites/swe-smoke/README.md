# swe-smoke

**Wiring check only. Its number is never published.**

```bash
pnpm bench:swe-smoke    # run the 25 wiring cases; exits 3 by design (see below)
```

## What this is

Twenty-five hand-written edit cases that exercise the Tier-1 pipeline end to
end — loading, running, reporting, gating, artifact writing — in the shape the
Tier-2 SWE-bench smoke slice will take. They are **placeholders, not SWE-bench
tasks**: no dataset record, no repository checkout, no container, no model.
The real 25-task smoke slice needs Harbor adapters, a dataset, and a container
runtime, all of which are blocked (see `docs/roadmap.md` M5).

## Why a passing run exits 3

`checkReportPolicy` refuses every `swe-smoke` report with
`wiring-check-not-publishable`, so `adze-bench` exits 3 even though all 25
cases pass. That is the point: the refusal is what makes the number
unquotable. A wiring check whose report could be published as a result would
become a result the first time someone quoted it — which N18 forbids. CI runs
this suite expecting exit 3 and uploads the artifacts regardless.

**Do not quote this suite's pass rate anywhere.** Not in a PR description, not
in `docs/`, not as "25/25 on SWE-smoke". The report itself prints the refusal
above every number so the figure cannot be copied without its warning.

## Output

Same five files as the other Tier-1 suites, written to
`bench/.runs/<stamp>-swe-smoke/` (gitignored) by default. Every `report.md`
carries the publication refusal in its limitations section, above every number.
