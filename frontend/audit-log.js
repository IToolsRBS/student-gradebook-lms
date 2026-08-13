import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Append-only export audit trail.
 * Always writes local JSON Lines under EXPORT_OUTPUT_DIR/audit (often /tmp on Render).
 * When a durable Neon store is configured, also inserts there and prefers it on read.
 */
export function createAuditLogger({
  logDir,
  fileName = "export-audit.jsonl",
  durableDb = null,
  appEnv = "unknown",
  appUrl = ""
}) {
  const resolvedDir = path.resolve(logDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const logPath = path.join(resolvedDir, fileName);
  const hasDurable = Boolean(durableDb?.configured);
  const resolvedAppEnv = String(appEnv || "unknown").trim().toLowerCase() || "unknown";
  const resolvedAppUrl = String(appUrl || "").trim();

  function storeLabel(source) {
    if (source === "neon" && hasDurable) return "neon+local";
    if (source === "neon") return "neon";
    if (hasDurable) return "local"; // durable configured but fell back
    return "local";
  }

  async function append(event) {
    const entry = {
      ...event,
      eventId: event?.eventId || crypto.randomUUID(),
      at: event?.at || new Date().toISOString(),
      appEnv: event?.appEnv || resolvedAppEnv,
      appUrl: event?.appUrl || resolvedAppUrl || null
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch (error) {
      console.error("[audit] failed to write log file", error);
      throw error;
    }

    if (hasDurable) {
      try {
        await durableDb.insertEvent(entry);
        entry.persisted = "neon";
      } catch (error) {
        // Local write already succeeded; keep the request path working.
        console.error(
          `[audit] durable Neon insert failed for ${entry.event}/${entry.jobId || "?"}:`,
          error?.message || error
        );
      }
    } else {
      console.warn(
        `[audit] Neon not configured — event ${entry.event} saved to local JSONL only`
      );
    }

    console.info(
      `[audit] ${entry.event} env=${entry.appEnv} email=${entry.userEmail || "-"} report=${entry.reportType || "-"} job=${entry.jobId || "-"} status=${entry.status || "-"}`
    );
    return entry;
  }

  function readRecentLocal(limit = 200) {
    const max = Math.min(Math.max(Number(limit) || 200, 1), 20000);
    if (!fs.existsSync(logPath)) return [];
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-max);
    const events = [];
    for (const line of recent) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip corrupt lines
      }
    }
    return events.reverse();
  }

  function filterEvents(events, { email, reportType, event, appEnv } = {}) {
    const emailQuery = String(email || "")
      .trim()
      .toLowerCase();
    const reportQuery = String(reportType || "").trim();
    const eventQuery = String(event || "").trim();
    const envQuery = String(appEnv || "")
      .trim()
      .toLowerCase();
    return events.filter((row) => {
      if (
        emailQuery &&
        !String(row.userEmail || "")
          .toLowerCase()
          .includes(emailQuery)
      ) {
        return false;
      }
      if (reportQuery && row.reportType !== reportQuery) return false;
      if (eventQuery && row.event !== eventQuery) return false;
      if (
        envQuery &&
        String(row.appEnv || "")
          .toLowerCase() !== envQuery
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Prefer Neon when configured; fall back to local JSONL on failure.
   * Returns { events, store, durable }.
   */
  async function listEvents({
    limit = 200,
    email,
    reportType,
    event,
    appEnv
  } = {}) {
    if (hasDurable) {
      try {
        const events = await durableDb.listEvents({
          limit,
          email,
          reportType,
          event,
          appEnv
        });
        return {
          events,
          store: storeLabel("neon"),
          durable: true,
          source: "neon"
        };
      } catch (error) {
        console.error(
          "[audit] Neon list failed; falling back to local JSONL",
          error
        );
      }
    }

    const local = filterEvents(readRecentLocal(limit), {
      email,
      reportType,
      event,
      appEnv
    });
    return {
      events: local,
      store: storeLabel("local"),
      durable: false,
      source: "local"
    };
  }

  function toCsv(events) {
    const headers = [
      "at",
      "appEnv",
      "appUrl",
      "userEmail",
      "userName",
      "userRole",
      "event",
      "reportType",
      "status",
      "jobId",
      "fileName",
      "filters",
      "error"
    ];
    const escapeCell = (value) => {
      const text =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };
    const lines = [headers.join(",")];
    for (const row of events) {
      lines.push(headers.map((key) => escapeCell(row[key])).join(","));
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  return {
    logPath,
    hasDurable,
    appEnv: resolvedAppEnv,
    appUrl: resolvedAppUrl,
    append,
    readRecent: readRecentLocal,
    listEvents,
    filterEvents,
    toCsv
  };
}
