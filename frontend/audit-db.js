import pg from "pg";

const { Pool } = pg;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS grab_export_audit (
  event_id UUID PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  event TEXT NOT NULL,
  job_id TEXT,
  report_type TEXT,
  status TEXT,
  user_email TEXT,
  user_name TEXT,
  user_role TEXT,
  filters JSONB,
  file_name TEXT,
  error TEXT,
  timings_ms JSONB
)`;

const CREATE_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS grab_export_audit_at_idx
     ON grab_export_audit (at DESC)`,
  `CREATE INDEX IF NOT EXISTS grab_export_audit_user_email_idx
     ON grab_export_audit (user_email)`
];

/**
 * Durable Neon Postgres store for export audit events.
 * Connection string (first match wins):
 *   AUDIT_DATABASE_URL | NEON_DATABASE_URL | DATABASE_URL
 */
export function createAuditDb({ connectionString } = {}) {
  const url = String(connectionString || "").trim();
  if (!url) {
    return {
      configured: false,
      ready: false,
      ensureReady: async () => false,
      insertEvent: async () => null,
      listEvents: async () => null
    };
  }

  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  let ready = false;
  let ensurePromise = null;

  async function ensureReady() {
    if (ready) return true;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query(CREATE_TABLE_SQL);
        for (const sql of CREATE_INDEXES_SQL) {
          await client.query(sql);
        }
        ready = true;
        return true;
      } finally {
        client.release();
      }
    })()
      .catch((error) => {
        ready = false;
        console.error("[audit-db] failed to ensure table", error);
        return false;
      })
      .finally(() => {
        ensurePromise = null;
      });
    return ensurePromise;
  }

  async function insertEvent(entry) {
    if (!entry?.eventId) {
      throw new Error("insertEvent requires eventId");
    }
    const ok = await ensureReady();
    if (!ok) {
      throw new Error("Neon audit store is not ready");
    }

    const values = [
      entry.eventId,
      entry.at || new Date().toISOString(),
      entry.event || null,
      entry.jobId || null,
      entry.reportType || null,
      entry.status || null,
      entry.userEmail || null,
      entry.userName || null,
      entry.userRole || null,
      entry.filters == null ? null : JSON.stringify(entry.filters),
      entry.fileName || null,
      entry.error || null,
      entry.timingsMs == null ? null : JSON.stringify(entry.timingsMs)
    ];
    const sql = `INSERT INTO grab_export_audit (
         event_id, at, event, job_id, report_type, status,
         user_email, user_name, user_role, filters, file_name, error, timings_ms
       ) VALUES (
         $1, $2::timestamptz, $3, $4, $5, $6,
         $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb
       )
       ON CONFLICT (event_id) DO NOTHING`;

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await pool.query(sql, values);
        console.info(
          `[audit-db] inserted event=${entry.event} job=${entry.jobId || "-"} email=${entry.userEmail || "-"}`
        );
        return entry;
      } catch (error) {
        lastError = error;
        console.warn(
          `[audit-db] insert attempt ${attempt}/3 failed: ${error?.message || error}`
        );
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }
    throw lastError || new Error("Neon audit insert failed");
  }

  function rowToEvent(row) {
    return {
      eventId: row.event_id,
      at: row.at instanceof Date ? row.at.toISOString() : row.at,
      event: row.event,
      jobId: row.job_id,
      reportType: row.report_type,
      status: row.status,
      userEmail: row.user_email,
      userName: row.user_name,
      userRole: row.user_role,
      filters: row.filters ?? null,
      fileName: row.file_name,
      error: row.error,
      timingsMs: row.timings_ms ?? null
    };
  }

  async function listEvents({ limit = 200, email, reportType, event } = {}) {
    const ok = await ensureReady();
    if (!ok) {
      throw new Error("Neon audit store is not ready");
    }
    const max = Math.min(Math.max(Number(limit) || 200, 1), 20000);
    const params = [];
    const clauses = [];

    const emailQuery = String(email || "")
      .trim()
      .toLowerCase();
    if (emailQuery) {
      params.push(`%${emailQuery}%`);
      clauses.push(`LOWER(COALESCE(user_email, '')) LIKE $${params.length}`);
    }
    const reportQuery = String(reportType || "").trim();
    if (reportQuery) {
      params.push(reportQuery);
      clauses.push(`report_type = $${params.length}`);
    }
    const eventQuery = String(event || "").trim();
    if (eventQuery) {
      params.push(eventQuery);
      clauses.push(`event = $${params.length}`);
    }

    params.push(max);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT event_id, at, event, job_id, report_type, status,
              user_email, user_name, user_role, filters, file_name, error, timings_ms
         FROM grab_export_audit
         ${where}
         ORDER BY at DESC
         LIMIT $${params.length}`,
      params
    );
    return result.rows.map(rowToEvent);
  }

  return {
    configured: true,
    get ready() {
      return ready;
    },
    ensureReady,
    insertEvent,
    listEvents
  };
}
