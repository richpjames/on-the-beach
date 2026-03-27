---
name: eval-run
description: Run the Pixtral eval suite with configurable strategy, model, and limit options
disable-model-invocation: true
---

Run the Pixtral evaluation suite. Available options:

- `--strategy A,B,C,D,E` — run specific strategies (comma-separated, default: all)
- `--limit N` — only run first N test cases (useful for quick checks)
- `--model MODEL` — override model (default: pixtral-large-latest, also: mistral-small-2506)
- `--delay MS` — delay between API calls in ms (default: 500)

Ask the user which options they want, then run:

```
MISTRAL_API_KEY=<from .env> bun run pixtral-eval/index.ts [options]
```

After completion, report:
- Which strategies were tested
- Overall scores per strategy
- Any failures or errors
- Location of results file in pixtral-eval/results/
