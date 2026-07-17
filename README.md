# Product Recommendation Agent

A generic, deployable product recommendation API. It reads a product catalog
from a Google Sheet, understands free-text queries, asks a clarifying
question when a request is too vague, and returns up to 3 recommended
products. Works **with or without an LLM** — no code changes required to
switch between the two.

## How it decides

- **No `OPENAI_API_KEY` set** → rule-based engine. Extracts price ranges,
  category/tag matches (built dynamically from your sheet's own values), and
  keywords from the query. Asks a clarifying question if the query has no
  usable signal, matches nothing, or matches too many products ambiguously.
- **`OPENAI_API_KEY` set** → OpenAI-backed engine. Sends the conversation
  history plus a relevance-prefiltered slice of your catalog to OpenAI, which
  returns structured JSON deciding whether to ask a question or recommend.
  If the LLM call fails for any reason, the API automatically falls back to
  the rule engine rather than erroring out.

Either way, the response shape to your client is identical.

## Setup

1. **Google Sheet access**
   - Create a service account in Google Cloud Console and enable the Sheets API.
   - Download its JSON key file and place it on the server (do not commit it).
   - Share your product sheet with the service account's `client_email`
     (Viewer access is enough).
   - Your sheet just needs a header row — any column names work. Recommended
     columns: `id`, `name`, `category`, `price`, `description`, `tags`
     (comma or pipe separated), `imageUrl`. Anything else you add is passed
     through untouched.

2. **Configure**
   ```bash
   cp .env.example .env
   # fill in GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_KEY_PATH
   # optionally set OPENAI_API_KEY to enable the LLM engine
   ```

3. **Install & run**
   ```bash
   npm install
   npm start
   ```
   Server starts on `PORT` (default 3000) and logs which engine mode is active.

## API

### `POST /api/recommend`

Request:
```json
{ "query": "silk saree for a wedding under 5000", "sessionId": "optional-existing-session" }
```

- `query` (required): the user's free-text request.
- `sessionId` (optional): omit on the first call. The response returns a
  `sessionId` — pass it back on follow-up calls so the agent remembers
  context (e.g. it already knows "saree" when you answer "under 3000").
  Sessions expire after `SESSION_TTL_MS` of inactivity (default 15 min).

Response — clarifying question:
```json
{ "sessionId": "...", "action": "clarify", "question": "What kind of product are you looking for? For example: saree, jacket, sweater." }
```

Response — recommendation:
```json
{
  "sessionId": "...",
  "action": "recommend",
  "products": [
    { "id": "1", "name": "Blue Saree Silk", "category": "saree", "price": 4500, "description": "..." }
  ],
  "reasoning": "Only present when the LLM engine is active"
}
```

### `GET /api/health`
```json
{ "status": "ok", "engine": "rule", "productsLoaded": 42 }
```
Useful to confirm the sheet loaded correctly and see which engine is active.

## Deploying

Matches your usual Render/Node deployment: push to a repo, point Render at
it with `npm start`, add the env vars from `.env.example` in the Render
dashboard, and upload the service account JSON as a secret file (Render
supports this under "Secret Files" — reference its mounted path in
`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`).

## Notes / next steps you may want

- **Persistence for sessions**: currently in-memory (fine for a single
  instance). If you scale to multiple instances, swap `sessionStore.js` for
  Redis — the interface (`getOrCreate`, `getSession`) is small and easy to
  back with `ioredis`.
- **Catalog size**: the LLM engine caps candidates sent per request at 40
  products (pre-filtered by relevance) to keep token usage sane on large
  catalogs. Tune `buildCandidateList` in `src/engines/llmEngine.js` if needed.
- **Multiple sheets/tabs**: point `GOOGLE_SHEET_RANGE` at a specific tab name
  if you keep more than one sheet in the same spreadsheet.
