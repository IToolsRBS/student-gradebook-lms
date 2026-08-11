import fs from "fs";
import path from "path";

/**
 * Append-only export audit trail (JSON Lines).
 * Survives process restarts while the log directory persists; also mirrored to console.
 */
export function createAuditLogger({ logDir, fileName = "export-audit.jsonl" }) {
  const resolvedDir = path.resolve(logDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const logPath = path.join(resolvedDir, fileName);

  function append(event) {
    const entry = {
      at: new Date().toISOString(),
      ...event
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch (error) {
      console.error("[audit] failed to write log file", error);
    }
    console.info(
      `[audit] ${entry.event} email=${entry.userEmail || "-"} report=${entry.reportType || "-"} job=${entry.jobId || "-"} status=${entry.status || "-"}`
    );
    return entry;
  }

  function readRecent(limit = 200) {
    const max = Math.min(Math.max(Number(limit) || 200, 1), 5000);
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

  function filterEvents(events, { email, reportType, event } = {}) {
    const emailQuery = String(email || "")
      .trim()
      .toLowerCase();
    const reportQuery = String(reportType || "").trim();
    const eventQuery = String(event || "").trim();
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
      return true;
    });
  }

  function toCsv(events) {
    const headers = [
      "at",
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
    // UTF-8 BOM helps Excel open special characters correctly.
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  return {
    logPath,
    append,
    readRecent,
    filterEvents,
    toCsv
  };
}
