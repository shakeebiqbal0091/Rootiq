// agent/gemini-client.js — LLM client for DevOps Intelligence Agent
//
// Currently wired to Anthropic Claude (claude-sonnet-4-20250514).
// To swap for Google Vertex AI / Gemini in production:
//
//   import { VertexAI } from '@google-cloud/vertexai';
//   const vertex = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT });
//   const model  = vertex.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
//   // then call model.generateContent() and parse its response.
//
// The system prompt and JSON schema are identical regardless of LLM backend.

import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// Output schema (documented here for prompt reference)
// ---------------------------------------------------------------------------
//
// {
//   "title":           string  (<60 chars)
//   "rootCause":       string  (2-4 sentences)
//   "confidence":      number  (0.0 – 1.0)
//   "confidenceLabel": "high" | "medium" | "low"
//   "evidence": [{ "source": string, "detail": string }]
//   "similarIncidents": [{ "date": "YYYY-MM-DD", "summary": string, "resolutionTime": string }]
//   "recommendedFix":  string
//   "patch": null | [{ "filename": string, "content": string, "diff": string }]
//   "patchDescription": string
//   "externalContext": string | null
//   "tokensUsed":      number
// }

const SYSTEM_PROMPT = `You are an elite DevOps incident-response agent with deep expertise in CI/CD pipelines, distributed systems, and root-cause analysis.

Your task: analyse a failed CI pipeline and return a structured JSON diagnosis.

RULES — follow every one precisely:
1. Return ONLY a JSON object matching the schema below. No prose, no markdown fences, no preamble.
2. Never hallucinate log lines. Only cite evidence that appears in the context you are given.
3. Set confidence honestly. If evidence is ambiguous or incomplete, score ≤0.6 and explain why in rootCause.
4. Only populate "patch" when you have a high-confidence (≥0.75), safe, minimal code fix. Otherwise set patch to null.
5. A patch must be production-safe: no debug code, no TODO comments, no breaking changes.
6. The "title" field must be <60 characters and action-oriented (e.g. "Fix null dereference in UserService.getUserById").

REQUIRED JSON SCHEMA:
{
  "title": "<60 chars",
  "rootCause": "2-4 sentence explanation",
  "confidence": 0.0,
  "confidenceLabel": "high|medium|low",
  "evidence": [{ "source": "elastic|gitlab_log|mongo|fivetran", "detail": "exact evidence from context" }],
  "similarIncidents": [{ "date": "YYYY-MM-DD", "summary": "one line", "resolutionTime": "Xh Ym" }],
  "recommendedFix": "step-by-step fix instructions",
  "patch": null,
  "patchDescription": "what the patch does",
  "externalContext": "relevant Jira/PagerDuty context or null",
  "tokensUsed": 0
}`;

export class GeminiClient {
  constructor() {
    this._client = null;
    this._model = 'claude-sonnet-4-20250514';
  }

