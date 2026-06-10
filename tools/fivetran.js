/**
 * Fivetran MCP Tool — Enriched Context Sync
 *
 * Fivetran continuously syncs external data sources into a unified view:
 *  - Jira: open tickets, recent bugs, known issues for the project
 *  - PagerDuty: active alerts, on-call schedule, recent incidents
 *  - Database metrics: CPU, connections, query latency, replication lag
 *
 * The agent queries this pre-synced data to give Gemini full context
 * before it generates a root-cause analysis.
 *
 * In production: Fivetran syncs these into your data warehouse (BigQuery/Snowflake).
 * This tool reads from that warehouse via the Fivetran API or direct DB queries.
 */

import 'dotenv/config';
import  logger  from '../agent/logger.js';

const FIVETRAN_API_BASE = 'https://api.fivetran.com/v1';

export class FivetranTool {
  constructor() {
    this.apiKey    = process.env.FIVETRAN_API_KEY;
    this.apiSecret = process.env.FIVETRAN_API_SECRET;
    this.enabled   = !!(this.apiKey && this.apiSecret);

    if (!this.enabled) {
      logger.warn('Fivetran: credentials missing — returning mock enriched context');
    }
  }

  get authHeader() {
    const credentials = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async request(path, options = {}) {
    const res = await fetch(`${FIVETRAN_API_BASE}${path}`, {
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      ...options,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fivetran API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Main entry: get enriched context for a failing pipeline
   * Fetches Jira tickets, PagerDuty alerts, and DB metrics in parallel
   */
  async getEnrichedContext({ projectId, sha, ref }) {
    if (!this.enabled) {
      return this._mockEnrichedContext(projectId, ref);
    }

    logger.debug(`Fivetran: fetching enriched context for project ${projectId} ref ${ref}`);

    const [jiraTickets, pagerDutyAlerts, dbMetrics] = await Promise.allSettled([
      this.getJiraTickets(projectId),
      this.getPagerDutyAlerts(projectId),
      this.getDbMetrics(projectId),
    ]);

    return {
      jiraTickets:     jiraTickets.status     === 'fulfilled' ? jiraTickets.value     : [],
      pagerDutyAlerts: pagerDutyAlerts.status === 'fulfilled' ? pagerDutyAlerts.value : [],
      dbMetrics:       dbMetrics.status       === 'fulfilled' ? dbMetrics.value       : null,
      sha,
      ref,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Get open Jira tickets related to the project
   * Fivetran syncs Jira → your warehouse; this queries the synced table
   */
  async getJiraTickets(projectId) {
    try {
      // In production: query your Fivetran-synced Jira table in BigQuery/Snowflake
      // Here we use the Fivetran Metadata API to fetch connector status and synced data
      const connectors = await this.request('/connectors?limit=20');
      const jiraConnector = connectors.data?.items?.find(c =>
        c.service === 'jira' && c.status?.sync_state === 'syncing'
      );

      if (!jiraConnector) {
        logger.warn('Fivetran: no active Jira connector found');
        return [];
      }

      // Query the synced Jira data via Fivetran's destination
      // This would be a BigQuery/Snowflake query in production
      return this._fetchJiraFromDestination(projectId, jiraConnector.id);
    } catch (err) {
      logger.warn(`Fivetran getJiraTickets error: ${err.message}`);
      return [];
    }
  }

  /**
   * Get active PagerDuty alerts
   */
  async getPagerDutyAlerts(projectId) {
    try {
      const connectors = await this.request('/connectors?limit=20');
      const pdConnector = connectors.data?.items?.find(c =>
        c.service === 'pagerduty'
      );

      if (!pdConnector) {
        logger.warn('Fivetran: no PagerDuty connector found');
        return [];
      }

      return this._fetchPagerDutyFromDestination(projectId, pdConnector.id);
    } catch (err) {
      logger.warn(`Fivetran getPagerDutyAlerts error: ${err.message}`);
      return [];
    }
  }

  /**
   * Get database performance metrics
   */
  async getDbMetrics(projectId) {
    try {
      const connectors = await this.request('/connectors?limit=20');
      const dbConnector = connectors.data?.items?.find(c =>
        ['postgresql', 'mysql', 'aurora_postgres'].includes(c.service)
      );

      if (!dbConnector) return null;

      return this._fetchDbMetricsFromDestination(projectId, dbConnector.id);
    } catch (err) {
      logger.warn(`Fivetran getDbMetrics error: ${err.message}`);
      return null;
    }
  }

  /**
   * Check sync status of all connectors
   * Useful for diagnosing whether Fivetran data is fresh
   */
  async getSyncStatus() {
    try {
      const connectors = await this.request('/connectors?limit=50');
      return (connectors.data?.items || []).map(c => ({
        id:        c.id,
        service:   c.service,
        state:     c.status?.sync_state,
        lastSync:  c.succeeded_at,
        nextSync:  c.sync_frequency,
      }));
    } catch (err) {
      logger.warn(`Fivetran getSyncStatus error: ${err.message}`);
      return [];
    }
  }

  /**
   * Trigger a manual sync for a connector (e.g., before analysis)
   */
  async triggerSync(connectorId) {
    try {
      await this.request(`/connectors/${connectorId}/force`, { method: 'POST' });
      logger.info(`Fivetran: manual sync triggered for connector ${connectorId}`);
    } catch (err) {
      logger.warn(`Fivetran triggerSync error: ${err.message}`);
    }
  }

  // ── Destination query helpers ─────────────────────────────────────────────
  // In production these would be BigQuery/Snowflake SQL queries on Fivetran-synced tables

  async _fetchJiraFromDestination(projectId, connectorId) {
    // Simulated: in production, run BigQuery query like:
    // SELECT key, summary, status, priority, created, updated
    // FROM `fivetran_jira.issues`
    // WHERE project_key = ? AND status != 'Done'
    // ORDER BY updated DESC LIMIT 10
    logger.debug(`Fivetran: would query Jira destination for connector ${connectorId}`);
    return [];
  }

  async _fetchPagerDutyFromDestination(projectId, connectorId) {
    // SELECT id, title, urgency, created_at, service_name
    // FROM `fivetran_pagerduty.incidents`
    // WHERE status = 'triggered' AND created_at > TIMESTAMP_SUB(NOW(), INTERVAL 24 HOUR)
    logger.debug(`Fivetran: would query PagerDuty destination for connector ${connectorId}`);
    return [];
  }

  async _fetchDbMetricsFromDestination(projectId, connectorId) {
    logger.debug(`Fivetran: would query DB metrics destination for connector ${connectorId}`);
    return null;
  }

  // ── Mock data for development ─────────────────────────────────────────────

  _mockEnrichedContext(projectId, ref) {
    logger.debug('Fivetran: returning mock enriched context');

    const isMainBranch = ref === 'main' || ref === 'master';

    return {
      jiraTickets: [
        {
          key:      'PROJ-1142',
          summary:  'Intermittent DB connection timeouts in staging',
          status:   'In Progress',
          priority: 'High',
          assignee: 'backend-team',
          created:  new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          key:      'PROJ-1138',
          summary:  'CI pipeline flaky on main branch — npm install timeout',
          status:   'Open',
          priority: 'Medium',
          assignee: 'devops-team',
          created:  new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      pagerDutyAlerts: isMainBranch ? [
        {
          id:          'PD-8821',
          summary:     'High error rate on auth-service (>5% 5xx)',
          urgency:     'high',
          createdAt:   new Date(Date.now() - 45 * 60 * 1000).toISOString(),
          serviceName: 'auth-service-prod',
        },
      ] : [],
      dbMetrics: {
        cpu:              72,
        connections:      143,
        maxConnections:   200,
        queryLatencyP99:  890,
        replicationLagMs: 1200,
        activeQueries:    12,
        waitingQueries:   3,
        capturedAt:       new Date().toISOString(),
      },
      sha:       'mock-sha',
      ref,
      fetchedAt: new Date().toISOString(),
      _isMock:   true,
    };
  }
}

