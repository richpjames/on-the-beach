# iOS Share Sheet Shortcut

An iOS Shortcut that lets you add music links to On the Beach directly from the share sheet in Safari or any other app.

## Actions

1. **Receive from Share Sheet** — accepts URLs shared from any app. If no input is provided, it stops and responds with "No input!".
2. **Get URLs from Input** — extracts just the URL from the share sheet input, discarding any page title.
3. **Get Contents of URL** — POSTs the URL to `https://onthebeach.ricojam.es/api/ingest/link`.
4. **Show Notification** — displays the API response so you can confirm the item was added or see an error.

## Setup

The "Get Contents of URL" step is configured as:

- **Method:** POST
- **Headers:** `Authorization: Bearer <INGEST_API_KEY>`
- **Request Body:** JSON
  - Key: `url`, Type: **URL**, Value: `Shortcut Input`

The `INGEST_API_KEY` value must match what is set in the server's environment.

## Known gotcha: share sheet input includes the page title

When sharing a webpage, iOS passes the share sheet input as `title\nurl` (page title, newline, URL) when coerced to text. If `Shortcut Input` is used directly as the `url` value in the POST body, the ingest endpoint receives a malformed URL and rejects it with 400.

The fix is a **"Get URLs from Input"** action between the Receive step and the POST step. It strips the title and returns only the URL. Use its output — not `Shortcut Input` — as the `url` value in the JSON body.
