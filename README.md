# Product Recommendation Agent Platform

A multi-project platform for building, configuring, and deploying product recommendation
agents. Each **project** is a fully independent agent with its own Google Sheet catalog,
LLM key (OpenAI, Anthropic, or none), guardrails, public REST API, and a WhatsApp-style
test chat — all managed from one admin dashboard.

## What's in here

- **Admin dashboard** (`/admin`) — password-protected. Create projects, wire up each
  one's Google Sheet, LLM provider/key, and guardrails, then test and grab the API URLs.
- **Public API per project** — `POST /api/:slug/recommend`, `GET /api/:slug/health`.
- **Test chat per project** — `/chat/:slug`, a WhatsApp-style UI wired to that project's API.
- **Postgres-backed** — all project configs persist across deploys. API keys and any
  project-specific Google service account JSON are encrypted at rest (AES-256-GCM).

## Architecture in one paragraph

One Express server, one Postgres database, N projects. Each project's Google Sheet
catalog and vocabulary live in an in-memory cache (refreshed on its own interval),
refreshed from Postgres-stored config. Each incoming `/api/:slug/recommend` request:
checks guardrail blocked-terms first (no LLM call needed to reject those), runs the
rule-based or LLM engine depending on whether that project has a valid API key, then
applies the project's price-cap guardrail to whatever came back. If the LLM call fails
for any reason, it silently falls back to the rule engine — the API never goes down for
lack of a working key.

## One-time setup

### 1. Get a Postgres database
Pick one:
- **Render**: Dashboard → New + → PostgreSQL → free tier is fine to start (note: Render's
  free Postgres expires after 90 days — fine for testing, plan to upgrade or migrate for
  production).
- **Neon** (neon.tech) or **Supabase** (supabase.com) — both have a permanent free tier,
  better for anything long-lived. Either way, you'll end up with a connection string like
  `postgres://user:pass@host/dbname`.

