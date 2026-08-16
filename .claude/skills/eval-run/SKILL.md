---
name: eval-run
description: Run the vision eval suite with configurable strategy, model, provider, and limit options
disable-model-invocation: true
---

Run the cover-scan vision evaluation suite. Available options:

- `--strategy A,B,C,D,E` — run specific strategies (comma-separated, default: all)
- `--limit N` — only run first N test cases (useful for quick checks)
- `--model MODEL` — override model (default: `mistral-medium-2604`)
- `--provider NAME` — `mistral` (default), `qwen`, `qwen-cn`, `openrouter`
- `--base-url URL` — any other OpenAI-compatible endpoint
- `--delay MS` — delay between API calls in ms (default: 500)

Ask the user which options they want, then run:

```
MISTRAL_API_KEY=<from .env> bun run vision-eval/index.ts [options]
```

For non-Mistral providers the key comes from `EVAL_API_KEY` instead:

```
EVAL_API_KEY=<key> bun run vision-eval/index.ts --provider qwen --model qwen-vl-max
```

## Models

Verified working on the current Mistral key (all vision-capable):

| Model | Notes |
| --- | --- |
| `mistral-medium-2604` | Medium 3.5. Best measured score — 121/202 (59.9%) on strategy A |
| `mistral-large-2512` | Large 3, Apache 2.0. 83/202 (41.1%) |
| `ministral-14b-2512` | Ministral 3 14B, Apache 2.0. 83/202 (41.1%) |
| `mistral-small-2603` | Small 4, Apache 2.0. 76/202 (37.6%) — weak on stylised sleeve type |

Pin date-coded IDs, never `-latest`. Retired snapshots are silently redirected:
`mistral-small-2506` now serves `mistral-small-latest`, which caused a 21-point
regression that went unnoticed because it returns 200 rather than an error.

`pixtral-large-latest` and `pixtral-12b` are retired and return HTTP 400.

## After completion, report

- Which strategies and model were tested
- Overall scores per strategy
- **Any error-rate warning** — a throttled run still prints a full score table
  where failed cases score 0 and look like wrong answers. Re-run with a longer
  `--delay` before comparing models.
- Location of results file in `vision-eval/results/` (timestamped per run)
