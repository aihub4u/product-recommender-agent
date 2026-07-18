const db = require('./db');
const pricing = require('./pricing');

async function logUsage({ projectId, provider, model, inputTokens, outputTokens }) {
  try {
    const { costUsd } = pricing.calculateCost(provider, model, inputTokens || 0, outputTokens || 0);
    await db.query(
      `INSERT INTO usage_logs (project_id, provider, model, input_tokens, output_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, provider, model || null, inputTokens || 0, outputTokens || 0, costUsd]
    );
  } catch (err) {
    // Usage logging must never break the actual recommendation request.
    console.error('[usageStore] failed to log usage:', err.message);
  }
}

// Per-project summary: totals + request count.
async function getProjectSummary(projectId, sinceDays = 30) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS request_count,
       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM usage_logs
     WHERE project_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
    [projectId, String(sinceDays)]
  );
  return rows[0];
}

// Platform-wide summary, grouped by project — for the global Usage & Costs tab.
async function getAllProjectsSummary(sinceDays = 30) {
  const { rows } = await db.query(
    `SELECT
       p.id AS project_id, p.name, p.slug,
       COUNT(u.id)::int AS request_count,
       COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(u.cost_usd), 0)::float AS cost_usd
     FROM projects p
     LEFT JOIN usage_logs u ON u.project_id = p.id AND u.created_at >= now() - ($1 || ' days')::interval
     GROUP BY p.id, p.name, p.slug
     ORDER BY cost_usd DESC NULLS LAST, p.name ASC`,
    [String(sinceDays)]
  );
  return rows;
}

// Platform-wide daily totals — for a simple trend view.
async function getDailyTotals(sinceDays = 30) {
  const { rows } = await db.query(
    `SELECT
       date_trunc('day', created_at) AS day,
       COUNT(*)::int AS request_count,
       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM usage_logs
     WHERE created_at >= now() - ($1 || ' days')::interval
     GROUP BY day
     ORDER BY day ASC`,
    [String(sinceDays)]
  );
  return rows;
}

module.exports = { logUsage, getProjectSummary, getAllProjectsSummary, getDailyTotals };
