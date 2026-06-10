# CLAUDE.md — DevOps Intelligence Agent

This file gives Claude complete context about every file in this project so it can assist with changes, debugging, and extensions without needing to re-read all source files each time.

---

## Project identity

**Name:** DevOps Intelligence Agent  
**Purpose:** An AI agent that wakes up when a GitLab CI pipeline fails, finds the root cause by querying Elastic logs and MongoDB incident history, enriches context via Fivetran, synthesizes a fix with Gemini/Claude, opens a GitLab issue or patch PR, and logs every reasoning step to Arize for auditability.  
**Hackathon:** Google Cloud Rapid Agent Hackathon — submitted to MongoDB, Elastic, GitLab, Arize, and Fivetran tracks.  
**Runtime:** Node.js 22+ ESM (`"type": "module"` in package.json). No TypeScript — plain modern JS throughout.  
**LLM:** Anthropic Claude (`claude-sonnet-4-20250514`) in development; swap `GeminiClient` for Google Vertex AI SDK in production.

---

## Repository layout

```
devops-intelligence-agent/
├── agent/
│   ├── index.js              # Core orchestrator — DevOpsAgent class
│   ├── gemini-client.js      # LLM client (Anthropic SDK, swap for Gemini)
│   ├── webhook-server.js     # Express server receiving GitLab webhooks
│   └── logger.js             # Structured logger (levels: debug/info/warn/error)
├── tools/
│   ├── gitlab.js             # GitLab REST API wrapper
│   ├── elastic.js            # Elasticsearch log search
│   ├── mongo.js              # MongoDB incident store
│   ├── arize.js              # Arize Phoenix OTLP trace logging
│   └── fivetran.js           # Fivetran enriched context (Jira, PagerDuty, DB)
├── scripts/
│   ├── demo-failure.js       # End-to-end demo runner (4 scenarios)
│   ├── test-integrations.js  # Integration test suite (14 tests)
│   └── setup-db.js           # MongoDB index + seed script
├── dashboard/
│   ├── src/App.jsx           # React live incident monitor
│   ├── src/main.jsx          # Vite entry point
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json          # react, react-dom, vite
│   └── Dockerfile
├── cloud/
│   └── agent-builder.yaml    # Google Cloud Agent Builder config (all 5 MCP servers)
├── .env.example              # All env vars documented
├── .gitignore
├── .gitlab-ci.yml            # Sample monitored pipeline + notify-agent-on-failure job
├── Dockerfile                # Multi-stage, non-root, tini, healthcheck
├── docker-compose.yml        # Full stack: agent + dashboard + ES + MongoDB + optional Kibana/Mongo Express
├── LICENSE                   # MIT
├── package.json
└── README.md                 # Devpost submission guide
```

---

## Environment variables

All loaded via `dotenv` from `.env`. All tools gracefully degrade to mock data when credentials are absent.

```bash
# LLM (required to run demo)
ANTHROPIC_API_KEY=

# Google Cloud / Gemini (production)
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_MODEL=gemini-2.0-flash-exp

# GitLab
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=                    # personal access token, api scope
GITLAB_WEBHOOK_SECRET=           # shared secret for webhook validation
GITLAB_PROJECT_ID=

# Elasticsearch
ELASTIC_URL=http://localhost:9200
ELASTIC_API_KEY=
ELASTIC_LOG_INDEX=pipeline-logs-*

# MongoDB
MONGODB_URI=mongodb://localhost:27017/devops_agent
MONGODB_DB=devops_agent

# Arize Phoenix
ARIZE_API_KEY=
ARIZE_SPACE_ID=
ARIZE_MODEL_ID=devops-intelligence-agent
PHOENIX_COLLECTOR_ENDPOINT=https://app.phoenix.arize.com

# Fivetran
FIVETRAN_API_KEY=
FIVETRAN_API_SECRET=

# Agent
WEBHOOK_PORT=3000
LOG_LEVEL=info                   # debug | info | warn | error
```

---

## npm scripts

