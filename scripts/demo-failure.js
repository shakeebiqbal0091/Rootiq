// scripts/demo-failure.js — End-to-end demo runner for DevOps Intelligence Agent
//
// Usage:
//   npm run demo                  # default scenario (NullPointerException)
//   npm run demo -- --scenario oom    # OOMKilled — Node.js heap
//   npm run demo -- --scenario db     # DB migration failure
//   npm run demo -- --scenario test   # Jest test suite failures
//
// Works without any live credentials — all tools fall back to mock data.
// The ANTHROPIC_API_KEY is required for real LLM analysis; without it
// a realistic fallback analysis is generated locally.

import 'dotenv/config';
import { DevOpsAgent } from '../agent/index.js';
import logger from '../agent/logger.js';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgRed:  '\x1b[41m',
  bgGreen:'\x1b[42m',
  bgBlue: '\x1b[44m',
};

const banner = (text, color = C.bgBlue) =>
  console.log(`\n${color}${C.bold} ${text.padEnd(70)} ${C.reset}\n`);

const step = (num, label) =>
  console.log(`${C.cyan}${C.bold}  [${num}/10]${C.reset} ${C.white}${label}${C.reset}`);

const detail = (label, value, color = C.dim) =>
  console.log(`         ${color}${label}:${C.reset} ${value}`);

const ok = (msg) =>
  console.log(`  ${C.green}✓${C.reset} ${msg}`);

const warn = (msg) =>
  console.log(`  ${C.yellow}⚠${C.reset}  ${msg}`);

const separator = () =>
  console.log(`  ${C.dim}${'─'.repeat(68)}${C.reset}`);

// ---------------------------------------------------------------------------
// Failure scenarios
// ---------------------------------------------------------------------------

// Always use the real project ID from env so GitLab API calls hit the right project.
// Falls back to a placeholder string that triggers mock mode gracefully.
const REAL_PROJECT_ID = process.env.GITLAB_PROJECT_ID || 'MISSING_PROJECT_ID';
const GITLAB_BASE_URL = process.env.GITLAB_URL || 'https://gitlab.com';

