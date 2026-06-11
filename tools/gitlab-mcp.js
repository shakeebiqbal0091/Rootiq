// tools/gitlab-mcp.js — GitLab MCP Server client
//
// Calls the official GitLab MCP server at https://gitlab.com/api/v4/mcp
// using the MCP HTTP transport (JSON-RPC 2.0 over HTTP).
//
// This satisfies the hackathon requirement: "Integrate the partner's
// Model Context Protocol (MCP) server to give your agent the superpowers."
//
// Prerequisites:
//   1. GitLab Ultimate trial (free 30-day): https://about.gitlab.com/free-trial/
//   2. GitLab Duo enabled on your top-level group
//   3. Beta features enabled: Settings → General → Beta features
//   4. Personal access token with `api` scope in GITLAB_TOKEN
//   5. Set GITLAB_DUO_NAMESPACE in .env (your top-level group path, e.g. "mygroup")
//
// MCP server docs: https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/
// Available tools:  get_pipeline_jobs, get_job_log, create_issue, create_merge_request,
//                   manage_pipeline, search, get_issue, get_merge_request

import logger from '../agent/logger.js';

const GITLAB_MCP_ENDPOINT = `${process.env.GITLAB_URL || 'https://gitlab.com'}/api/v4/mcp`;

export class GitLabMCPClient {
  constructor() {
    this._token    = process.env.GITLAB_TOKEN;
    this._namespace = process.env.GITLAB_DUO_NAMESPACE || '';
    this._endpoint = GITLAB_MCP_ENDPOINT;
    this._enabled  = Boolean(this._token && this._namespace);
    this._sessionId = null;
    this._reqId    = 0;
  }

  // ---------------------------------------------------------------------------
  // MCP JSON-RPC transport
  // ---------------------------------------------------------------------------

  /**
   * Send a single MCP JSON-RPC request to the GitLab MCP server.
   * Returns the result object or throws on error.
   */
  async _rpc(method, params = {}) {
    const id = ++this._reqId;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': `Bearer ${this._token}`,
    };

    // GitLab MCP requires a default Duo namespace for external callers
    if (this._namespace) {
      headers['X-Gitlab-Duo-Namespace'] = this._namespace;
    }

    // Attach session ID for stateful connections after initialization
    if (this._sessionId) {
      headers['Mcp-Session-Id'] = this._sessionId;
    }

