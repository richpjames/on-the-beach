# Vision Model Eval Workflow Design

## Purpose

Compare all Mistral vision-capable models to determine which best identifies artist and title from album cover images. Uses Mistral's batch API for 50% cost savings.

## Structure

```
eval/
├── fixtures/
│   ├── manifest.json       # Test cases
│   └── images/             # Album cover images
├── submit.ts               # Build + submit batch jobs (one per model)
├── status.ts               # Check batch job progress
├── results.ts              # Download results, score, print report
├── models.ts               # Mistral vision model ID list
├── scoring.ts              # Exact + fuzzy match logic
└── results/                # Timestamped JSON reports
    └── pending-jobs.json   # Job IDs between submit and results steps
```

## Workflow

Three CLI commands, run in sequence:

1. **`bun eval/submit.ts`** — Reads manifest, builds inline batch requests per model (one batch job per model, since the batch API requires a single model per job). Saves job IDs to `eval/results/pending-jobs.json`.

2. **`bun eval/status.ts`** — Polls status of all pending jobs. Prints a table showing model → status (QUEUED/RUNNING/SUCCESS/FAILED).

3. **`bun eval/results.ts`** — Downloads completed batch outputs, parses responses, scores against manifest ground truth, prints comparison table, saves detailed JSON report.

## Manifest Format

```json
{
  "cases": [
    {
      "id": "radiohead-ok-computer",
      "image": "images/radiohead-ok-computer.jpg",
      "artist": "Radiohead",
      "title": "OK Computer"
    }
  ]
}
```

Image paths are relative to `eval/fixtures/`.

## Models

All Mistral vision-capable models (as of Feb 2026):

- `mistral-small-3-2-25-06`
- `mistral-medium-3-1-25-08`
- `mistral-large-3-25-12`
- `ministral-3-14b-25-12`
- `ministral-3-8b-25-12`
- `ministral-3-3b-25-12`
- `pixtral-large-2411`

## Batch Request Format

Each batch job uses inline batching (< 10k requests). Per-request body matches the existing `vision.ts` contract:

```json
{
  "custom_id": "radiohead-ok-computer",
  "body": {
    "temperature": 0,
    "response_format": { "type": "json_object" },
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "<SCAN_PROMPT from vision.ts>" },
          { "type": "image_url", "image_url": "data:image/jpeg;base64,<BASE64>" }
        ]
      }
    ]
  }
}
```

The prompt is reused from `server/vision.ts`:
> "You are reading a photo of a music release cover. Respond with JSON only using keys artist and title. If uncertain, use null values."

## Scoring

Per test case per model:

- **Exact match** (case-insensitive, trimmed): 1 or 0
- **Fuzzy score**: normalized Levenshtein similarity (0.0–1.0)
- **Null handling**: model returns null when expected non-null → score 0; both null → score 1

Aggregated per model:
- Artist exact match %
- Title exact match %
- Artist average fuzzy score
- Title average fuzzy score
- Overall score (average of all four)

## Terminal Output

```
┌──────────────────────────┬────────┬────────┬───────────┬───────────┬─────────┐
│ Model                    │ Artist │ Title  │ Artist    │ Title     │ Overall │
│                          │ Exact  │ Exact  │ Fuzzy Avg │ Fuzzy Avg │         │
├──────────────────────────┼────────┼────────┼───────────┼───────────┼─────────┤
│ mistral-small-3-2-25-06  │ 80%    │ 70%    │ 0.91      │ 0.87      │ 82.0%   │
│ mistral-large-3-25-12    │ 90%    │ 85%    │ 0.95      │ 0.93      │ 90.8%   │
└──────────────────────────┴────────┴────────┴───────────┴───────────┴─────────┘
```

## JSON Report

Saved to `eval/results/<timestamp>.json`:

```json
{
  "timestamp": "2026-02-23T14:30:00.000Z",
  "models": ["mistral-small-3-2-25-06", "..."],
  "cases": 10,
  "results": {
    "mistral-small-3-2-25-06": {
      "summary": { "artistExact": 0.8, "titleExact": 0.7, "artistFuzzy": 0.91, "titleFuzzy": 0.87, "overall": 0.82 },
      "details": [
        {
          "id": "radiohead-ok-computer",
          "expected": { "artist": "Radiohead", "title": "OK Computer" },
          "actual": { "artist": "Radiohead", "title": "OK Computer" },
          "scores": { "artistExact": 1, "titleExact": 1, "artistFuzzy": 1.0, "titleFuzzy": 1.0 }
        }
      ]
    }
  }
}
```

## Dependencies

- `@mistralai/mistralai` (already installed)
- No new dependencies needed. Levenshtein distance implemented inline (~15 lines).

## Error Handling

- Missing `MISTRAL_API_KEY` → exit with message
- Batch job fails → report failure in status table, skip in results
- Model doesn't support vision → batch job will fail, reported as such
- Malformed model response → scored as null (0 for exact, 0 for fuzzy)
