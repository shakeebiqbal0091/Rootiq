import { useState, useEffect, useCallback } from "react";

const MOCK_INCIDENTS = [
  {
    incidentId: "inc-a1b2c3d4",
    projectName: "backend-api",
    pipeline: 9921,
    ref: "main",
    sha: "a3f8c21d",
    rootCause: "NullPointerException in UserService.getById() — missing null-check on optional profileImage field introduced in commit a3f8c21d.",
    confidence: 0.94,
    confidenceLabel: "high",
    errorPatterns: ["NullPointerException", "UserService", "exit code 1"],
    issueUrl: "https://gitlab.com/demo/issues/441",
    prUrl: "https://gitlab.com/demo/mr/112",
    arizeTraceUrl: "https://app.phoenix.arize.com/trace/abc123",
    similarIncidentsFound: 2,
    durationMs: 38400,
    resolvedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    status: "resolved",
    sources: ["gitlab", "elastic", "mongodb", "fivetran", "arize"],
  },
  {
    incidentId: "inc-e5f6g7h8",
    projectName: "data-pipeline",
    pipeline: 9934,
    ref: "feature/heavy-processing",
    sha: "b7d2e93a",
    rootCause: "Container OOMKilled during webpack build. Node.js heap capped at 512MB but production bundle requires ~1.8GB. Fix: set NODE_OPTIONS=--max-old-space-size=2048 in CI variables.",
    confidence: 0.88,
    confidenceLabel: "high",
    errorPatterns: ["OOMKilled", "heap out of memory", "exit code 137"],
    issueUrl: "https://gitlab.com/demo/issues/438",
    prUrl: null,
    arizeTraceUrl: "https://app.phoenix.arize.com/trace/def456",
    similarIncidentsFound: 1,
    durationMs: 52100,
    resolvedAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    status: "resolved",
    sources: ["gitlab", "elastic", "mongodb", "arize"],
  },
  {
    incidentId: "inc-i9j0k1l2",
    projectName: "core-platform",
    pipeline: 9967,
    ref: "release/v2.4.0",
    sha: "c1e3a57b",
    rootCause: "Analysing — querying Elastic logs and cross-referencing MongoDB incident history...",
    confidence: 0,
    confidenceLabel: "pending",
    errorPatterns: [],
    issueUrl: null,
    prUrl: null,
    arizeTraceUrl: null,
    similarIncidentsFound: 0,
    durationMs: 0,
    resolvedAt: null,
    status: "analyzing",
    sources: ["gitlab"],
  },
];

const PARTNER_COLORS = {
  gitlab:   { bg: "#FC6D26", label: "GitLab" },
  elastic:  { bg: "#00BFB3", label: "Elastic" },
  mongodb:  { bg: "#00ED64", label: "MongoDB" },
  fivetran: { bg: "#0073FF", label: "Fivetran" },
  arize:    { bg: "#7C3AED", label: "Arize" },
};

const CONFIDENCE_COLOR = { high: "#22c55e", medium: "#f59e0b", low: "#ef4444", pending: "#6b7280" };