const SCENARIOS = {
  default: {
    name: 'NullPointerException — UserService',
    event: {
      object_kind: 'pipeline',
      object_attributes: {
        id: 10042,
        status: 'failed',
        ref: 'main',
        sha: 'a1b2c3d4e5f6',
        url: `${GITLAB_BASE_URL}/example/backend-api/-/pipelines/10042`,
      },
      project: { id: REAL_PROJECT_ID, name: 'backend-api', web_url: `${GITLAB_BASE_URL}/example/backend-api` },
      user: { name: 'Shakeeb Dev' },
    },
    mockOverrides: {
      jobLog: `
[05:30:01] $ mvn test --no-transfer-progress
[05:30:10] [INFO] Running com.example.UserServiceTest
[05:30:12] [ERROR] Tests run: 4, Failures: 0, Errors: 1
[05:30:12] [ERROR] com.example.UserServiceTest.testGetUserById_NullCache
[05:30:12] [ERROR] java.lang.NullPointerException: Cannot invoke "User.getId()" because "user" is null
[05:30:12] [ERROR]   at UserService.getUserById(UserService.java:142)
[05:30:13] [INFO] BUILD FAILURE
[05:30:13] Process finished with exit code 1`.trim(),
      errorPatterns: ['NullPointerException', 'UserService', 'getUserById'],
    },
  },

  oom: {
    name: 'OOMKilled — Node.js heap exhausted',
    event: {
      object_kind: 'pipeline',
      object_attributes: {
        id: 20077,
        status: 'failed',
        ref: 'feature/heavy-data-processing',
        sha: 'b2c3d4e5f6a7',
        url: 'https://gitlab.com/example/data-pipeline/-/pipelines/20077',
      },
      project: { id: REAL_PROJECT_ID, name: 'data-pipeline', web_url: `${GITLAB_BASE_URL}/example/data-pipeline` },
      user: { name: 'CI Runner' },
    },
    mockOverrides: {
      jobLog: `
[06:15:01] $ node --max-old-space-size=1536 scripts/build.js
[06:15:44] <--- Last few GCs --->
[06:15:44] [20449:0x5abf8e0]  87042 ms: Mark-sweep 1487.8 (1535.9) -> 1487.1 (1535.9) MB
[06:15:44] FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
[06:15:44] Writing Node.js report to the current directory.
[06:15:44] Aborted (core dumped)
[06:15:44] ERROR: Job failed: exit code 134`.trim(),
      errorPatterns: ['heap out of memory', 'OOMKilled', 'Allocation failed', 'JavaScript heap'],
    },
  },

  db: {
    name: 'DB Migration failure — connection refused',
    event: {
      object_kind: 'pipeline',
      object_attributes: {
        id: 30014,
        status: 'failed',
        ref: 'release/v2.4.0',
        sha: 'c3d4e5f6a7b8',
        url: 'https://gitlab.com/example/core-platform/-/pipelines/30014',
      },
      project: { id: REAL_PROJECT_ID, name: 'core-platform', web_url: `${GITLAB_BASE_URL}/example/core-platform` },
      user: { name: 'Release Bot' },
    },
    mockOverrides: {
      jobLog: `
[09:02:01] $ bundle exec rake db:migrate
[09:02:03] == 20260605142301 AddUserRoles: migrating ======
[09:02:03] -- add_column(:users, :role, :string)
[09:02:08] rake aborted!
[09:02:08] PG::ConnectionBad: could not connect to server: Connection refused
[09:02:08]   Is the server running on host "postgres-primary" (10.0.1.4) and accepting TCP/IP connections on port 5432?
[09:02:08] Tasks: TOP => db:migrate
[09:02:08] Process finished with exit code 1`.trim(),
      errorPatterns: ['PG::ConnectionBad', 'could not connect', 'Connection refused', 'db:migrate'],
    },
  },

  test: {
    name: 'Jest — 14 tests failed after auth refactor',
    event: {
      object_kind: 'pipeline',
      object_attributes: {
        id: 40055,
        status: 'failed',
        ref: 'feat/user-auth-refactor',
        sha: 'd4e5f6a7b8c9',
        url: 'https://gitlab.com/example/frontend-app/-/pipelines/40055',
      },
      project: { id: REAL_PROJECT_ID, name: 'frontend-app', web_url: `${GITLAB_BASE_URL}/example/frontend-app` },
      user: { name: 'Shakeeb Dev' },
    },
    mockOverrides: {
      jobLog: `
[08:10:01] $ npx jest --ci --runInBand
[08:10:22] FAIL tests/auth/AuthService.test.js
[08:10:22]   ● AuthService › refreshToken › should invalidate expired tokens
[08:10:22]     Cannot find module './auth.cache' from 'src/auth/AuthService.js'
[08:10:22]     Require stack: src/auth/AuthService.js > ./auth.cache
[08:10:22] FAIL tests/auth/UserSession.test.js (11 more failures)
[08:10:22] Tests: 14 failed, 38 passed, 52 total
[08:10:22] Snapshots: 0 total
[08:10:22] Process finished with exit code 1`.trim(),
      errorPatterns: ['Jest', 'Cannot find module', 'auth.cache', 'FAIL'],
    },
  },
};

// ---------------------------------------------------------------------------
// Patch tools to print step-by-step terminal output
// ---------------------------------------------------------------------------

