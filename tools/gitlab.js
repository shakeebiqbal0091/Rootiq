// tools/gitlab.js — GitLab REST API wrapper for DevOps Intelligence Agent
// Auth: PRIVATE-TOKEN header. All methods have mock fallbacks for demo.

import logger from '../agent/logger.js';

export class GitLabTool {
  constructor() {
    this._url = process.env.GITLAB_URL || 'https://gitlab.com';
    this._token = process.env.GITLAB_TOKEN;
    this._enabled = Boolean(this._token);
  }

  // ---------------------------------------------------------------------------
  // Base request
  // ---------------------------------------------------------------------------

  async request(path, options = {}) {
    const url = `${this._url}/api/v4${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this._token ? { 'PRIVATE-TOKEN': this._token } : {}),
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `GitLab API ${options.method || 'GET'} ${path} → ${response.status}: ${body.slice(0, 200)}`
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  // ---------------------------------------------------------------------------
  // Pipeline context
  // ---------------------------------------------------------------------------

  async getPipeline(projectId, pipelineId) {
    if (!this._enabled) return this._mockPipeline(projectId, pipelineId);
    try {
      return await this.request(`/projects/${projectId}/pipelines/${pipelineId}`);
    } catch (err) {
      logger.warn('getPipeline failed — using mock', { error: err.message });
      return this._mockPipeline(projectId, pipelineId);
    }
  }

  async getFailedJobs(projectId, pipelineId) {
    if (!this._enabled) return this._mockFailedJobs(pipelineId);
    try {
      return await this.request(
        `/projects/${projectId}/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=20`
      );
    } catch (err) {
      logger.warn('getFailedJobs failed — using mock', { error: err.message });
      return this._mockFailedJobs(pipelineId);
    }
  }

  async getCommit(projectId, sha) {
    if (!this._enabled) return this._mockCommit(sha);
    try {
      return await this.request(`/projects/${projectId}/repository/commits/${sha}`);
    } catch (err) {
      logger.warn('getCommit failed — using mock', { error: err.message });
      return this._mockCommit(sha);
    }
  }

  /**
   * Get job trace log. Strips ANSI codes. Returns last maxChars characters.
   * The last N chars strategy: errors always appear at the tail, not in setup.
   */
  async getJobLog(projectId, jobId, maxChars = 10000) {
    if (!this._enabled) return this._mockJobLog(jobId);
    try {
      const raw = await this.request(`/projects/${projectId}/jobs/${jobId}/trace`, {
        headers: { Accept: 'text/plain' },
      });
      // Strip ANSI escape codes
      const clean = String(raw).replace(
        // eslint-disable-next-line no-control-regex
        /\x1B\[[0-9;]*[mGKHF]/g,
        ''
      );
      // Return last N chars where errors appear
      return clean.length > maxChars ? clean.slice(-maxChars) : clean;
    } catch (err) {
      logger.warn('getJobLog failed — using mock', { jobId, error: err.message });
      return this._mockJobLog(jobId);
    }
  }

  async getOpenMRs(projectId) {
    if (!this._enabled) return [];
    try {
      return await this.request(
        `/projects/${projectId}/merge_requests?state=opened&per_page=10`
      );
    } catch (err) {
      logger.warn('getOpenMRs failed', { error: err.message });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Issue creation
  // ---------------------------------------------------------------------------

  async createIssue({ projectId, title, body, labels = [] }) {
    if (!this._enabled) return this._mockIssue(projectId, title);
    try {
      const issue = await this.request(`/projects/${projectId}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: body,
          labels: labels.join(','),
        }),
      });
      logger.info('GitLab issue created', { issueId: issue.iid, url: issue.web_url });
      return issue;
    } catch (err) {
      logger.warn('createIssue failed — returning mock', { error: err.message });
      return this._mockIssue(projectId, title);
    }
  }

  // ---------------------------------------------------------------------------
  // Patch PR (branch → file upserts → MR)
  // ---------------------------------------------------------------------------

  async createPatchPR({
    projectId,
    sourceBranch,
    targetBranch = 'main',
    title,
    description,
    patch = [],
    sha,
  }) {
    if (!this._enabled) return this._mockMR(projectId, sourceBranch);
    try {
      // 1. Create branch from failing SHA
      await this.request(`/projects/${projectId}/repository/branches`, {
        method: 'POST',
        body: JSON.stringify({ branch: sourceBranch, ref: sha }),
      });

      // 2. Upsert each file in the patch
      for (const file of patch) {
        await this.upsertFile({ projectId, branch: sourceBranch, file });
      }

      // 3. Open MR
      const mr = await this.request(`/projects/${projectId}/merge_requests`, {
        method: 'POST',
        body: JSON.stringify({
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title,
          description,
          labels: 'auto-fix,needs-review',
          remove_source_branch: true,
        }),
      });

      logger.info('GitLab patch MR created', { mrId: mr.iid, url: mr.web_url });
      return mr;
    } catch (err) {
      logger.warn('createPatchPR failed — returning mock', { error: err.message });
      return this._mockMR(projectId, sourceBranch);
    }
  }

  async upsertFile({ projectId, branch, file }) {
    const encodedPath = encodeURIComponent(file.filename);
    // Try PUT (update) first, fall back to POST (create)
    try {
      return await this.request(
        `/projects/${projectId}/repository/files/${encodedPath}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            branch,
            content: file.content,
            commit_message: `fix: agent auto-patch ${file.filename}`,
          }),
        }
      );
    } catch {
      return await this.request(
        `/projects/${projectId}/repository/files/${encodedPath}`,
        {
          method: 'POST',
          body: JSON.stringify({
            branch,
            content: file.content,
            commit_message: `fix: agent auto-patch ${file.filename}`,
          }),
        }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Mock data
  // ---------------------------------------------------------------------------

  _mockPipeline(projectId, pipelineId) {
    return {
      id: pipelineId,
      iid: 42,
      project_id: projectId,
      sha: 'abc123def456',
      ref: 'main',
      status: 'failed',
      web_url: `${this._url}/example/backend-api/-/pipelines/${pipelineId}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  _mockFailedJobs(pipelineId) {
    return [
      {
        id: 9001,
        name: 'unit-tests',
        stage: 'test',
        status: 'failed',
        pipeline: { id: pipelineId },
        web_url: `${this._url}/example/backend-api/-/jobs/9001`,
        created_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration: 47.3,
      },
    ];
  }

  _mockCommit(sha) {
    return {
      id: sha || 'abc123def456',
      short_id: (sha || 'abc123').slice(0, 8),
      title: 'feat: add user caching layer to UserService',
      author_name: 'Shakeeb Dev',
      author_email: 'dev@example.com',
      created_at: new Date().toISOString(),
      stats: { additions: 47, deletions: 3, total: 50 },
      web_url: `${this._url}/example/backend-api/-/commit/${sha}`,
    };
  }

  _mockJobLog(jobId) {
    return `
[2026-06-08T05:30:01Z] $ mvn test -pl . --no-transfer-progress
[2026-06-08T05:30:05Z] [INFO] Scanning for projects...
[2026-06-08T05:30:06Z] [INFO] Building backend-api 1.4.2
[2026-06-08T05:30:10Z] [INFO] Running com.example.UserServiceTest
[2026-06-08T05:30:12Z] [ERROR] Tests run: 4, Failures: 0, Errors: 1, Skipped: 0
[2026-06-08T05:30:12Z] [ERROR] com.example.UserServiceTest.testGetUserById_NullCache
[2026-06-08T05:30:12Z] [ERROR] java.lang.NullPointerException: Cannot invoke "com.example.User.getId()" because "user" is null
[2026-06-08T05:30:12Z] [ERROR]   at com.example.UserService.getUserById(UserService.java:142)
[2026-06-08T05:30:12Z] [ERROR]   at com.example.UserServiceTest.testGetUserById_NullCache(UserServiceTest.java:87)
[2026-06-08T05:30:13Z] [INFO] BUILD FAILURE
[2026-06-08T05:30:13Z] [ERROR] There are test failures.
[2026-06-08T05:30:13Z] Process finished with exit code 1
`.trim();
  }

  _mockIssue(projectId, title) {
    const id = Math.floor(Math.random() * 900) + 100;
    return {
      iid: id,
      id: id + 10000,
      title,
      web_url: `${this._url}/example/backend-api/-/issues/${id}`,
      created_at: new Date().toISOString(),
    };
  }

  _mockMR(projectId, sourceBranch) {
    const id = Math.floor(Math.random() * 90) + 10;
    return {
      iid: id,
      id: id + 1000,
      title: `fix: agent auto-patch ${sourceBranch}`,
      web_url: `${this._url}/example/backend-api/-/merge_requests/${id}`,
      source_branch: sourceBranch,
      target_branch: 'main',
      created_at: new Date().toISOString(),
    };
  }
}

export default GitLabTool;