### 2. Generate two secrets
You need `ENCRYPTION_KEY` (encrypts stored API keys / service account JSON) and
`ADMIN_JWT_SECRET` (signs your dashboard login session). Use these freshly generated
ones, or make your own the same way (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`):

```
ENCRYPTION_KEY=84363cc4f3b0f2cf090a777b189c87b43e8340b96e90c2c45743bee103ddb475
ADMIN_JWT_SECRET=db6cbb6f22a0a7bcad53962d4e7c5dffe0bc5e73905b39bfcf39eb6ac50575cd
```

Treat these like passwords — anyone with `ENCRYPTION_KEY` who also gets a copy of your
database could decrypt every stored LLM key.

### 3. Pick an admin password
This gates `/admin` — one shared password (`ADMIN_PASSWORD`), not a full user system.
Choose something strong; it protects every project's LLM keys and configs.

## Environment variables (set these in Render → Environment)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string from step 1 |
| `ENCRYPTION_KEY` | From step 2 |
| `ADMIN_PASSWORD` | From step 3 |
| `ADMIN_JWT_SECRET` | From step 2 |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Default service account (Secret File), used by any project that doesn't set its own — same setup as before |
| `CATALOG_REFRESH_MS` | Default catalog refresh interval (ms), per-project overridable |
| `SESSION_TTL_MS` | How long a chat session stays alive with no activity |

The database schema is created automatically on first boot (see `migrations/001_init.sql`)
— you don't need to run anything manually.

## Using the platform

1. Deploy (see below), then visit `https://your-app.onrender.com/admin` and log in.
2. **+ New Project** → give it a name (e.g. "Manyavar Store"). This generates a slug
   (e.g. `manyavar-store`) that becomes part of its API/chat URLs.
3. **Sheet tab**: paste the Google Sheet ID and tab name. Leave the service account
   field blank to use the platform default (the sheet just needs to be shared with that
   service account's email, same as before) — or paste a project-specific service
   account JSON if this project's sheet lives under a different Google account.
   **Save**, then **Refresh now** to pull the catalog immediately.
4. **LLM tab**: pick `none` (rule-based only), `openai`, or `anthropic`, paste the API
   key, optionally set a model. Leave provider as `none` and the agent still works —
   just without LLM reasoning.
5. **Guardrails tab**: optional extra system instructions (only applies when an LLM key
   is set), blocked terms (works even without an LLM — these short-circuit before any
   engine runs), min/max price caps, and how many products to recommend at once (1-5).
6. **Test & Deploy tab**: shows the exact API URLs for this project, and a button to open
   its test chat.

Every project is fully isolated — different catalogs, different LLM keys, different
guardrails, different chat sessions. Nothing leaks between them.

## API (per project)

### `POST /api/:slug/recommend`
```json
{ "query": "a red sherwani for a wedding under 30000", "sessionId": "optional" }
```
Response is one of:
```json
{ "sessionId": "...", "action": "clarify", "question": "..." }
{ "sessionId": "...", "action": "recommend", "products": [...], "reasoning": "...", "engineUsed": "llm" }
{ "sessionId": "...", "action": "blocked", "message": "..." }
```
`action: "blocked"` means the query matched one of that project's blocked terms.

### `GET /api/:slug/health`
```json
{ "status": "ok", "project": "manyavar-store", "engine": "openai", "productsLoaded": 108, "lastRefreshed": "...", "lastRefreshError": null }
```

## Deploying (Render, web-only — same flow as before)

1. Push this repo to GitHub (same as previous versions — Add file → Upload files, or
   commit the changed/new files if you've already got the repo set up).
2. Render dashboard → your service → **Environment** → add all the variables from the
   table above. If you don't already have `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` and its
   Secret File set up from before, that setup is unchanged.
3. Save → redeploy. Watch the **Logs** tab: you should see
   `[db] migrations applied` and `[projectRegistry] loaded N project(s)` on boot. If
   Postgres isn't reachable, the server logs a clear fatal error and exits rather than
   limping along half-broken.
4. Visit `/admin`, log in, create your first project.

## Migrating your existing single-project setup into this

Your old `product-recommender-agent.onrender.com/api/recommend` and `/chat/*` won't
exist anymore after this deploy — the platform replaces them with `/api/:slug/...` and
`/chat/:slug`. To bring your existing Manyavar setup across:
1. Create a project named "Manyavar Store" in `/admin` (or any name — the slug is
   auto-generated).
2. Sheet tab: same Google Sheet ID you were already using.
3. LLM tab: same provider + paste your OpenAI key again (it wasn't stored anywhere
   the platform can read — you'll need to re-enter it once).
4. Your new URLs will be `/api/manyavar-store/recommend` and `/chat/manyavar-store`.

## Usage & Costs

The sidebar's **Usage & Costs** view (separate from any single project) shows LLM token
usage and estimated spend across every project for the last 30 days: total cost, request
count, input/output tokens, broken down per project. Click a project row to jump straight
into it.

This is populated automatically — every request that goes through a project's LLM engine
(OpenAI or Anthropic) logs its token counts to a `usage_logs` table (added automatically
via the same migration file, no manual step needed). Cost is estimated from a built-in
per-model pricing table in `src/pricing.js` — these are published rates as of when this
was built and **will drift over time**; treat the dollar figures as budgeting guidance,
not an exact reconciliation against your actual provider invoice. If you add a model that
isn't in that pricing table, usage still logs correctly (tokens are exact), just with an
estimated fallback rate for the cost figure.

Usage logging never blocks or fails a recommendation request — if the logging insert
fails for any reason, it's caught and logged server-side, the user-facing response is
unaffected.

## Testing a project

Each project's **Test & Deploy** tab now embeds the actual chat UI inline (an iframe
pointing at `/chat/:slug`) — no more jumping to a separate tab to test. A link to open it
in a full tab is still there below the embed if you want more room.

## Building any kind of agent, not just product recommendation

When you create a new agent, the wizard shows a set of suggested agent types
(FAQ & Support, Lead Qualification, Appointment Booking, Order Tracking,
Payment Reminder, Feedback Collector, General Purpose, or Custom) grounded in
common CPaaS use cases — pick one as a starting point or go fully custom.
Each pre-fills a base system prompt you can edit freely afterward.

The second step asks whether this agent needs a **connected data source**
(a Google Sheet):

- **Data source ON** (e.g. Product Recommendation): works exactly as
  described above — Sheet tab appears, catalog-matching engine, price caps,
  up-to-N recommendations.
- **Data source OFF** (most other types): no Sheet tab at all. The agent is
  a pure conversational LLM agent — it needs an LLM key to say anything
  useful (it'll tell the visitor as much if none is configured, rather than
  failing silently), and its replies are plain conversational text
  (`action: "reply"`) instead of the recommend/clarify shape.

Guardrails (system instructions, blocked terms, off-topic message) apply to
every agent type. Price caps and max-recommendations only show up for
data-source agents, since they're catalog-specific concepts.

## Usage & Costs — now with date/time detail

Each agent's own **Usage** tab (alongside Data Source/LLM/Guardrails/Test &
Deploy) shows, in addition to the 30-day totals: a daily cost trend for the
last 14 days, and a table of the most recent individual requests with exact
date and time, provider, model, and per-request token/cost breakdown —
useful for spotting exactly when a spike happened, not just that one did.

## Skills — connecting agents to external APIs

Every agent (catalog-based or generic) now has a **Skills** tab. A skill is a
single external HTTP API call the agent can invoke mid-conversation — an
order-status lookup, a live pricing endpoint, a CRM write, anything reachable
over HTTP. Under the hood this uses real LLM tool/function calling (OpenAI
and Anthropic both supported): the model sees each skill's name and
description as an available tool, decides for itself when to call one, the
platform executes the actual HTTP request, and feeds the result back to the
model — looping up to 3 rounds before it must produce a final answer.

**The description field is the only signal the model has** for deciding
when to use a skill — write it like you're briefing a new employee on when
this tool is relevant, not just what it technically does.

Configuring a skill:
- **Name** — a short internal identifier (letters/numbers/underscore), how the model refers to it.
- **Description** — required, at least a sentence — drives tool selection.
- **URL** — supports `{paramName}` placeholders substituted from the parameters you define.
- **Parameters** — name, type, description, required — becomes the tool's input schema.
- **Auth** — none, Bearer token, or a custom API-key header. The secret is
  encrypted at rest the same way LLM keys are, and the dashboard never shows
  it back once saved, only a "saved" indicator.
- **Body template** (POST/PUT/PATCH) — optional JSON template with the same
  `{paramName}` placeholders; if omitted, the parameters are sent as a plain
  JSON body.
- **Test this skill** — once saved, fire the real HTTP call directly (no LLM
  involved) with sample values to confirm it works before any agent relies
  on it.

**Security**: every skill call is checked against SSRF before it fires — the
platform refuses to call localhost, loopback, link-local (including cloud
metadata endpoints like `169.254.169.254`), or any RFC1918 private address
range, resolved via a real DNS lookup at call time (not just a string match
on the URL), and enforces an 8-second timeout with a response size cap fed
back to the model. Only `http`/`https` URLs are accepted.

**Token usage**: every round of the tool-calling loop counts toward that
request's token usage, summed and logged the same way as any other LLM
call — visible in the agent's Usage tab like normal.

**Rule-engine limitation**: skills only work when an LLM is configured — the
rule-based fallback engine has no reasoning capability, so it can't decide
when to call a tool. If the LLM call fails mid-conversation, the usual
fallback behavior applies (rule engine for catalog agents, a graceful
message for generic agents) and any pending tool call is simply not made
for that turn.

## Knowledge Base (RAG) — grounding answers in your own content

Every agent now has a **Knowledge** tab. Upload documents (PDF, DOCX, TXT, MD) or give it
a URL on your business website, and the agent retrieves relevant passages automatically
when answering — no need to write everything into system instructions by hand.

**How it works**: uploaded/crawled content is split into chunks, each chunk is converted
to a vector via OpenAI's embeddings API, and stored. On every user message, the query
itself is embedded and compared (cosine similarity, computed in-app rather than requiring
the `pgvector` Postgres extension, so this works on any Postgres host) against all of that
agent's chunks — the top 5 most relevant get quietly injected into the system prompt as
reference material before the LLM answers. This is standard retrieval-augmented generation.

**Embeddings need an OpenAI key, always** — Anthropic has no embeddings API. If an agent's
main provider is OpenAI, that same key is reused automatically. If it's Anthropic (or none),
the LLM tab has a separate **dedicated embeddings key** field that must be set for the
Knowledge Base to activate; without it, uploads/crawls are rejected with a clear message
rather than failing silently later.

**Website crawling**: give it any page URL and it indexes that page plus same-domain pages
it directly links to (shallow, one level deep, capped at 13 pages total). It respects a
basic `robots.txt` check (a blanket `Disallow: /` blocks the whole crawl) and reuses the
same SSRF protection built for Skills — every page fetch, including followed links, is
independently checked against private/internal address ranges.

**Re-indexing**: there's currently no automatic re-crawl schedule (unlike the Sheet catalog's
periodic refresh) — if a website's content changes, delete the source and re-add the URL to
re-index it. Worth building a scheduled refresh later if a client's site content changes often.

**Cost/latency note**: retrieval adds one embeddings API call per user message (small,
typically a fraction of a cent) plus a small latency cost for the similarity search — trivial
for realistic knowledge-base sizes (hundreds to low thousands of chunks), computed in memory.

## Security notes


- Blocked-term and price-cap guardrails are enforced in code, not just prompted to the
  LLM — they apply even when no LLM is configured, and they can't be bypassed by
  cleverly-worded prompts the way a system-prompt-only guardrail could.
- LLM API keys and any per-project service account JSON are AES-256-GCM encrypted before
  being written to Postgres; the dashboard only ever shows a masked preview, never the
  real value, once saved.
- The admin dashboard is a single shared password, not per-user accounts — fine for
  personal/small-team use, not intended for handing out to many separate people.
