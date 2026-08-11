import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Append-only export audit trail.
 * Local JSONL is a fast cache; durable history should also be written to MotherDuck.
 */
export function createAuditLogger({
  logDir,
  fileName = "export-audit.jsonl",
  persistEvent = null,
  loadEvents = null
}) {
  const resolvedDir = path.resolve(logDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const logPath = path.join(resolvedDir, fileName);

  function append(event) {
    const entry = {
      ...event,
      eventId: event?.eventId || crypto.randomUUID(),
      at: event?.at || new Date().toISOString()
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(logPath, line, "utf8");
    } catch (error) {
      console.error("[audit] failed to write local log file", error);
    }
    console.info(
      `[audit] ${entry.event} email=${entry.userEmail || "-"} report=${entry.reportType || "-"} job=${entry.jobId || "-"} status=${entry.status || "-"}`
    );

    if (typeof persistEvent === "function") {
      Promise.resolve()
        .then(() => persistEvent(entry))
        .catch((error) => {
          console.error("[audit] failed to persist event to MotherDuck", error);
        });
    }

    return entry;
  }

  function readLocal(limit = 200) {
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

  async function readRecent(limit = 200) {
    const max = Math.min(Math.max(Number(limit) || 200, 1), 20000);
    if (typeof loadEvents === "function") {
      try {
        const remote = await loadEvents(max);
        if (Array.isArray(remote) && remote.length) {
          return remote;
        }
      } catch (error) {
        console.error(
          "[audit] MotherDuck read failed; falling back to local log",
          error
        );
      }
    }
    return readLocal(max);
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
    readLocal,
    readRecent,
    filterEvents,
    toCsv
  };
}