```bash
npm run demo          # run default failure scenario
npm run demo:oom      # OOMKilled scenario
npm run demo:db       # DB migration failure scenario
npm run demo:test     # Jest test suite failure scenario
npm test              # run integration test suite (14 tests)
npm run setup:db      # create MongoDB indexes + seed 5 demo incidents
npm run webhook       # start webhook server on port 3000
npm start             # alias for webhook
npm run dashboard     # start React dashboard on port 5173
npm run docker:up     # docker-compose up --build (full stack)
npm run docker:obs    # docker-compose with Kibana + Mongo Express profiles
```

---

## Agent flow (agent/index.js)

`DevOpsAgent.handlePipelineFailure(event)` is the single entry point. It runs these steps in order:

1. `arize.startTrace()` — open an OTLP trace span for the entire run
2. `gitlab.getPipeline()` + `gitlab.getFailedJobs()` + `gitlab.getCommit()` — fetch pipeline context in parallel; then `gitlab.getJobLog()` for each failed job (first 8000 chars, last N chars strategy)
3. `elastic.searchLogs()` — query ES for error logs in a 30-minute window around the failure
4. `mongo.findSimilarIncidents()` — find past incidents with overlapping error patterns; scored by overlap count
5. `fivetran.getEnrichedContext()` — fetch Jira tickets, PagerDuty alerts, DB metrics in parallel via `Promise.allSettled`
6. `gemini.analyzeFailure()` — build a structured prompt and call the LLM; parse JSON response
7. `gitlab.createIssue()` — always create an issue with the full analysis
8. If `analysis.confidence >= 0.75` and `analysis.patch` exists → `gitlab.createPatchPR()` — create branch, upsert files, open MR
9. `mongo.saveIncident()` — persist the complete incident record
10. `arize.endTrace()` — flush the OTLP span with input/output/tokens/latency
11. Return `{ incidentId, analysis, resolution, incident }`

On any error: end the Arize trace with `success: false`, create a fallback GitLab issue flagging the agent failure, then re-throw.

---

## File-by-file reference

### agent/index.js

**Class:** `DevOpsAgent`

**Constructor:** instantiates all 5 tools + GeminiClient.

**Key methods:**

| Method | Purpose |
|--------|---------|
| `handlePipelineFailure(event)` | Main entry — full 10-step flow |
| `fetchPipelineContext(event, incidentId)` | Parallel GitLab API calls for pipeline/jobs/commit/logs |
| `executeResolution(analysis, event, incidentId)` | Creates issue; optionally opens patch PR |
| `formatIssueBody(analysis, event, incidentId)` | Markdown template for GitLab issue body |
| `formatPRBody(analysis, incidentId)` | Markdown template for MR description |

**GitLab issue template** includes: incident ID, pipeline link, branch, commit SHA, confidence %, root cause, evidence list, similar incidents, recommended fix, patch PR link, Fivetran external context, Arize trace link.

**Auto-patch threshold:** `analysis.confidence >= 0.75` AND `analysis.patch` is non-null. Branch name format: `fix/agent-{incidentId.slice(0,8)}`.

---

### agent/gemini-client.js

**Class:** `GeminiClient`

**Model:** `claude-sonnet-4-20250514` (Anthropic SDK). To switch to Gemini: replace `@anthropic-ai/sdk` with `@google-cloud/vertexai` and update the client instantiation.

**System prompt:** Instructs the LLM to act as an elite DevOps agent, return only a JSON object matching a strict schema, never hallucinate log lines.

**JSON output schema:**
```json
{
  "title": "string (<60 chars)",
  "rootCause": "string (2-4 sentences)",
  "confidence": 0.0,
  "confidenceLabel": "high|medium|low",
  "evidence": [{ "source": "string", "detail": "string" }],
  "similarIncidents": [{ "date": "YYYY-MM-DD", "summary": "string", "resolutionTime": "string" }],
  "recommendedFix": "string",
  "patch": null | [{ "filename": "string", "content": "string", "diff": "string" }],
  "patchDescription": "string",
  "externalContext": "string | null",
  "tokensUsed": 0
}
```

**`buildPrompt()`** assembles a markdown document with sections: Pipeline Failure Context, Failed Jobs, Commit Info, Job Logs (truncated), Elastic Log Analysis, Similar Past Incidents (MongoDB), Enriched Context (Fivetran).

