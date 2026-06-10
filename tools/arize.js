// tools/arize.js — Arize Phoenix OTLP trace logger for DevOps Intelligence Agent
// Sends OpenTelemetry spans to Arize for LLM observability + confidence tracking.
// Falls back to local logging only when credentials are absent.

import { randomUUID } from 'crypto';
import logger from '../agent/logger.js';

export class ArizeTool {
  constructor() {
    this._apiKey = process.env.ARIZE_API_KEY;
    this._spaceId = process.env.ARIZE_SPACE_ID;
    this._modelId = process.env.ARIZE_MODEL_ID || 'devops-intelligence-agent';
    this._endpoint =
      process.env.PHOENIX_COLLECTOR_ENDPOINT || 'https://app.phoenix.arize.com';
    this._enabled = Boolean(this._apiKey && this._spaceId);
  }

  // ---------------------------------------------------------------------------
  // Trace lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open an OTLP trace span for the entire agent run.
   * Returns a context object to pass through to endTrace.
   */
  startTrace({ incidentId, event, input }) {
    const traceId = randomUUID().replace(/-/g, '');
    const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
    const startTime = Date.now();

    const ctx = {
      traceId,
      spanId,
      startTime,
      incidentId,
      projectId: event?.project?.id,
      pipelineId: event?.object_attributes?.id,
      inputPreview: JSON.stringify(input || event || {}).slice(0, 500),
    };

    logger.debug('Arize trace started', { traceId, incidentId });
    return ctx;
  }

  /**
   * Flush the OTLP span with final attributes.
   * Returns the trace URL (for embedding in GitLab issues) or null.
   */
  async endTrace(ctx, { output, incidentId, success, durationMs, tokensUsed, error }) {
    if (!ctx) {
      logger.warn('endTrace called with null context');
      return null;
    }

    const attributes = {
      'openinference.span.kind': 'CHAIN',
      'input.value': ctx.inputPreview,
      'output.value': JSON.stringify(output || {}).slice(0, 4000),
      'llm.model_name': 'claude-sonnet-4-20250514',
      'llm.token_count.total': tokensUsed ?? 0,
      'metadata.incident_id': incidentId || ctx.incidentId,
      'metadata.project_id': ctx.projectId || '',
      'metadata.pipeline_id': ctx.pipelineId || '',
      'metadata.success': String(success),
      'metadata.duration_ms': durationMs ?? (Date.now() - ctx.startTime),
    };

    if (error) {
      attributes['exception.message'] = error.message || String(error);
    }

    if (this._enabled) {
      await this._flush(ctx, attributes);
    } else {
      logger.debug('Arize disabled — span logged locally', {
        traceId: ctx.traceId,
        success,
        durationMs: attributes['metadata.duration_ms'],
      });
    }

    return this._traceUrl(ctx.traceId);
  }

  /**
   * Log a child span for an individual LLM call.
   * Useful for tracking per-call token counts and latency.
   */
  async logLLMSpan({ parentCtx, model, prompt, response, tokensUsed, durationMs }) {
    if (!this._enabled) return;

    const spanCtx = {
      traceId: parentCtx.traceId,
      spanId: randomUUID().replace(/-/g, '').slice(0, 16),
      startTime: Date.now() - durationMs,
    };

    const attributes = {
      'openinference.span.kind': 'LLM',
      'llm.model_name': model || 'claude-sonnet-4-20250514',
      'input.value': prompt?.slice(0, 2000) || '',
      'output.value': response?.slice(0, 4000) || '',
      'llm.token_count.total': tokensUsed ?? 0,
    };

    await this._flush(spanCtx, attributes).catch((err) =>
      logger.warn('logLLMSpan flush failed', { error: err.message })
    );
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _flush(ctx, attributes) {
    const nowNs = BigInt(Date.now()) * BigInt(1_000_000);
    const startNs = BigInt(ctx.startTime) * BigInt(1_000_000);

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this._modelId } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: ctx.traceId,
                  spanId: ctx.spanId,
                  name: `devops-agent.${ctx.incidentId || 'run'}`,
                  kind: 3, // CLIENT
                  startTimeUnixNano: startNs.toString(),
                  endTimeUnixNano: nowNs.toString(),
                  attributes: Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value: { stringValue: String(value) },
                  })),
                  status: { code: attributes['metadata.success'] === 'false' ? 2 : 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(`${this._endpoint}/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Arize Phoenix expects these exact header names (lowercase)
          'api_key': this._apiKey,
          'space_id': this._spaceId,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Non-fatal — Arize 404s should never crash the agent run
        logger.warn('Arize OTLP flush failed (non-fatal — agent continues)', {
          status: response.status,
          hint: response.status === 404
            ? 'Check ARIZE_SPACE_ID and PHOENIX_COLLECTOR_ENDPOINT in .env'
            : 'Check ARIZE_API_KEY permissions',
          body: text.slice(0, 150),
        });
      } else {
        logger.debug('Arize OTLP span flushed', { traceId: ctx.traceId });
      }
    } catch (err) {
      // Network errors are also non-fatal
      logger.warn('Arize OTLP network error (non-fatal)', { error: err.message });
    }
  }

  _traceUrl(traceId) {
    return `${this._endpoint}/spaces/${this._spaceId}/traces/${traceId}`;
  }
}

export default ArizeTool;