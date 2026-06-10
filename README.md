# 🤖 DevOps Intelligence Agent

> **Google Cloud Rapid Agent Hackathon** — Multi-partner submission  
> Tracks: **MongoDB · Elastic · GitLab · Arize · Fivetran**

An AI agent that wakes up when a GitLab pipeline fails, finds the root cause by querying Elastic logs and MongoDB incident history, enriches context via Fivetran, synthesizes a fix with Gemini, opens a GitLab issue (or patch PR), and logs every reasoning trace to Arize for auditability.

**On-call hell, solved.**

---

## 🎥 Demo Video

> [Watch 3-minute demo →](#) *(link added before submission)*

## 🌐 Live Demo

> [https://devops-agent-demo.example.com](https://devops-agent-demo.example.com) *(hosted URL added before submission)*

---

## ⚡ The Problem

Every engineering team knows the feeling: it's 2am, a pipeline fails on `main`, the on-call engineer wakes up, spends 40 minutes digging through logs, Slack threads, and Jira tickets to find a root cause that an LLM could have spotted in 10 seconds.

This agent eliminates that loop.

---

## 🏗️ Architecture

```
GitLab Pipeline Failure
        │
        ▼
 Webhook Server (Express)
        │
        ▼
 ┌──────────────────────────────────────────────────────┐
 │           DevOps Intelligence Agent                   │
 │                                                        │
 │  1. GitLab MCP ──── fetch job logs, diff, commit      │
 │  2. Elastic MCP ─── search error logs (last 30min)    │
 │  3. MongoDB MCP ─── find similar past incidents       │
 │  4. Fivetran MCP ── Jira tickets, PagerDuty, DB stats │
 │  5. Gemini ──────── synthesize root cause + fix       │
 │  6. GitLab MCP ──── open issue + patch PR             │
 │  7. Arize MCP ───── log full reasoning trace          │
 └──────────────────────────────────────────────────────┘
```

### Why each partner is **meaningful** (not decorative)

| Partner | Role | Without it |
|---------|------|-----------|
| **GitLab** | Source of truth — pipeline metadata, job logs, commit diffs, issue/PR creation | No trigger, no output |
| **Elastic** | Real-time log search — finds exact error lines across all jobs in seconds | Agent only sees truncated CI logs |
| **MongoDB** | Incident memory — stores every resolved failure so the agent learns from history | Every incident treated as brand new |
| **Fivetran** | Context enrichment — syncs Jira, PagerDuty, DB metrics for full situational awareness | Agent misses external context (known bugs, active alerts) |
| **Arize** | Agent observability — traces every LLM call so you can audit, debug, and detect drift | Zero visibility into what the agent decided and why |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 22+
- Docker + Docker Compose
- API keys for: Anthropic (or Google Cloud/Gemini), GitLab, Elastic, MongoDB Atlas, Arize, Fivetran

### 1. Clone and install

```bash
git clone https://github.com/your-org/devops-intelligence-agent
cd devops-intelligence-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run the demo (no live credentials needed)

```bash
node scripts/demo-failure.js
# Try different failure scenarios:
node scripts/demo-failure.js --scenario oom
node scripts/demo-failure.js --scenario db
node scripts/demo-failure.js --scenario test
```

### 4. Run with Docker (full stack)

```bash
docker-compose up
# Agent:     http://localhost:3000
# Dashboard: http://localhost:5173
# Kibana:    http://localhost:5601  (with --profile observability)
# Mongo UI:  http://localhost:8081  (with --profile observability)
```

### 5. Start the webhook server

```bash
npm run webhook
# POST http://localhost:3000/webhook/gitlab
```

### 6. Set up MongoDB + seed demo data

```bash
node scripts/setup-db.js
```

### 7. Test all integrations

```bash
npm test
```

---

## 📁 Project Structure

```
devops-intelligence-agent/
├── agent/
│   ├── index.js            # Core orchestrator — the agent brain
│   ├── gemini-client.js    # Gemini/Claude LLM client
│   ├── webhook-server.js   # Express webhook receiver
│   └── logger.js           # Structured logger
├── tools/
│   ├── gitlab.js           # GitLab MCP integration
│   ├── elastic.js          # Elastic MCP integration
│   ├── mongo.js            # MongoDB MCP integration
│   ├── arize.js            # Arize MCP integration
│   └── fivetran.js         # Fivetran MCP integration
├── scripts/
│   ├── demo-failure.js     # End-to-end demo (4 scenarios)
│   ├── test-integrations.js # Integration test suite
│   └── setup-db.js         # MongoDB seed script
├── dashboard/              # React live incident dashboard
├── cloud/
│   └── agent-builder.yaml  # Google Cloud Agent Builder config
├── .gitlab-ci.yml          # Sample monitored pipeline
├── docker-compose.yml      # Full local stack
└── Dockerfile              # Agent container
```

---

## 🎯 Demo Scenarios

| Scenario | Trigger | Root Cause | Auto-Fix |
|----------|---------|------------|---------|
| `default` | NullPointerException in UserService | Missing null-check on optional field | ✅ Patch PR |
| `oom` | Container OOMKilled | Node.js heap limit too low for webpack build | ✅ CI variable fix |
| `db` | DB migration failed | Pointing at read replica instead of primary | ✅ Env var fix |
| `test` | Jest suite 14 failures | Breaking API change in jsonwebtoken@9 | ✅ Patch PR |

---

## 🔧 Configuration

All configuration via environment variables. See `.env.example` for the full list.

Key variables:

```bash
ANTHROPIC_API_KEY=          # LLM backbone (swap for GOOGLE_CLOUD_PROJECT for Gemini)
GITLAB_TOKEN=               # GitLab personal access token (needs api scope)
GITLAB_WEBHOOK_SECRET=      # Shared secret for webhook validation
ELASTIC_URL=                # Elasticsearch cluster URL
ELASTIC_API_KEY=            # Elastic API key
MONGODB_URI=                # MongoDB Atlas connection string
ARIZE_API_KEY=              # Arize Phoenix API key
ARIZE_SPACE_ID=             # Arize space ID
FIVETRAN_API_KEY=           # Fivetran API key
FIVETRAN_API_SECRET=        # Fivetran API secret
```

---

## 🌩️ Google Cloud Deployment

```bash
# Deploy to Cloud Run
gcloud run deploy devops-intelligence-agent \
  --image gcr.io/YOUR_PROJECT/devops-agent:latest \
  --region us-central1 \
  --platform managed \
  --set-env-vars "NODE_ENV=production"

# Deploy Agent Builder config
gcloud agent-builder agents deploy \
  --config=cloud/agent-builder.yaml \
  --project=YOUR_PROJECT
```

The `cloud/agent-builder.yaml` file contains the full Google Cloud Agent Builder configuration with all 5 MCP server integrations pre-wired.

---

## 🧠 How the Agent Thinks

When a pipeline fails, the agent follows this reasoning chain:

1. **Gather** — Fetch pipeline metadata, failed job logs, and commit diff from GitLab
2. **Search** — Query Elasticsearch for error log patterns in a 30-minute window around the failure
3. **Remember** — Look up MongoDB for similar past incidents matching the error patterns
4. **Enrich** — Pull Jira tickets, PagerDuty alerts, and database metrics from Fivetran-synced sources
5. **Synthesize** — Send all context to Gemini with a structured prompt requesting JSON output: `{ title, rootCause, confidence, evidence, recommendedFix, patch }`
6. **Act** — Create a GitLab issue with the full analysis; if confidence ≥ 75%, open a patch MR
7. **Trace** — Log the complete reasoning trace to Arize Phoenix for auditability

Every step is observable. Every decision is traceable.

---

## 🔭 Arize Observability (The Differentiator)

Most agent submissions monitor the *application*. This one monitors the *agent itself*.

Every analysis run produces an Arize trace containing:
- The full input context sent to Gemini
- The raw LLM output
- Confidence score and evidence
- Token usage and latency
- Success/failure flag

This means you can:
- **Audit** why the agent reached a specific conclusion
- **Debug** cases where the root cause was wrong
- **Detect drift** if confidence scores drop over time
- **Compare** analysis quality across different failure types

---

## 📊 Dashboard

The React dashboard at `http://localhost:5173` shows:
- Live incident feed with real-time status updates
- Per-incident root cause analysis
- Partner integration badges (which tools were used)
- Confidence meter
- Links to GitLab issues, patch PRs, and Arize traces
- "Trigger Demo Failure" button for live demos

---

## 🏆 Hackathon Tracks

This submission qualifies for:
- ✅ **MongoDB track** — incident storage, similarity search, kv store, memory
- ✅ **Elastic track** — real-time log search, error pattern extraction
- ✅ **GitLab track** — pipeline trigger, job log fetching, issue + PR creation
- ✅ **Arize track** — full LLM observability, drift detection, trace logging
- ✅ **Fivetran track** — external data sync (Jira, PagerDuty, DB metrics)

---

## 🛡️ License

MIT — see [LICENSE](LICENSE)
# Rootiq
