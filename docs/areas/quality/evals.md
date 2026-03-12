# Vision Eval Harness

## Purpose

The `eval/` directory is a small benchmark harness for release-cover extraction quality. It exists alongside unit tests because it measures model behavior rather than deterministic code paths.

## Main files

- `eval/fixtures/manifest.json` defines labeled test cases.
- `eval/submit.ts` submits batch jobs to configured vision models.
- `eval/status.ts` checks job progress.
- `eval/results.ts` and `eval/html-report.ts` turn finished runs into comparable reports.

## Output

- HTML reports are written to `eval/results/`.
- Pending batch metadata is stored in `eval/results/pending-jobs.json`.

## When to use it

Use the eval harness when changing prompts, Mistral model selection, scan parsing, or MusicBrainz-assisted scan enrichment. It is intended for quality comparison, not for everyday local smoke testing.
