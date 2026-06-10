/**
 * Elastic MCP Tool
 * Searches pipeline logs, extracts error patterns, and surfaces top failures
 */

import 'dotenv/config';
import logger from "../agent/logger.js";

export class ElasticTool {
  constructor() {
    this.baseUrl = (process.env.ELASTIC_URL || 'http://localhost:9200').replace(/\/$/, '');
    this.apiKey  = process.env.ELASTIC_API_KEY;
    this.index   = process.env.ELASTIC_LOG_INDEX || 'pipeline-logs-*';
    this.headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {}),
    };
  }

  async request(path, body) {
    const url = `${this.baseUrl}${path}`;
    const res  = await fetch(url, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Elastic ${res.status} on ${path}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Search for logs related to a specific pipeline failure.
   * Returns: summary, errorPatterns, topErrors, totalErrors
   */
  async searchLogs({ projectId, pipelineId, sha, ref, timeWindow = '30m' }) {
    logger.debug(`Elastic: searching logs for pipeline ${pipelineId}`);

    const query = {
      size: 200,
      sort: [{ '@timestamp': { order: 'desc' } }],
      query: {
        bool: {
          must: [
            { range: { '@timestamp': { gte: `now-${timeWindow}`, lte: 'now' } } },
          ],
          should: [
            { term:  { 'pipeline.id':  String(pipelineId) } },
            { term:  { 'project.id':   String(projectId)  } },
            { match: { 'git.sha':      sha   } },
            { term:  { 'git.ref':      ref   } },
          ],
          minimum_should_match: 1,
          filter: [
            { terms: { 'log.level': ['error', 'fatal', 'critical', 'warn'] } },
          ],
        },
      },
      aggs: {
        error_patterns: {
          significant_text: { field: 'message', size: 10 },
        },
        by_level: {
          terms: { field: 'log.level', size: 5 },
        },
        top_errors: {
          terms: { field: 'message.keyword', size: 20, missing: 'unknown' },
        },
      },
    };

    let result;
    try {
      result = await this.request(`/${this.index}/_search`, query);
    } catch (err) {
      // If Elastic is not configured, return mock data for dev
      logger.warn(`Elastic unavailable, using mock data: ${err.message}`);
      return this._mockResponse(pipelineId);
    }

    return this._parseResponse(result);
  }

  _parseResponse(result) {
    const hits   = result.hits?.hits || [];
    const aggs   = result.aggregations || {};
    const total  = result.hits?.total?.value || hits.length;

    // Extract error patterns from significant_text aggregation
    const errorPatterns = (aggs.error_patterns?.buckets || [])
      .map(b => b.key)
      .filter(k => k && k.length > 4);

    // Top error messages with counts
    const topErrors = (aggs.top_errors?.buckets || []).slice(0, 10).map(b => ({
      message: b.key,
      count:   b.doc_count,
      level:   'error',
    }));

    // Raw log lines for context (most recent 50)
    const rawLines = hits.slice(0, 50).map(h => ({
      timestamp: h._source['@timestamp'],
      level:     h._source.log?.level || 'unknown',
      message:   h._source.message,
      service:   h._source.service?.name,
      traceId:   h._source.trace?.id,
    }));

    // Simple summary paragraph
    const levelCounts = {};
    (aggs.by_level?.buckets || []).forEach(b => { levelCounts[b.key] = b.doc_count; });

    const summary = [
      `Found ${total} log entries in the search window.`,
      Object.entries(levelCounts).map(([l, c]) => `${c} ${l}`).join(', ') || 'No level breakdown.',
      errorPatterns.length ? `Key patterns: ${errorPatterns.slice(0, 3).join(', ')}.` : '',
    ].filter(Boolean).join(' ');

    return { summary, errorPatterns, topErrors, rawLines, totalErrors: total };
  }

  _mockResponse(pipelineId) {
    return {
      summary:       `Mock: 42 error log entries found for pipeline ${pipelineId}.`,
      errorPatterns: ['NullPointerException', 'connection refused', 'exit code 1', 'OOMKilled'],
      topErrors: [
        { message: 'java.lang.NullPointerException at UserService.java:84', count: 12, level: 'error' },
        { message: 'Error: Cannot connect to database at localhost:5432',   count:  8, level: 'error' },
        { message: 'Process exited with code 1',                           count:  6, level: 'error' },
      ],
      rawLines:    [],
      totalErrors: 42,
    };
  }
}
