// agent/index.js — DevOps Intelligence Agent core orchestrator
//
// DevOpsAgent.handlePipelineFailure(event) runs the full 10-step analysis:
//
//  1. Open Arize trace
//  2. Fetch pipeline context (parallel GitLab calls via Promise.allSettled)
//  3. Search Elastic logs
//  4. Find similar incidents in MongoDB
//  5. Fetch enriched context via Fivetran
//  6. Call LLM for root-cause analysis
//  7. Create GitLab issue (always)
//  8. Create patch PR if confidence >= 0.75 and patch exists
//  9. Save incident to MongoDB
// 10. Close Arize trace
//
// All tools degrade gracefully — a full run completes even with zero credentials.

import { randomUUID } from 'crypto';
import { MongoTool } from '../tools/mongo.js';
import { ElasticTool } from '../tools/elastic.js';
import { GitLabTool } from '../tools/gitlab.js';
import { ArizeTool } from '../tools/arize.js';
import { FivetranTool } from '../tools/fivetran.js';
import GeminiClient from './gemini-client.js';
import logger from './logger.js';

const AUTO_PATCH_CONFIDENCE = 0.75;

export class DevOpsAgent {
  constructor() {
    this.mongo    = new MongoTool();
    this.elastic  = new ElasticTool();
    this.gitlab   = new GitLabTool();
    this.arize    = new ArizeTool();
    this.fivetran = new FivetranTool();
    this.gemini   = new GeminiClient();
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async handlePipelineFailure(event) {
    const incidentId = randomUUID();
    const startMs = Date.now();

    logger.info('Pipeline failure received', {
      incidentId,
      projectId: event?.project?.id,
      pipelineId: event?.object_attributes?.id,
      ref: event?.object_attributes?.ref,
    });

    // Step 1: Open Arize trace
    const traceCtx = this.arize.startTrace({
      incidentId,
      event,
      input: {
        pipelineId: event?.object_attributes?.id,
        projectId:  event?.project?.id,
        ref:        event?.object_attributes?.ref,
      },
    });

    try {
      // Step 2: Fetch pipeline context (never throws — allSettled internally)
      const ctx = await this.fetchPipelineContext(event, incidentId);

      // Step 3: Elastic log search
      const elasticResults = await this.elastic.searchLogs({
        projectId:  String(event?.project?.id ?? ''),
        pipelineId: String(event?.object_attributes?.id ?? ''),
        sha:        ctx.pipeline?.sha ?? event?.object_attributes?.sha ?? '',
        ref:        event?.object_attributes?.ref ?? '',
        timeWindow: '30m',
      });

      // Step 4: MongoDB similar incidents
      const similarIncidents = await this.mongo.findSimilarIncidents({
        projectId:     String(event?.project?.id ?? ''),
        errorPatterns: elasticResults.errorPatterns ?? [],
        ref:           event?.object_attributes?.ref ?? '',
        limit: 5,
      });

      // Step 5: Fivetran enriched context
      const enrichedContext = await this.fivetran.getEnrichedContext({
        projectId: String(event?.project?.id ?? ''),
        sha:       ctx.pipeline?.sha ?? '',
        ref:       event?.object_attributes?.ref ?? '',
      });

      // Step 6: LLM analysis
      const analysis = await this.gemini.analyzeFailure({
        pipeline:        ctx.pipeline,
        failedJobs:      ctx.failedJobs,
        commit:          ctx.commit,
        jobLogs:         ctx.jobLogs,
        elasticResults,
        similarIncidents,
        enrichedContext,
        incidentId,
      });

      logger.info('LLM analysis complete', {
        incidentId,
        confidence:  analysis.confidence,
        label:       analysis.confidenceLabel,
        tokensUsed:  analysis.tokensUsed,
        patchPresent: Boolean(analysis.patch),
      });

      // Steps 7 + 8: Issue + optional patch PR
      const resolution = await this.executeResolution(analysis, event, incidentId, ctx);

      // Step 9: Save to MongoDB
      const incident = {
        incidentId,
        projectId:  String(event?.project?.id ?? ''),
        pipelineId: String(event?.object_attributes?.id ?? ''),
        sha:        ctx.pipeline?.sha ?? event?.object_attributes?.sha ?? '',
        ref:        event?.object_attributes?.ref ?? '',
        logs:       elasticResults.summary,
        errorPatterns: elasticResults.errorPatterns ?? [],
        rootCause:  analysis.rootCause,
        confidence: analysis.confidence,
        resolution,
        similarIncidentsFound: similarIncidents.length,
        resolvedAt: new Date(),
        durationMs: Date.now() - startMs,
      };
      await this.mongo.saveIncident(incident);

      // Step 10: Close Arize trace
      const traceUrl = await this.arize.endTrace(traceCtx, {
        output:    { analysis, resolution },
        incidentId,
        success:   true,
        durationMs: Date.now() - startMs,
        tokensUsed: analysis.tokensUsed,
      });

      logger.info('Pipeline failure handled', {
        incidentId,
        durationMs:  Date.now() - startMs,
        issueUrl:    resolution.issueUrl,
        prUrl:       resolution.prUrl ?? 'none',
        traceUrl:    traceUrl ?? 'disabled',
      });

      return { incidentId, analysis, resolution, incident };

    } catch (err) {
      logger.error('Agent run failed', { incidentId, error: err.message });

      await this.arize.endTrace(traceCtx, {
        incidentId,
        success:   false,
        durationMs: Date.now() - startMs,
        error:     err,
      }).catch(() => {});

      // Fallback issue so engineers are never left in the dark
      const projectId = String(event?.project?.id ?? '');
      if (projectId) {
        await this.gitlab.createIssue({
          projectId,
          title: `⚠️ [Agent Error] Pipeline #${event?.object_attributes?.id} failed — agent could not analyze`,
          body:  `The DevOps Intelligence Agent encountered an error.\n\n**Error:** \`${err.message}\`\n\n**Incident ID:** \`${incidentId}\`\n\nPlease investigate manually.`,
          labels: ['agent-error', 'needs-review'],
        }).catch((e) => logger.warn('Fallback issue failed', { error: e.message }));
      }

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: parallel GitLab context fetch — NEVER throws
  // Uses Promise.allSettled so a 404 on one call doesn't kill the whole fetch.
  // ---------------------------------------------------------------------------

  async fetchPipelineContext(event, incidentId) {
    const projectId = String(event?.project?.id ?? '');
    const pipelineId = String(event?.object_attributes?.id ?? '');
    const sha = event?.object_attributes?.sha ?? '';
    const gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.com';

    // Inline fallbacks — never depend on private _mock* methods from gitlab tool
    const fallbackPipeline = {
      id: pipelineId, iid: 1, project_id: projectId,
      sha: sha || 'abc123def456', ref: event?.object_attributes?.ref ?? 'main',
      status: 'failed',
      web_url: `${gitlabUrl}/example/project/-/pipelines/${pipelineId}`,
      created_at: new Date().toISOString(),
    };

    const fallbackJobs = [{
      id: 9001, name: 'build-and-test', stage: 'test', status: 'failed',
      duration: 47.3,
      web_url: `${gitlabUrl}/example/project/-/jobs/9001`,
      created_at: new Date().toISOString(),
    }];

    const fallbackCommit = {
      id: sha || 'abc123def456',
      short_id: (sha || 'abc123').slice(0, 8),
      title: 'Recent commit',
      author_name: 'Developer',
      created_at: new Date().toISOString(),
      stats: { additions: 0, deletions: 0, total: 0 },
    };

    const [pipelineResult, jobsResult, commitResult] = await Promise.allSettled([
      this.gitlab.getPipeline(projectId, pipelineId),
      this.gitlab.getFailedJobs(projectId, pipelineId),
      sha ? this.gitlab.getCommit(projectId, sha) : Promise.resolve(fallbackCommit),
    ]);

    if (pipelineResult.status === 'rejected') {
      logger.warn('getPipeline failed — using fallback', { error: pipelineResult.reason?.message, incidentId });
    }
    if (jobsResult.status === 'rejected') {
      logger.warn('getFailedJobs failed — using fallback', { error: jobsResult.reason?.message, incidentId });
    }
    if (commitResult.status === 'rejected') {
      logger.warn('getCommit failed — using fallback', { error: commitResult.reason?.message, incidentId });
    }

    const pipeline  = pipelineResult.status  === 'fulfilled' ? pipelineResult.value  : fallbackPipeline;
    const failedJobs = jobsResult.status     === 'fulfilled' ? (jobsResult.value ?? []) : fallbackJobs;
    const commit    = commitResult.status    === 'fulfilled' ? commitResult.value     : fallbackCommit;

    // Fetch job logs sequentially (rate-limit safe)
    const jobLogs = {};
    for (const job of failedJobs.slice(0, 5)) {
      const log = await this.gitlab.getJobLog(projectId, job.id, 8000);
      jobLogs[job.id] = log;
    }

    return { pipeline, failedJobs, commit, jobLogs };
  }

  // ---------------------------------------------------------------------------
  // Steps 7+8: issue always, patch PR only if confidence gate passes
  // ---------------------------------------------------------------------------

  async executeResolution(analysis, event, incidentId, ctx) {
    const projectId = String(event?.project?.id ?? '');

    const issueBody = this.formatIssueBody(analysis, event, incidentId);
    const issue = await this.gitlab.createIssue({
      projectId,
      title:  `🤖 [Agent] ${analysis.title ?? 'Pipeline failure analysis'}`,
      body:   issueBody,
      labels: ['devops-agent', 'incident', analysis.confidenceLabel ?? 'low'],
    });

    const resolution = {
      issueUrl: issue.web_url ?? null,
      issueId:  String(issue.iid ?? ''),
      prUrl:    null,
      prId:     null,
    };

    if (
      analysis.confidence >= AUTO_PATCH_CONFIDENCE &&
      Array.isArray(analysis.patch) &&
      analysis.patch.length > 0
    ) {
      const branchName = `fix/agent-${incidentId.slice(0, 8)}`;
      const sha = ctx?.pipeline?.sha ?? event?.object_attributes?.sha ?? 'main';

      const mr = await this.gitlab.createPatchPR({
        projectId,
        sourceBranch: branchName,
        targetBranch: 'main',
        title:        `fix: ${analysis.title ?? 'agent auto-patch'}`,
        description:  this.formatPRBody(analysis, incidentId, issue),
        patch:        analysis.patch,
        sha,
      });

      resolution.prUrl = mr.web_url ?? null;
      resolution.prId  = String(mr.iid ?? '');

      logger.info('Patch PR created', { incidentId, prUrl: resolution.prUrl, branch: branchName });
    } else {
      logger.info('No patch PR — gate not met or no patch', {
        incidentId,
        confidence:  analysis.confidence,
        threshold:   AUTO_PATCH_CONFIDENCE,
        patchPresent: Boolean(analysis.patch),
      });
    }

    return resolution;
  }

  // ---------------------------------------------------------------------------
  // Issue body
  // ---------------------------------------------------------------------------

  formatIssueBody(analysis, event, incidentId) {
    const pipelineUrl = event?.object_attributes?.url ?? 'N/A';
    const branch      = event?.object_attributes?.ref  ?? 'unknown';
    const sha         = (event?.object_attributes?.sha ?? '').slice(0, 12);
    const projectId   = event?.project?.id ?? 'unknown';
    const pipelineId  = event?.object_attributes?.id ?? 'unknown';

    const bar = this._confidenceBar(analysis.confidence);

    const evidence = (analysis.evidence ?? [])
      .map((e) => `- **${e.source}**: ${e.detail}`)
      .join('\n') || '_No evidence items extracted._';

    const similar = (analysis.similarIncidents ?? [])
      .map((i) => `- \`${i.date}\` — ${i.summary} (resolved in ${i.resolutionTime})`)
      .join('\n') || '_No similar incidents found._';

    const externalCtx = analysis.externalContext
      ? `\n\n## 🔗 External Context (Fivetran)\n${analysis.externalContext}`
      : '';

    const patchSection = Array.isArray(analysis.patch) && analysis.patch.length
      ? `\n\n## 🔧 Auto-patch\n${analysis.patchDescription ?? 'See linked MR.'}`
      : '';

    return `## 🤖 DevOps Intelligence Agent — Incident Report

**Incident ID:** \`${incidentId}\`
**Pipeline:** [#${pipelineId}](${pipelineUrl}) · branch \`${branch}\` · commit \`${sha}\`
**Project:** \`${projectId}\`

---

## 📊 Confidence

${bar} **${(analysis.confidence * 100).toFixed(0)}%** — ${(analysis.confidenceLabel ?? 'unknown').toUpperCase()}

---

## 🔍 Root Cause

${analysis.rootCause ?? 'Unknown'}

---

## 📋 Evidence

${evidence}

---

## 🕰️ Similar Past Incidents (MongoDB)

${similar}

---

## 💡 Recommended Fix

${analysis.recommendedFix ?? 'No recommendation available.'}${patchSection}${externalCtx}

---

_Generated by DevOps Intelligence Agent · \`${incidentId}\`_`;
  }

  // ---------------------------------------------------------------------------
  // PR description
  // ---------------------------------------------------------------------------

  formatPRBody(analysis, incidentId, issue) {
    return `## 🤖 Auto-generated patch — DevOps Intelligence Agent

**Incident ID:** \`${incidentId}\`
**Linked Issue:** ${issue?.web_url ?? 'N/A'}
**Confidence:** ${(analysis.confidence * 100).toFixed(0)}% (${analysis.confidenceLabel})

### What this patch does
${analysis.patchDescription ?? 'See diff.'}

### Root cause addressed
${analysis.rootCause ?? 'N/A'}

---
> ⚠️ Auto-generated. Review before merging. Labels: \`auto-fix\` \`needs-review\``;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  _confidenceBar(confidence) {
    const pct    = Math.round((confidence ?? 0) * 10);
    const filled = '█'.repeat(pct);
    const empty  = '░'.repeat(10 - pct);
    return `\`[${filled}${empty}]\``;
  }
}

export default DevOpsAgent;