  _getClient() {
    if (!this._client) {
      // Accept either ANTHROPIC_API_KEY or GEMINI_API_KEY (common alias in .env setups)
      const apiKey = process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'No LLM API key found. Set ANTHROPIC_API_KEY (or GEMINI_API_KEY) in .env to run the demo.'
        );
      }
      this._client = new Anthropic({ apiKey });
    }
    return this._client;
  }

  // ---------------------------------------------------------------------------
  // Main analysis entry point
  // ---------------------------------------------------------------------------

  /**
   * Analyse a pipeline failure and return a structured diagnosis.
   * All inputs are plain JS objects — no live connections needed for testing.
   */
  async analyzeFailure({
    pipeline,
    failedJobs,
    commit,
    jobLogs,
    elasticResults,
    similarIncidents,
    enrichedContext,
    incidentId,
  }) {
    const prompt = this.buildPrompt({
      pipeline,
      failedJobs,
      commit,
      jobLogs,
      elasticResults,
      similarIncidents,
      enrichedContext,
      incidentId,
    });

    logger.debug('Calling LLM', {
      model: this._model,
      promptChars: prompt.length,
      incidentId,
    });

    const startMs = Date.now();
    let raw;
    let tokensUsed = 0;

    try {
      const client = this._getClient();
      const message = await client.messages.create({
        model: this._model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      raw = message.content.map((b) => b.text || '').join('');
      tokensUsed =
        (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

      const durationMs = Date.now() - startMs;
      logger.info('LLM call complete', {
        incidentId,
        tokensUsed,
        durationMs,
        outputChars: raw.length,
      });
    } catch (err) {
      logger.error('LLM call failed', { error: err.message, incidentId });
      return this.fallbackAnalysis(`LLM error: ${err.message}`);
    }

    return this._parseResponse(raw, tokensUsed);
  }

  // ---------------------------------------------------------------------------
  // Prompt builder
  // ---------------------------------------------------------------------------

  buildPrompt({
    pipeline,
    failedJobs = [],
    commit,
    jobLogs = {},
    elasticResults,
    similarIncidents = [],
    enrichedContext,
    incidentId,
  }) {
    const sections = [];

    // Header
    sections.push(`# Pipeline Failure Analysis — Incident ${incidentId}`);
    sections.push(`Analysed at: ${new Date().toISOString()}`);

    // Pipeline context
    sections.push(`\n## Pipeline Failure Context`);
    sections.push(`- Project ID:  ${pipeline?.project_id ?? 'unknown'}`);
    sections.push(`- Pipeline ID: ${pipeline?.id ?? 'unknown'}`);
    sections.push(`- Branch:      ${pipeline?.ref ?? 'unknown'}`);
    sections.push(`- Status:      ${pipeline?.status ?? 'failed'}`);
    sections.push(`- Pipeline URL: ${pipeline?.web_url ?? 'N/A'}`);

    // Failed jobs
    sections.push(`\n## Failed Jobs (${failedJobs.length})`);
    for (const job of failedJobs) {
      sections.push(`- Job: ${job.name} (ID: ${job.id}) — Stage: ${job.stage}`);
      sections.push(`  Duration: ${job.duration?.toFixed(1) ?? '?'}s`);
      sections.push(`  URL: ${job.web_url ?? 'N/A'}`);
    }

    // Commit info
    sections.push(`\n## Commit Info`);
    sections.push(`- SHA:     ${commit?.id?.slice(0, 12) ?? 'unknown'}`);
    sections.push(`- Author:  ${commit?.author_name ?? 'unknown'}`);
    sections.push(`- Message: ${commit?.title ?? 'unknown'}`);
    sections.push(
      `- Changes: +${commit?.stats?.additions ?? 0} -${commit?.stats?.deletions ?? 0} lines`
    );

    // Job logs (truncated — last N chars to focus on error tail)
    sections.push(`\n## Job Logs`);
    const logEntries = Object.entries(jobLogs);
    if (logEntries.length === 0) {
      sections.push('No job logs available.');
    } else {
      for (const [jobId, log] of logEntries) {
        const truncated = log.length > 3000 ? '...[truncated]\n' + log.slice(-3000) : log;
        sections.push(`\n### Job ${jobId} Log\n\`\`\`\n${truncated}\n\`\`\``);
      }
    }

    // Elastic log analysis
    sections.push(`\n## Elastic Log Analysis`);
    if (elasticResults) {
      sections.push(`Summary: ${elasticResults.summary}`);
      sections.push(`Total errors: ${elasticResults.totalErrors}`);
      if (elasticResults.errorPatterns?.length) {
        sections.push(`Error patterns: ${elasticResults.errorPatterns.join(', ')}`);
      }
      if (elasticResults.topErrors?.length) {
        sections.push(`Top error messages:`);
        for (const e of elasticResults.topErrors.slice(0, 5)) {
          sections.push(`  - ${e}`);
        }
      }
      if (elasticResults.rawLines?.length) {
        sections.push(`Raw log lines (sample):`);
        for (const line of elasticResults.rawLines.slice(0, 10)) {
          sections.push(`  ${line}`);
        }
      }
    } else {
      sections.push('Elastic logs not available.');
    }

    // Similar past incidents (MongoDB memory)
    sections.push(`\n## Similar Past Incidents (MongoDB)`);
    if (similarIncidents.length === 0) {
      sections.push('No similar incidents found in history.');
    } else {
      for (const inc of similarIncidents.slice(0, 3)) {
        const date = inc.resolvedAt
          ? new Date(inc.resolvedAt).toISOString().split('T')[0]
          : 'unknown';
        sections.push(`- [${date}] ${inc.rootCause?.slice(0, 120) ?? 'N/A'}`);
        sections.push(
          `  Resolution: ${inc.resolution?.issueUrl ?? 'N/A'} | Duration: ${
            inc.durationMs ? (inc.durationMs / 1000).toFixed(0) + 's' : 'unknown'
          }`
        );
      }
    }

    // Fivetran enriched context
    sections.push(`\n## Enriched Context (Fivetran)`);
    if (enrichedContext) {
      const jira = enrichedContext.jiraTickets ?? [];
      const pd = enrichedContext.pagerDutyAlerts ?? [];
      const db = enrichedContext.dbMetrics;

      if (jira.length) {
        sections.push(`Jira tickets (${jira.length}):`);
        for (const t of jira) {
          sections.push(`  - [${t.key}] ${t.summary} (${t.status}, ${t.priority})`);
        }
      } else {
        sections.push('No Jira tickets found.');
      }

      if (pd.length) {
        sections.push(`PagerDuty alerts (${pd.length}):`);
        for (const a of pd) {
          sections.push(`  - [${a.id}] ${a.title} (${a.status})`);
        }
      } else {
        sections.push('No active PagerDuty alerts.');
      }

      if (db) {
        sections.push(
          `DB metrics: CPU ${db.cpuPercent}%, connections ${db.activeConnections}/${db.maxConnections}, P99 latency ${db.p99LatencyMs}ms, replication lag ${db.replicationLagMs}ms`
        );
      }
    } else {
      sections.push('Enriched context not available.');
    }

    sections.push(`\n---\nReturn your JSON analysis now. No other text.`);

    return sections.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  _parseResponse(raw, tokensUsed) {
    // Strip markdown fences if the LLM added them despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);

      // Validate required fields
      const required = ['title', 'rootCause', 'confidence', 'recommendedFix'];
      for (const field of required) {
        if (parsed[field] === undefined) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Normalise
      parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      parsed.tokensUsed = tokensUsed || parsed.tokensUsed || 0;
      parsed.confidenceLabel =
        parsed.confidence >= 0.75
          ? 'high'
          : parsed.confidence >= 0.5
          ? 'medium'
          : 'low';

      logger.debug('LLM response parsed', {
        title: parsed.title,
        confidence: parsed.confidence,
        patchPresent: Boolean(parsed.patch),
        evidenceCount: parsed.evidence?.length ?? 0,
      });

      return parsed;
    } catch (err) {
      logger.warn('Failed to parse LLM JSON response', {
        error: err.message,
        rawPreview: raw.slice(0, 300),
      });
      return this.fallbackAnalysis(raw);
    }
  }

  /**
   * Returns a low-confidence stub when JSON parsing fails.
   * Preserves as much of the raw LLM text as possible.
   */
  fallbackAnalysis(rawText) {
    return {
      title: 'Pipeline failure — manual review required',
      rootCause:
        'The agent could not parse a structured diagnosis from the LLM response. ' +
        'Manual investigation required. Raw LLM output is preserved in the issue body.',
      confidence: 0.1,
      confidenceLabel: 'low',
      evidence: [{ source: 'agent', detail: 'JSON parse failure — see raw output' }],
      similarIncidents: [],
      recommendedFix:
        'Review the job logs manually. Raw LLM output: ' +
        (rawText || '').slice(0, 500),
      patch: null,
      patchDescription: '',
      externalContext: null,
      tokensUsed: 0,
      _fallback: true,
    };
  }
}

export default GeminiClient;