function patchWithLogging(agent, scenario) {
  const overrides = scenario.mockOverrides ?? {};

  // --- Elastic: override error patterns to match scenario ---
  const origSearchLogs = agent.elastic.searchLogs.bind(agent.elastic);
  agent.elastic.searchLogs = async (args) => {
    step('3', 'Searching Elasticsearch logs...');
    const result = await origSearchLogs(args);
    // Inject scenario-specific patterns
    result.errorPatterns = overrides.errorPatterns ?? result.errorPatterns;
    result.summary = `Found ${result.totalErrors} error log(s). Patterns: ${result.errorPatterns.slice(0,3).join(', ')}`;
    ok(`Elastic: ${result.totalErrors} errors, ${result.errorPatterns.length} patterns`);
    detail('patterns', result.errorPatterns.join(', '), C.red);
    return result;
  };

  // --- MongoDB: log similar incident results ---
  const origFindSimilar = agent.mongo.findSimilarIncidents.bind(agent.mongo);
  agent.mongo.findSimilarIncidents = async (args) => {
    step('4', 'Querying MongoDB for similar incidents...');
    const result = await origFindSimilar(args);
    ok(`MongoDB: ${result.length} similar incident(s) found`);
    for (const inc of result.slice(0, 2)) {
      const conf = inc.confidence != null ? `${(inc.confidence*100).toFixed(0)}%` : 'n/a';
      detail('match', `${inc.incidentId} — confidence ${conf}`, C.yellow);
    }
    return result;
  };

  // --- Fivetran: log enriched context ---
  const origGetEnriched = agent.fivetran.getEnrichedContext.bind(agent.fivetran);
  agent.fivetran.getEnrichedContext = async (args) => {
    step('5', 'Fetching enriched context via Fivetran...');
    const result = await origGetEnriched(args);
    ok(`Fivetran: ${result.jiraTickets?.length ?? 0} Jira tickets, ${result.pagerDutyAlerts?.length ?? 0} PagerDuty alerts`);
    if (result.dbMetrics) {
      detail('DB CPU', `${result.dbMetrics.cpuPercent}%`, C.yellow);
      detail('connections', `${result.dbMetrics.activeConnections}/${result.dbMetrics.maxConnections}`);
      detail('replication lag', `${result.dbMetrics.replicationLagMs}ms`, result.dbMetrics.replicationLagMs > 1000 ? C.red : C.dim);
    }
    return result;
  };

  // --- GitLab: inject scenario job log, log all actions ---
  const origGetPipeline  = agent.gitlab.getPipeline.bind(agent.gitlab);
  const origGetJobs      = agent.gitlab.getFailedJobs.bind(agent.gitlab);
  const origGetCommit    = agent.gitlab.getCommit.bind(agent.gitlab);
  const origGetLog       = agent.gitlab.getJobLog.bind(agent.gitlab);
  const origCreateIssue  = agent.gitlab.createIssue.bind(agent.gitlab);
  const origCreatePR     = agent.gitlab.createPatchPR.bind(agent.gitlab);

  agent.gitlab.getPipeline = async (...a) => {
    const r = await origGetPipeline(...a);
    detail('pipeline', `#${r.id} on ${r.ref}`, C.cyan);
    return r;
  };

  agent.gitlab.getFailedJobs = async (...a) => {
    const r = await origGetJobs(...a);
    detail('failed jobs', r.map(j => j.name).join(', '), C.red);
    return r;
  };

  agent.gitlab.getCommit = async (...a) => {
    const r = await origGetCommit(...a);
    if (r) detail('commit', `"${r.title?.slice(0,60)}" by ${r.author_name}`, C.dim);
    return r;
  };

  agent.gitlab.getJobLog = async (...a) => {
    // Return scenario-specific log instead of generic mock
    ok(`Job log fetched (${overrides.jobLog?.length ?? 0} chars)`);
    return overrides.jobLog ?? (await origGetLog(...a));
  };

  agent.gitlab.createIssue = async (args) => {
    step('7', 'Creating GitLab issue...');
    const r = await origCreateIssue(args);
    ok(`Issue created: ${r.web_url}`);
    detail('title', args.title, C.white);
    return r;
  };

  agent.gitlab.createPatchPR = async (args) => {
    step('8', 'Creating patch PR...');
    const r = await origCreatePR(args);
    ok(`Patch MR created: ${r.web_url}`);
    detail('branch', args.sourceBranch, C.green);
    return r;
  };

  // --- LLM: log prompt size + result ---
  const origAnalyze = agent.gemini.analyzeFailure.bind(agent.gemini);
  agent.gemini.analyzeFailure = async (args) => {
    step('6', 'Calling LLM for root-cause analysis...');
    if (!process.env.ANTHROPIC_API_KEY) {
      warn('No ANTHROPIC_API_KEY — using local mock analysis');
      return buildMockAnalysis(scenario, overrides);
    }
    try {
      const r = await origAnalyze(args);
      if (r._fallback || r.confidence <= 0.1) {
        warn('LLM returned fallback (check ANTHROPIC_API_KEY) — using scenario mock');
        const mock = buildMockAnalysis(scenario, overrides);
        ok(`Mock analysis — confidence: ${(mock.confidence*100).toFixed(0)}% (${mock.confidenceLabel}) [MOCK]`);
        detail('title', mock.title, C.white);
        return mock;
      }
      ok(`LLM analysis complete — confidence: ${(r.confidence*100).toFixed(0)}% (${r.confidenceLabel})`);
      detail('title', r.title, C.white);
      detail('tokens', String(r.tokensUsed));
      return r;
    } catch (err) {
      warn(`LLM error: ${err.message.slice(0,80)}`);
      warn('Using scenario mock analysis');
      const mock = buildMockAnalysis(scenario, overrides);
      ok(`Mock analysis — confidence: ${(mock.confidence*100).toFixed(0)}% [MOCK]`);
      return mock;
    }
  };

  // --- Arize: log trace lifecycle ---
  const origStartTrace = agent.arize.startTrace.bind(agent.arize);
  const origEndTrace   = agent.arize.endTrace.bind(agent.arize);

  agent.arize.startTrace = (args) => {
    step('1', 'Opening Arize observability trace...');
    const ctx = origStartTrace(args);
    ok(`Trace started: ${ctx.traceId.slice(0,16)}...`);
    return ctx;
  };

  agent.arize.endTrace = async (ctx, args) => {
    step('10', 'Flushing Arize trace...');
    const url = await origEndTrace(ctx, args);
    ok(`Trace flushed${url ? ': ' + url : ' (local only — set ARIZE_API_KEY to enable)'}`);
    return url;
  };

  // --- MongoDB save: log outcome ---
  const origSave = agent.mongo.saveIncident.bind(agent.mongo);
  agent.mongo.saveIncident = async (incident) => {
    step('9', 'Saving incident to MongoDB...');
    const r = await origSave(incident);
    ok(`Incident saved: ${incident.incidentId}`);
    detail('duration', `${incident.durationMs}ms`);
    return r;
  };
}