function PartnerBadge({ name }) {
  const p = PARTNER_COLORS[name];
  return (
    <span style={{
      background: p.bg + "22", color: p.bg, border: `1px solid ${p.bg}55`,
      borderRadius: 4, fontSize: 11, fontWeight: 600, padding: "2px 7px",
      display: "inline-flex", alignItems: "center", gap: 4
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.bg, display: "inline-block" }} />
      {p.label}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    resolved:  { color: "#22c55e", bg: "#22c55e18", label: "Resolved" },
    analyzing: { color: "#f59e0b", bg: "#f59e0b18", label: "Analysing…" },
    failed:    { color: "#ef4444", bg: "#ef444418", label: "Agent Error" },
  };
  const s = map[status] || map.failed;
  return (
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.color}44`,
      borderRadius: 4, fontSize: 11, fontWeight: 700, padding: "3px 9px",
      display: "inline-flex", alignItems: "center", gap: 5
    }}>
      {status === "analyzing" && (
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: s.color,
          animation: "pulse 1.2s infinite", display: "inline-block"
        }} />
      )}
      {s.label}
    </span>
  );
}

function IncidentCard({ inc, onClick, selected }) {
  const ago = inc.resolvedAt
    ? Math.round((Date.now() - new Date(inc.resolvedAt)) / 60000) + "m ago"
    : "just now";

  return (
    <div
      onClick={() => onClick(inc)}
      style={{
        background: selected ? "var(--color-background-secondary)" : "var(--color-background-primary)",
        border: `1px solid ${selected ? "#3b82f6" : "var(--color-border-tertiary)"}`,
        borderRadius: 8, padding: "14px 16px", cursor: "pointer",
        transition: "border-color .15s, background .15s",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text-primary)" }}>
            {inc.projectName}
          </span>
          <span style={{ color: "var(--color-text-tertiary)", fontSize: 12, marginLeft: 8 }}>
            #{inc.pipeline} · {inc.ref}
          </span>
        </div>
        <StatusBadge status={inc.status} />
      </div>

      {inc.status !== "analyzing" && (
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>
          {inc.rootCause.slice(0, 100)}…
        </p>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {inc.sources.map(s => <PartnerBadge key={s} name={s} />)}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-tertiary)" }}>{ago}</span>
      </div>
    </div>
  );
}

function ConfidenceMeter({ confidence, label }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Confidence</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: CONFIDENCE_COLOR[label] }}>
          {label === "pending" ? "Pending…" : `${Math.round(confidence * 100)}% (${label})`}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "var(--color-border-tertiary)" }}>
        <div style={{
          height: "100%", borderRadius: 3,
          background: CONFIDENCE_COLOR[label],
          width: `${confidence * 100}%`,
          transition: "width 0.8s ease"
        }} />
      </div>
    </div>
  );
}

function DetailPane({ inc }) {
  if (!inc) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-tertiary)", fontSize: 13 }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 12, opacity: 0.4 }}>
        <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
      </svg>
      Select an incident to view analysis
    </div>
  );

  return (
    <div style={{ padding: "20px", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 2 }}>
            {inc.projectName} — Pipeline #{inc.pipeline}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>
            {inc.sha} · {inc.ref} · ID: {inc.incidentId}
          </div>
        </div>
        <StatusBadge status={inc.status} />
      </div>

      <ConfidenceMeter confidence={inc.confidence} label={inc.confidenceLabel} />

      {/* Root cause */}
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "14px", marginBottom: 12, borderLeft: "3px solid #3b82f6" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", textTransform: "uppercase", marginBottom: 6, letterSpacing: "0.05em" }}>
          Root Cause
        </div>
        <p style={{ fontSize: 13, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.6 }}>
          {inc.rootCause}
        </p>
      </div>

      {/* Error patterns */}
      {inc.errorPatterns?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, fontWeight: 600 }}>Error Patterns Detected</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {inc.errorPatterns.map(p => (
              <code key={p} style={{
                background: "#ef444418", color: "#ef4444", border: "1px solid #ef444433",
                borderRadius: 4, fontSize: 11, padding: "2px 7px"
              }}>{p}</code>
            ))}
          </div>
        </div>
      )}

      {/* Partner integrations used */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, fontWeight: 600 }}>Partner Integrations Used</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {inc.sources.map(s => <PartnerBadge key={s} name={s} />)}
        </div>
      </div>

      {/* Similar incidents */}
      {inc.similarIncidentsFound > 0 && (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#00ED64", textTransform: "uppercase", marginBottom: 4, letterSpacing: "0.05em" }}>
            MongoDB — Similar Past Incidents
          </div>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>
            Found {inc.similarIncidentsFound} similar incident{inc.similarIncidentsFound > 1 ? "s" : ""} in history. Pattern match used to inform root cause analysis.
          </p>
        </div>
      )}

      {/* Actions taken */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 600 }}>Actions Taken</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {inc.issueUrl && (
            <a href={inc.issueUrl} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: "#FC6D2618", border: "1px solid #FC6D2633", borderRadius: 6,
              color: "#FC6D26", fontSize: 12, textDecoration: "none", fontWeight: 500
            }}>
              <span>🔗</span> GitLab Issue Created
              <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>↗</span>
            </a>
          )}
          {inc.prUrl && (
            <a href={inc.prUrl} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: "#22c55e18", border: "1px solid #22c55e33", borderRadius: 6,
              color: "#22c55e", fontSize: 12, textDecoration: "none", fontWeight: 500
            }}>
              <span>🔀</span> Auto-Patch PR Opened
              <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>↗</span>
            </a>
          )}
          {inc.arizeTraceUrl && (
            <a href={inc.arizeTraceUrl} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: "#7C3AED18", border: "1px solid #7C3AED33", borderRadius: 6,
              color: "#7C3AED", fontSize: 12, textDecoration: "none", fontWeight: 500
            }}>
              <span>🔭</span> Arize Reasoning Trace
              <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>↗</span>
            </a>
          )}
        </div>
      </div>

      {/* Timing */}
      {inc.durationMs > 0 && (
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", borderTop: "1px solid var(--color-border-tertiary)", paddingTop: 10 }}>
          Agent resolved this in {(inc.durationMs / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [incidents, setIncidents] = useState(MOCK_INCIDENTS);
  const [selected, setSelected] = useState(MOCK_INCIDENTS[0]);
  const [agentStatus, setAgentStatus] = useState("online");
  const [stats, setStats] = useState({ total: 3, resolved: 2, avgConfidence: 0.91, avgDuration: 45.2 });
  const [triggerLoading, setTriggerLoading] = useState(false);

  // Simulate a new incoming incident for demo
  const simulateFailure = useCallback(async () => {
    setTriggerLoading(true);
    const newInc = {
      incidentId: `inc-demo-${Date.now()}`,
      projectName: "frontend-app",
      pipeline: 9999,
      ref: "feat/demo-trigger",
      sha: "deadbeef",
      rootCause: "Analysing — querying Elastic logs and cross-referencing MongoDB incident history...",
      confidence: 0,
      confidenceLabel: "pending",
      errorPatterns: [],
      issueUrl: null, prUrl: null, arizeTraceUrl: null,
      similarIncidentsFound: 0, durationMs: 0, resolvedAt: null,
      status: "analyzing",
      sources: ["gitlab"],
    };
    setIncidents(prev => [newInc, ...prev]);
    setSelected(newInc);

    // Simulate agent working through steps
    await new Promise(r => setTimeout(r, 1200));
    setIncidents(prev => prev.map(i => i.incidentId === newInc.incidentId
      ? { ...i, sources: ["gitlab", "elastic"] } : i));

    await new Promise(r => setTimeout(r, 800));
    setIncidents(prev => prev.map(i => i.incidentId === newInc.incidentId
      ? { ...i, sources: ["gitlab", "elastic", "mongodb"] } : i));

    await new Promise(r => setTimeout(r, 700));
    setIncidents(prev => prev.map(i => i.incidentId === newInc.incidentId
      ? { ...i, sources: ["gitlab", "elastic", "mongodb", "fivetran"] } : i));

    await new Promise(r => setTimeout(r, 1800));
    const resolved = {
      ...newInc,
      rootCause: "Jest tests failed because jsonwebtoken@9.0 has a breaking API change — jwt.sign() now throws synchronously instead of calling callback. 14 tests assumed callback pattern. Fix: update tests to use async/await or promisify wrapper.",
      confidence: 0.91, confidenceLabel: "high",
      errorPatterns: ["jest", "TypeError: callback is not a function", "exit code 1"],
      issueUrl: "https://gitlab.com/demo/issues/445",
      prUrl: "https://gitlab.com/demo/mr/118",
      arizeTraceUrl: "https://app.phoenix.arize.com/trace/new999",
      similarIncidentsFound: 1,
      durationMs: 4700, resolvedAt: new Date().toISOString(),
      status: "resolved",
      sources: ["gitlab", "elastic", "mongodb", "fivetran", "arize"],
    };
    setIncidents(prev => prev.map(i => i.incidentId === newInc.incidentId ? resolved : i));
    setSelected(resolved);
    setStats(prev => ({ ...prev, total: prev.total + 1, resolved: prev.resolved + 1 }));
    setTriggerLoading(false);
  }, []);

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>

      {/* Header */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #3b82f6, #7C3AED)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🤖</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>DevOps Intelligence Agent</div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Powered by Gemini · Google Cloud Agent Builder</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Stats */}
          {[
            { label: "Incidents", value: stats.total },
            { label: "Resolved", value: stats.resolved },
            { label: "Avg Confidence", value: Math.round(stats.avgConfidence * 100) + "%" },
            { label: "Avg Time", value: stats.avgDuration + "s" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center", padding: "4px 12px", background: "var(--color-background-secondary)", borderRadius: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text-primary)" }}>{s.value}</div>
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>{s.label}</div>
            </div>
          ))}

          {/* Agent status */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#22c55e" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", animation: "pulse 2s infinite" }} />
            Agent {agentStatus}
          </div>

          {/* Trigger demo */}
          <button
            onClick={simulateFailure}
            disabled={triggerLoading}
            style={{
              background: triggerLoading ? "var(--color-background-secondary)" : "#ef4444",
              color: triggerLoading ? "var(--color-text-tertiary)" : "#fff",
              border: "none", borderRadius: 6, padding: "7px 14px",
              fontSize: 12, fontWeight: 600, cursor: triggerLoading ? "not-allowed" : "pointer",
              transition: "background .15s"
            }}
          >
            {triggerLoading ? "⏳ Analysing…" : "🚨 Trigger Demo Failure"}
          </button>
        </div>
      </div>

      {/* Partner bar */}
      <div style={{ padding: "8px 20px", borderBottom: "1px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginRight: 4 }}>Partner integrations:</span>
        {Object.entries(PARTNER_COLORS).map(([key, val]) => <PartnerBadge key={key} name={key} />)}
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Incident list */}
        <div style={{ width: 340, borderRight: "1px solid var(--color-border-tertiary)", padding: "14px", overflowY: "auto", flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Recent Incidents ({incidents.length})
          </div>
          {incidents.map(inc => (
            <IncidentCard
              key={inc.incidentId}
              inc={inc}
              onClick={setSelected}
              selected={selected?.incidentId === inc.incidentId}
            />
          ))}
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <DetailPane inc={selected} />
        </div>
      </div>
    </div>
  );
}