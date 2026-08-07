# iOS Share Sheet Shortcut

An iOS Shortcut that lets you add music links to On the Beach directly from the share sheet in Safari or any other app.

> Prefer a native app entry in the share sheet (no per-device Shortcut setup)?
> See `docs/ios-native-app.md` for the Capacitor shell + native Share Extension.
> Both approaches post to the same `POST /api/ingest/link` endpoint.

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

## Sharing photos (including several at once)

The Shortcut above only handles links. To add record sleeves from Photos — where
selecting several and sharing them is the normal case — add an **Images** input
type to the Receive step and post each photo separately, because
`POST /api/ingest/photo` saves, scans, and files **one** image per request:

1. **Receive from Share Sheet** — tick **Images** alongside URLs.
2. **Repeat with Each** (over `Shortcut Input`) — one pass per selected photo.
3. **Get Contents of URL** inside the repeat:
   - **URL:** `https://onthebeach.ricojam.es/api/ingest/photo`
   - **Method:** POST
   - **Headers:** `Authorization: Bearer <INGEST_API_KEY>`
   - **Request Body:** Form
     - Key: `photo`, Type: **File**, Value: `Repeat Item`
     - Optionally `listNames` (Text, one field per list) and `remindAt`
       (Text, `yyyy-MM-dd`) — the same fields the native Share Extension sends.
4. **Show Notification** after the repeat, so one summary appears rather than one
   per photo.

The endpoint accepts either multipart form data (as above, what Shortcuts sends
for a File field) or JSON with a base64 `imageBase64`. Each photo becomes its own
item, filed into the same lists.

> The native Share Extension (`docs/ios-native-app.md`) does all of this without
> per-device setup, including a multi-photo share with a progress caption and a
> retry that skips the photos already added.

## Known gotcha: share sheet input includes the page title

When sharing a webpage, iOS passes the share sheet input as `title\nurl` (page title, newline, URL) when coerced to text. If `Shortcut Input` is used directly as the `url` value in the POST body, the ingest endpoint receives a malformed URL and rejects it with 400.

The fix is a **"Get URLs from Input"** action between the Receive step and the POST step. It strips the title and returns only the URL. Use its output — not `Shortcut Input` — as the `url` value in the JSON body.