    const response = await fetch(this._endpoint, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });

    // Capture session ID from response headers (MCP HTTP transport)
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this._sessionId = sessionId;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitLab MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`GitLab MCP RPC error [${data.error.code}]: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Initialize the MCP session (required before calling tools).
   */
  async initialize() {
    try {
      const result = await this._rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name:    'devops-intelligence-agent',
          version: '1.0.0',
        },
      });

      // Send initialized notification
      await this._rpc('notifications/initialized', {}).catch(() => {});

      logger.debug('GitLab MCP session initialized', {
        serverName:    result?.serverInfo?.name,
        serverVersion: result?.serverInfo?.version,
      });

      return result;
    } catch (err) {
      logger.warn('GitLab MCP initialization failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Call a GitLab MCP tool by name with arguments.
   */
  async callTool(toolName, toolArgs = {}) {
    const result = await this._rpc('tools/call', {
      name:      toolName,
      arguments: toolArgs,
    });

    // MCP tool results have a `content` array of text/data blocks
    const content = result?.content ?? [];
    const text    = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    if (result?.isError) {
      throw new Error(`GitLab MCP tool error in ${toolName}: ${text}`);
    }

    // Try to parse JSON content, fall back to raw text
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // ---------------------------------------------------------------------------
  // High-level tool wrappers (match existing gitlab.js API surface)
  // ---------------------------------------------------------------------------

  /**
   * Get failed jobs for a pipeline via MCP get_pipeline_jobs.
   */
  async getFailedJobsMCP(projectId, pipelineId) {
    const result = await this.callTool('get_pipeline_jobs', {
      id:          String(projectId),
      pipeline_id: Number(pipelineId),
      per_page:    20,
    });

    const jobs = Array.isArray(result) ? result : result?.jobs ?? [];
    return jobs.filter(j => j.status === 'failed');
  }

  /**
   * Get job trace log via MCP get_job_log. Returns last maxChars characters.
   */
  async getJobLogMCP(projectId, jobId, maxChars = 8000) {
    const raw = await this.callTool('get_job_log', {
      id:     String(projectId),
      job_id: Number(jobId),
    });

    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // Strip ANSI codes
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
    // Return last N chars — errors are always at the tail
    return clean.length > maxChars ? clean.slice(-maxChars) : clean;
  }

  /**
   * Create a GitLab issue via MCP create_issue.
   */
  async createIssueMCP({ projectId, title, body, labels = [] }) {
    const result = await this.callTool('create_issue', {
      id:          String(projectId),
      title,
      description: body,
      labels,
    });

    logger.info('GitLab issue created via MCP', {
      issueId:  result?.iid,
      url:      result?.web_url,
    });

    return result;
  }

  /**
   * Create a merge request via MCP create_merge_request.
   */
  async createMergeRequestMCP({ projectId, sourceBranch, targetBranch, title, description }) {
    const result = await this.callTool('create_merge_request', {
      id:            String(projectId),
      title,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      description,
      labels:        ['auto-fix', 'needs-review'],
    });

    logger.info('GitLab MR created via MCP', {
      mrId: result?.iid,
      url:  result?.web_url,
    });

    return result;
  }

  /**
   * Search for issues related to an error pattern via MCP search.
   */
  async searchIssuesMCP(projectId, query) {
    const result = await this.callTool('search', {
      scope:      'issues',
      search:     query,
      project_id: String(projectId),
      per_page:   5,
    });

    return Array.isArray(result) ? result : result?.results ?? [];
  }

  // ---------------------------------------------------------------------------
  // Main entry point used by agent/index.js
  // ---------------------------------------------------------------------------

  /**
   * Full MCP-powered pipeline context fetch.
   * Replaces the direct REST calls in fetchPipelineContext when MCP is enabled.
   *
   * Returns { failedJobs, jobLogs, relatedIssues }
   */
  async getPipelineContextMCP({ projectId, pipelineId, errorPatterns = [] }) {
    if (!this._enabled) {
      logger.warn('GitLab MCP disabled — GITLAB_TOKEN or GITLAB_DUO_NAMESPACE not set');
      return null;
    }

    try {
      await this.initialize();

      logger.info('Fetching pipeline context via GitLab MCP server', {
        projectId,
        pipelineId,
        endpoint: this._endpoint,
      });

      // 1. Get failed jobs
      const failedJobs = await this.getFailedJobsMCP(projectId, pipelineId);
      logger.info('MCP: failed jobs fetched', { count: failedJobs.length });

      // 2. Get logs for each failed job
      const jobLogs = {};
      for (const job of failedJobs.slice(0, 5)) {
        try {
          jobLogs[job.id] = await this.getJobLogMCP(projectId, job.id);
          logger.debug('MCP: job log fetched', { jobId: job.id, jobName: job.name });
        } catch (err) {
          logger.warn('MCP: getJobLog failed for job', { jobId: job.id, error: err.message });
        }
      }

      // 3. Search for related open issues (enriches LLM context)
      const searchQuery = errorPatterns.slice(0, 2).join(' ') || 'pipeline failure';
      const relatedIssues = await this.searchIssuesMCP(projectId, searchQuery)
        .catch(() => []);
      logger.debug('MCP: related issues found', { count: relatedIssues.length });

      return { failedJobs, jobLogs, relatedIssues };
    } catch (err) {
      logger.warn('GitLab MCP getPipelineContextMCP failed — agent will use REST fallback', {
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Create the final issue via MCP (preferred over REST when MCP is enabled).
   */
  async createIssueFull({ projectId, title, body, labels }) {
    if (!this._enabled) return null;

    try {
      if (!this._sessionId) await this.initialize();
      return await this.createIssueMCP({ projectId, title, body, labels });
    } catch (err) {
      logger.warn('GitLab MCP createIssue failed — falling back to REST', { error: err.message });
      return null;
    }
  }
}

export default GitLabMCPClient;