// ---------------------------------------------------------------------------
// Local mock analysis (used when no API key is set)
// ---------------------------------------------------------------------------

function buildMockAnalysis(scenario, overrides) {
  const patterns = overrides.errorPatterns ?? [];

  // Scenario-specific realistic root causes for demo purposes
  const rootCauses = {
    default: `NullPointerException in UserService.getUserById() at line 142. The method dereferences the cached user object without a null guard. When the cache misses and the DB returns no row, the object is null at the point of access.`,
    oom:     `Node.js process exceeded the 1.5 GB heap limit during the webpack build. Large asset imports caused repeated GC cycles until allocation failed. Increasing --max-old-space-size or splitting the build into chunks will resolve this.`,
    db:      `The migration runner connected to the read replica (postgres-primary DNS resolves to the replica in the release environment) instead of the primary. The replica rejected the DDL statement. DATABASE_URL must point to the primary write endpoint during migrations.`,
    test:    `Jest module cache is stale after the auth refactor renamed auth.cache.js to auth-cache.js. The old import path still exists in AuthService.js. Updating the import and running jest --clearCache will fix the 14 failing tests.`,
  };

  const confidenceMap = { default: 0.91, oom: 0.95, db: 0.87, test: 0.78 };
  const key = Object.keys(SCENARIOS).find(k => SCENARIOS[k].name === scenario.name) ?? 'default';
  const confidence = confidenceMap[key] ?? 0.82;

  return {
    title: `Fix ${patterns[0] ?? 'pipeline failure'} in ${scenario.event.project.name}`,
    rootCause: rootCauses[key] ?? rootCauses.default,
    confidence,
    confidenceLabel: confidence >= 0.75 ? 'high' : confidence >= 0.5 ? 'medium' : 'low',
    evidence: patterns.slice(0, 3).map(p => ({ source: 'elastic', detail: p })),
    similarIncidents: [
      { date: new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0], summary: `Similar ${patterns[0] ?? 'error'} on main`, resolutionTime: '2h 15m' },
    ],
    recommendedFix: `1. Review the job log excerpt above.\n2. Apply the root cause fix described.\n3. Re-run the pipeline to verify.\n4. Consider adding a regression test to prevent recurrence.`,
    patch: null,           // never create fake patches — avoids noise in real GitLab
    patchDescription: '',
    externalContext: null,
    tokensUsed: 0,
    _mock: true,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse --scenario flag
  const scenarioArg = process.argv.includes('--scenario')
    ? process.argv[process.argv.indexOf('--scenario') + 1]
    : 'default';

  const scenario = SCENARIOS[scenarioArg];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioArg}. Options: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  // Header
  banner(`DevOps Intelligence Agent — Demo`, C.bgBlue);
  console.log(`  ${C.bold}Scenario:${C.reset} ${scenario.name}`);
  console.log(`  ${C.bold}Project:${C.reset}  ${scenario.event.project.name}`);
  console.log(`  ${C.bold}Branch:${C.reset}   ${scenario.event.object_attributes.ref}`);
  const llmKey = process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
  console.log(`  ${C.bold}LLM:${C.reset}      ${llmKey ? C.green + 'API key set ✓' : C.yellow + 'No API key — using mock analysis'}${C.reset}`);
  separator();

  // Patch tools for visible demo output
  const agent = new DevOpsAgent();
  patchWithLogging(agent, scenario);

  // --- Step 2 preamble (fetchPipelineContext happens inside handlePipelineFailure) ---
  step('2', 'Fetching pipeline context from GitLab...');

  const startMs = Date.now();

  try {
    const result = await agent.handlePipelineFailure(scenario.event);

    // Results summary
    banner('✅  Analysis Complete', C.bgGreen);

    console.log(`  ${C.bold}Incident ID:${C.reset}   ${result.incidentId}`);
    console.log(`  ${C.bold}Confidence:${C.reset}    ${C.green}${(result.analysis.confidence * 100).toFixed(0)}%${C.reset} (${result.analysis.confidenceLabel})`);
    console.log(`  ${C.bold}Title:${C.reset}         ${result.analysis.title}`);
    console.log(`  ${C.bold}Root Cause:${C.reset}    ${result.analysis.rootCause.slice(0, 120)}...`);
    separator();
    console.log(`  ${C.bold}GitLab Issue:${C.reset}  ${C.cyan}${result.resolution.issueUrl ?? 'N/A'}${C.reset}`);
    console.log(`  ${C.bold}Patch PR:${C.reset}      ${result.resolution.prUrl ? C.green + result.resolution.prUrl : C.dim + 'none (confidence gate or no patch)'}${C.reset}`);
    console.log(`  ${C.bold}Duration:${C.reset}      ${Date.now() - startMs}ms`);

    if (result.analysis.evidence?.length) {
      separator();
      console.log(`  ${C.bold}Evidence (${result.analysis.evidence.length} items):${C.reset}`);
      for (const e of result.analysis.evidence.slice(0, 4)) {
        console.log(`    ${C.dim}[${e.source}]${C.reset} ${e.detail}`);
      }
    }

    console.log();
  } catch (err) {
    banner('❌  Demo Failed', C.bgRed);
    console.error(`  ${C.red}Error:${C.reset} ${err.message}`);
    if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
    process.exit(1);
  } finally {
    await agent.mongo.close().catch(() => {});
  }
}

main();