**`fallbackAnalysis(rawText)`** returns a low-confidence stub when JSON parsing fails.

---

### agent/webhook-server.js

**Framework:** Express 4  
**Port:** `process.env.WEBHOOK_PORT || 3000`

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/webhook/gitlab` | Receive GitLab pipeline events. Validates `X-Gitlab-Token` header. Only processes `Pipeline Hook` events with `status === 'failed'`. Pushes to queue and returns immediately. |
| `GET` | `/health` | Returns `{ status, queue, processing, uptime }` |
| `POST` | `/trigger` | Manual trigger for testing (disabled in production via `NODE_ENV` check) |

**Queue:** Simple array with `processing` flag. Prevents thundering-herd when multiple pipelines fail simultaneously. Processes serially.

---

### agent/logger.js

Simple structured logger. Levels mapped to integers (debug=0, info=1, warn=2, error=3). Format: `[ISO timestamp] LEVEL message {meta JSON}`. Level controlled by `LOG_LEVEL` env var.

---

### tools/elastic.js

**Class:** `ElasticTool`

**Auth:** `ApiKey` header if `ELASTIC_API_KEY` is set; unauthenticated otherwise (local dev).

**`searchLogs({ projectId, pipelineId, sha, ref, timeWindow })`**

Sends a bool query to ES with:
- `range` filter: last `timeWindow` (default `30m`)
- `should` clauses matching pipeline ID, project ID, git SHA, git ref
- `filter` restricting to log levels: error, fatal, critical, warn
- Aggregations: `significant_text` for error patterns, `terms` for log levels, `terms` for top error messages

Returns: `{ summary, errorPatterns, topErrors, rawLines, totalErrors }`

**Mock fallback:** Returns hardcoded mock data (`_mockResponse()`) when Elastic is unreachable — allows demo to run without a live cluster.

**Index:** `process.env.ELASTIC_LOG_INDEX || 'pipeline-logs-*'`

---

### tools/mongo.js

**Class:** `MongoTool`

**Connection:** Lazy — connects on first call, reuses thereafter. Timeout: 5s server selection, 8s connect.

**Collections:**
- `incidents` — one document per resolved pipeline failure
- `kv_store` — generic key-value persistence for agent state

**Indexes (created by `ensureIndexes()`):**
- `incidents`: `{ projectId, resolvedAt }` descending, `{ errorPatterns }`, `{ incidentId }` unique
- `kv_store`: `{ key }` unique

**Key methods:**

| Method | Purpose |
|--------|---------|
| `saveIncident(incident)` | Insert incident record. Non-fatal on failure. |
| `findSimilarIncidents({ projectId, errorPatterns, ref, limit })` | Find incidents with overlapping error patterns. Scores by overlap count. Falls back to mock if DB unavailable. |
| `getProjectStats(projectId)` | Aggregates total/recent incident counts and avg resolution time. |
| `kvSet(key, value)` | Upsert key-value pair. |
| `kvGet(key)` | Get value by key. |
| `close()` | Close MongoDB connection. |

**Similarity algorithm:** `$elemMatch: { $in: errorPatterns }` on both `projectId` and `ref` (OR). Then score each result by the count of overlapping error patterns. Sort by score desc, then `resolvedAt` desc.

**Incident document shape:**
```js
{
  incidentId, projectId, pipelineId, sha, ref,
  logs,           // string summary from Elastic
  errorPatterns,  // string[]
  rootCause,      // string
  confidence,     // number 0-1
  resolution: { issueUrl, issueId, prUrl, prId },
  similarIncidentsFound, // number
  resolvedAt,     // Date
  durationMs,     // number
  createdAt       // Date
}
```

---

### tools/gitlab.js

**Class:** `GitLabTool`

**Auth:** `PRIVATE-TOKEN` header using `GITLAB_TOKEN`.

**`request(path, options)`** — base method. Throws on non-2xx. Returns JSON or text based on Content-Type.

**Key methods:**

| Method | Purpose |
|--------|---------|
| `getPipeline(projectId, pipelineId)` | GET pipeline details |
| `getFailedJobs(projectId, pipelineId)` | GET jobs scoped to `failed`, up to 20 |
| `getCommit(projectId, sha)` | GET commit with stats |
| `getJobLog(projectId, jobId, maxChars=10000)` | GET job trace log; strips ANSI codes; returns last N chars |
| `createIssue({ projectId, title, body, labels })` | POST issue |
| `createPatchPR({ projectId, sourceBranch, targetBranch, title, description, patch, sha })` | Creates branch from SHA, upserts each file in patch array, opens MR |
| `upsertFile({ projectId, branch, file })` | PUT or POST file depending on existence |
| `getOpenMRs(projectId)` | GET open MRs (enriched context) |

**Patch PR flow:** (1) create branch from failing SHA, (2) loop over `patch` array calling `upsertFile` for each, (3) open MR with `labels: 'auto-fix,needs-review'` and `remove_source_branch: true`.

---

### tools/arize.js

**Class:** `ArizeTool`

**Protocol:** OTLP/HTTP JSON sent to `${PHOENIX_COLLECTOR_ENDPOINT}/v1/traces`

**Auth:** `api_key` and `space_id` headers.

**Enabled:** only when both `ARIZE_API_KEY` and `ARIZE_SPACE_ID` are set. Falls back to local logging only.

**`startTrace({ incidentId, event, input })`** — generates `traceId` and `spanId` (both UUIDs), records `startTime`. Returns context object.

**`endTrace(ctx, { output, incidentId, success, durationMs, tokensUsed, error })`** — builds OTLP span with all attributes, calls `_flush()`, returns trace URL string or null.

**Span attributes logged:**
- `openinference.span.kind`: `CHAIN`
- `input.value` / `output.value`: first 2000/4000 chars
- `llm.model_name`
- `llm.token_count.total`
- `metadata.incident_id`, `metadata.success`, `metadata.duration_ms`
- `exception.message` (if error)

**`logLLMSpan()`** — optional child span for individual LLM calls (tracks per-call tokens and latency).

**`_traceUrl(traceId)`** — returns `${endpoint}/spaces/${spaceId}/traces/${traceId}` for embedding in GitLab issues.

---

### tools/fivetran.js

**Class:** `FivetranTool`

**Auth:** HTTP Basic (`apiKey:apiSecret` base64).

**Enabled:** only when both `FIVETRAN_API_KEY` and `FIVETRAN_API_SECRET` are set. Falls back to `_mockEnrichedContext()`.

**`getEnrichedContext({ projectId, sha, ref })`** — runs `getJiraTickets()`, `getPagerDutyAlerts()`, `getDbMetrics()` in parallel via `Promise.allSettled`. Returns combined object with `jiraTickets`, `pagerDutyAlerts`, `dbMetrics`, `fetchedAt`.

**In production:** Each method queries Fivetran-synced tables in BigQuery/Snowflake via SQL. The current implementation calls the Fivetran Metadata API to find the relevant connector, then calls a destination query helper (which returns empty in this implementation — to be wired up per deployment).

**Mock enriched context:** Includes 2 Jira tickets (DB timeout, CI flakiness), 1 PagerDuty alert (for main branch only), DB metrics (CPU 72%, 143/200 connections, P99 latency 890ms, replication lag 1200ms).

**Additional methods:**
- `getSyncStatus()` — list all connectors with sync state, useful for health checks
- `triggerSync(connectorId)` — force a sync before analysis if needed

---

### scripts/demo-failure.js

Simulates a complete pipeline failure cycle with colored terminal output. Works without live credentials (all tools fall back to mocks).

**4 scenarios** (select with `--scenario <name>`):

| Key | Project | Branch | Failure type |
|-----|---------|--------|-------------|
| `default` | backend-api | main | NullPointerException in UserService |
| `oom` | data-pipeline | feature/heavy-data-processing | OOMKilled — Node.js heap |
| `db` | core-platform | release/v2.4.0 | DB migration — connection refused |
| `test` | frontend-app | feat/user-auth-refactor | Jest — 14 tests failed |

**`patchWithLogging(agent)`** — monkey-patches all tool methods to print step-by-step terminal output for each phase of the analysis. Each patched method calls the original, then prints results.

**Terminal output format:** ANSI colored banners, step numbers, detail rows, success/warning indicators.

---

### scripts/test-integrations.js

14 integration tests across all 5 partners + the LLM. Exit 0 = all pass, exit 1 = any failure.

**Test sections:**
- Elastic: health check, searchLogs structure validation
- MongoDB: connect + ping, ensureIndexes, saveIncident + findSimilar round-trip (with cleanup), kvSet/kvGet round-trip (with cleanup)
- GitLab: API reachable (version endpoint), getOpenMRs (requires `GITLAB_PROJECT_ID`)
- Arize: startTrace returns context with traceId/spanId, endTrace flushes span
- Fivetran: getEnrichedContext returns correct structure, getSyncStatus (skipped if no credentials)
- Gemini: analyzeFailure returns valid JSON schema for a real failure scenario

---

### scripts/setup-db.js

Creates MongoDB indexes via `mongo.ensureIndexes()`, then upserts 5 seed incidents using `$setOnInsert` (idempotent — safe to run multiple times).

**Seed incidents cover:** NullPointerException (main), DB connection pool (main), Jest cache miss (feature/auth), OOMKilled webpack (main), DB migration read-replica (release/v2.3.0).

---

### dashboard/src/App.jsx

React SPA. No router — single page.

**State:** `incidents` array, `selected` incident, `agentStatus`, `stats`.

**Key components:**

| Component | Purpose |
|-----------|---------|
| `IncidentCard` | Clickable list item — project name, pipeline #, branch, status badge, partner badges, time ago |
| `DetailPane` | Right panel — root cause, confidence meter, error patterns, partner badges, action links (issue, PR, Arize trace), resolution time |
| `PartnerBadge` | Colored pill for each partner integration |
| `StatusBadge` | `resolved` (green) / `analyzing` (amber, pulsing dot) / `failed` (red) |
| `ConfidenceMeter` | Progress bar 0–100% with color-coded label |

**`simulateFailure()`** — demo trigger that animates a new incident through the full lifecycle: `analyzing` → partners appear one by one as badges → `resolved` with root cause, issue URL, and PR URL. Uses `setTimeout` delays to simulate agent steps.

**MOCK_INCIDENTS:** 3 pre-seeded incidents (resolved NullPointer, resolved OOM, pending/analyzing migration).

**No external dependencies** beyond React — all styling is inline CSS using CSS variables for dark/light mode compatibility.

---

### cloud/agent-builder.yaml

Google Cloud Agent Builder configuration declaring all 5 MCP servers.

**LLM:** `gemini-2.0-flash-exp` on `us-central1`.

**MCP servers declared:**
- `elastic-mcp`: `search_elastic_logs` tool
- `mongodb-mcp`: `query_mongodb_incidents` + `save_mongodb_incident` tools
- `gitlab-mcp`: `get_pipeline_context` + `create_gitlab_issue` + `create_gitlab_mr` tools
- `arize-mcp`: `log_arize_trace` tool
- `fivetran-mcp`: `get_fivetran_context` tool

**Trigger:** Webhook at `POST /webhook/gitlab`, filtered to `status == "failed"`.

**Memory:** MongoDB-backed agent memory collection.

**Guardrails:** Max 20 tool calls per run, 120s timeout, fallback to GitLab issue creation on error.

**Deploy command:** `gcloud agent-builder agents deploy --config=cloud/agent-builder.yaml`

---

### Dockerfile

Multi-stage Alpine build. Stages: `base` (node:22-alpine + tini), `deps` (npm ci --omit=dev), `production` (copy from deps, add non-root user `agent:1001`).

Non-root user, healthcheck via wget to `/health`, tini as PID 1 for signal handling. Exposes port 3000.

---

### docker-compose.yml

Services:

| Service | Image | Port | Notes |
|---------|-------|------|-------|
| agent | local build | 3000 | Depends on ES + Mongo health |
| dashboard | local build (dashboard/) | 5173 | Depends on agent |
| elasticsearch | elastic 8.13.0 | 9200 | Single-node, no auth |
| mongo | mongo 7.0 | 27017 | |
| kibana | elastic kibana 8.13.0 | 5601 | `--profile observability` only |
| mongo-express | mongo-express latest | 8081 | `--profile observability` only |

ES healthcheck: curl to `/_cluster/health` every 20s, 40s start period.  
Mongo healthcheck: `mongosh --eval db.adminCommand('ping')` every 10s.

Agent hot-reload: `agent/` and `tools/` mounted as read-only volumes.

---

### .gitlab-ci.yml

Pipeline stages: lint → test → build → deploy.

**`notify-agent-on-failure`** — runs at `.post` stage `when: on_failure`. Sends a `curl` POST to `$DEVOPS_AGENT_WEBHOOK_URL/webhook/gitlab` with the full pipeline failure event JSON assembled from GitLab CI predefined variables.

**Integration test job** starts mongo and Elasticsearch as CI services, sets `MONGODB_URI` and `ELASTIC_URL` for the test run.

**Deploy jobs** use `google/cloud-sdk:alpine` to deploy to Cloud Run. Production deploy is `when: manual` and triggered by version tags (`v*.*.*`).

---

## Common tasks for Claude

### Add a new demo scenario

In `scripts/demo-failure.js`, add an entry to the `SCENARIOS` object following the existing pattern. The event shape must match the GitLab Pipeline Hook webhook payload format.

### Change the LLM

In `agent/gemini-client.js`, replace the Anthropic SDK import and client instantiation with the Google Vertex AI SDK:

```js
import { VertexAI } from '@google-cloud/vertexai';
const vertex = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT });
const model = vertex.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
```

Update `analyzeFailure()` to call `model.generateContent()` and parse its response.

### Add a new partner tool

1. Create `tools/newpartner.js` with a class `NewPartnerTool` exporting a clean public API
2. Import and instantiate it in `agent/index.js` constructor
3. Call it in `handlePipelineFailure()` at the appropriate step
4. Add a test section in `scripts/test-integrations.js`
5. Add the MCP server declaration to `cloud/agent-builder.yaml`
6. Add the env var(s) to `.env.example`

### Change the confidence threshold for auto-patching

In `agent/index.js`, find `executeResolution()`. The threshold is `analysis.confidence >= 0.75`. Change this value.

### Adjust MongoDB similarity matching

In `tools/mongo.js`, `findSimilarIncidents()`. The current query uses `$elemMatch: { $in: errorPatterns }` as a boolean match. To make it stricter (require N overlapping patterns), add a post-filter on `_score` after the in-memory scoring step.

### Debug a specific step

Set `LOG_LEVEL=debug` in `.env`. This enables verbose output from all tool methods including ES query details, MongoDB query results, Arize flush responses, and Gemini prompt lengths.

### Run only the LLM analysis without live integrations

Call `GeminiClient.analyzeFailure()` directly with mock data — all inputs are plain JS objects so no live connections are needed. See the Gemini test in `scripts/test-integrations.js` for the exact shape.

---

## Key design decisions

**All tools degrade gracefully.** Every tool catches its own errors and either returns mock data or an empty result rather than throwing. The agent can complete a full run even with zero live credentials (except the LLM).

**Queue-based webhook handling.** The webhook endpoint returns `200` immediately and pushes to an in-process queue. This prevents GitLab from timing out and prevents thundering-herd on multi-job failures.

**Arize as a meta-layer.** Arize observes the agent itself, not the application. This means you can audit every root-cause decision, track confidence drift over time, and compare LLM accuracy against human-resolved incidents — none of which the other partner integrations provide.

**Job log truncation strategy.** Rather than the first N characters of a job log (which contains mostly setup output), `getJobLog()` returns the **last** N characters — where errors always appear.

**Patch confidence gate.** Auto-patching only triggers at ≥75% confidence to prevent noisy or incorrect MRs. The LLM is explicitly instructed to rate confidence honestly and penalise itself when evidence is insufficient.

**ESM throughout.** `"type": "module"` in package.json means all files use `import`/`export`. No CommonJS `require()` calls anywhere. All dynamic imports must use `import()`.
