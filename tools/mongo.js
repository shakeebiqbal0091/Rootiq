/**
 * MongoDB MCP Tool
 * Stores incidents, finds similar past failures, and tracks resolution patterns
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';
import  logger  from '../agent/logger.js';

export class MongoTool {
  constructor() {
    this.uri    = process.env.MONGODB_URI || 'mongodb://localhost:27017/devops_agent';
    this.dbName = process.env.MONGODB_DB  || 'devops_agent';
    this._client = null;
  }

  async client() {
    if (!this._client) {
      this._client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS:         8000,
      });
      await this._client.connect();
      logger.debug('MongoDB connected');
    }
    return this._client;
  }

  async db() {
    return (await this.client()).db(this.dbName);
  }

  async collection(name) {
    return (await this.db()).collection(name);
  }

  // ── Schema helpers ─────────────────────────────────────────────────────────

  async ensureIndexes() {
    const incidents = await this.collection('incidents');
    await incidents.createIndex({ projectId: 1, resolvedAt: -1 });
    await incidents.createIndex({ errorPatterns: 1 });
    await incidents.createIndex({ incidentId: 1 }, { unique: true });

    const kv = await this.collection('kv_store');
    await kv.createIndex({ key: 1 }, { unique: true });
  }

  // ── Incident CRUD ──────────────────────────────────────────────────────────

  /**
   * Save a completed incident record
   */
  async saveIncident(incident) {
    try {
      const col = await this.collection('incidents');
      const doc = { ...incident, createdAt: new Date(), resolvedAt: new Date() };
      await col.insertOne(doc);
      logger.debug(`MongoDB: incident ${incident.incidentId} saved`);
      return doc;
    } catch (err) {
      logger.warn(`MongoDB saveIncident failed: ${err.message}`);
      return incident; // non-fatal
    }
  }

  /**
   * Find similar past incidents by error pattern overlap
   * Uses a simple tag-intersection similarity: incidents sharing ≥1 error pattern
   * sorted by most recent and most similar
   */
  async findSimilarIncidents({ projectId, errorPatterns = [], ref, limit = 5 }) {
    try {
      const col = await this.collection('incidents');

      const query = {
        $or: [
          // Same project, overlapping error patterns
          { projectId: String(projectId), errorPatterns: { $elemMatch: { $in: errorPatterns } } },
          // Same branch regardless of project (catches repeated env issues)
          { ref, errorPatterns: { $elemMatch: { $in: errorPatterns } } },
        ],
      };

      const docs = await col
        .find(query)
        .sort({ resolvedAt: -1 })
        .limit(limit * 3) // fetch extra, then rank
        .toArray();

      // Score by overlap count
      const scored = docs.map(d => {
        const overlap = (d.errorPatterns || []).filter(p => errorPatterns.includes(p)).length;
        return { ...d, _score: overlap };
      });

      scored.sort((a, b) => b._score - a._score || b.resolvedAt - a.resolvedAt);
      return scored.slice(0, limit);
    } catch (err) {
      logger.warn(`MongoDB findSimilarIncidents failed: ${err.message}`);
      return this._mockSimilarIncidents(errorPatterns);
    }
  }

  /**
   * Get aggregated stats for a project (for enriched context)
   */
  async getProjectStats(projectId) {
    try {
      const col = await this.collection('incidents');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [total, recent, avgResolution] = await Promise.all([
        col.countDocuments({ projectId: String(projectId) }),
        col.countDocuments({ projectId: String(projectId), resolvedAt: { $gte: thirtyDaysAgo } }),
        col.aggregate([
          { $match: { projectId: String(projectId), durationMs: { $exists: true } } },
          { $group: { _id: null, avg: { $avg: '$durationMs' } } },
        ]).toArray(),
      ]);

      return {
        totalIncidents:    total,
        recentIncidents:   recent,
        avgResolutionMs:   avgResolution[0]?.avg || 0,
      };
    } catch (err) {
      logger.warn(`MongoDB getProjectStats failed: ${err.message}`);
      return { totalIncidents: 0, recentIncidents: 0, avgResolutionMs: 0 };
    }
  }

  /**
   * Generic key-value store (for agent state persistence)
   */
  async kvSet(key, value) {
    try {
      const col = await this.collection('kv_store');
      await col.updateOne({ key }, { $set: { key, value, updatedAt: new Date() } }, { upsert: true });
    } catch (err) {
      logger.warn(`MongoDB kvSet failed: ${err.message}`);
    }
  }

  async kvGet(key) {
    try {
      const col = await this.collection('kv_store');
      const doc = await col.findOne({ key });
      return doc?.value ?? null;
    } catch (err) {
      logger.warn(`MongoDB kvGet failed: ${err.message}`);
      return null;
    }
  }

  async close() {
    if (this._client) {
      await this._client.close();
      this._client = null;
    }
  }

  _mockSimilarIncidents(errorPatterns) {
    if (!errorPatterns?.length) return [];
    return [
      {
        incidentId:  'mock-001',
        projectId:   'demo',
        ref:         'main',
        rootCause:   'Database connection pool exhausted during high-load deploy',
        durationMs:  1200000,
        resolvedAt:  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        errorPatterns,
        _score:      2,
      },
      {
        incidentId:  'mock-002',
        projectId:   'demo',
        ref:         'main',
        rootCause:   'Missing environment variable DATABASE_URL in staging config',
        durationMs:  900000,
        resolvedAt:  new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        errorPatterns: errorPatterns.slice(0, 1),
        _score:      1,
      },
    ];
  }
}
