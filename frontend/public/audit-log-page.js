import {
  loadSignedInUser,
  startClock,
  readResponseJson
} from "./shared.js";

const auditStatusEl = document.getElementById("auditStatus");
const auditTableBody = document.getElementById("auditTableBody");
const auditEmailFilter = document.getElementById("auditEmailFilter");
const auditReportFilter = document.getElementById("auditReportFilter");
const auditEventFilter = document.getElementById("auditEventFilter");
const refreshAuditBtn = document.getElementById("refreshAuditBtn");
const exportAuditBtn = document.getElementById("exportAuditBtn");

let allEvents = [];

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatEvent(event) {
  switch (event) {
    case "export_started":
      return "Started";
    case "export_completed":
      return "Completed";
    case "export_failed":
      return "Failed";
    case "export_downloaded":
      return "Downloaded";
    default:
      return event || "—";
  }
}

function formatReport(reportType) {
  if (!reportType) return "—";
  return String(reportType)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatFilters(filters) {
  if (!filters || typeof filters !== "object") return "—";
  const parts = [];
  if (filters.categoryName) parts.push(`Category: ${filters.categoryName}`);
  if (filters.programmeCodes?.length) {
    parts.push(`Programmes: ${filters.programmeCodes.join(", ")}`);
  } else if (filters.programmeCode) {
    parts.push(`Programme: ${filters.programmeCode}`);
  }
  if (filters.moduleCodes?.length) {
    parts.push(`Modules: ${filters.moduleCodes.join(", ")}`);
  }
  if (filters.assessmentTypes?.length) {
    parts.push(`Assessment types: ${filters.assessmentTypes.join(", ")}`);
  }
  if (filters.assessments?.length) {
    parts.push(`Assessments: ${filters.assessments.join(", ")}`);
  }
  if (filters.statuses?.length) {
    parts.push(`Statuses: ${filters.statuses.join(", ")}`);
  }
  if (filters.inactivityPeriod) {
    parts.push(`Period: ${filters.inactivityPeriod}`);
  }
  if (filters.dueFrom || filters.dueTo) {
    parts.push(
      `Due: ${filters.dueFrom || "…"} → ${filters.dueTo || "…"}`
    );
  }
  return parts.length ? parts.join(" · ") : "—";
}

function getFilteredEvents() {
  const emailQuery = String(auditEmailFilter?.value || "")
    .trim()
    .toLowerCase();
  const reportQuery = String(auditReportFilter?.value || "").trim();
  const eventQuery = String(auditEventFilter?.value || "").trim();

  return allEvents.filter((event) => {
    if (
      emailQuery &&
      !String(event.userEmail || "")
        .toLowerCase()
        .includes(emailQuery)
    ) {
      return false;
    }
    if (reportQuery && event.reportType !== reportQuery) return false;
    if (eventQuery && event.event !== eventQuery) return false;
    return true;
  });
}

function populateReportFilter(events) {
  if (!auditReportFilter) return;
  const current = auditReportFilter.value;
  const reports = [
    ...new Set(events.map((event) => event.reportType).filter(Boolean))
  ].sort();
  auditReportFilter.innerHTML =
    `<option value="">All reports</option>` +
    reports
      .map(
        (report) =>
          `<option value="${report}">${formatReport(report)}</option>`
      )
      .join("");
  if (reports.includes(current)) auditReportFilter.value = current;
}

function renderTable() {
  if (!auditTableBody) return;
  const events = getFilteredEvents();
  if (!events.length) {
    auditTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="audit-empty">No audit events match the current filters.</td>
      </tr>
    `;
    if (auditStatusEl) {
      auditStatusEl.textContent = `Showing 0 of ${allEvents.length} events.`;
    }
    return;
  }

  auditTableBody.innerHTML = events
    .map((event) => {
      const userLabel = event.userEmail
        ? `${escapeHtml(event.userEmail)}${
            event.userName
              ? `<span class="audit-user-name">${escapeHtml(event.userName)}</span>`
              : ""
          }`
        : "—";
      const eventClass =
        event.event === "export_failed"
          ? "audit-event-failed"
          : event.event === "export_completed" ||
              event.event === "export_downloaded"
            ? "audit-event-ok"
            : "";
      return `
        <tr>
          <td>${escapeHtml(formatWhen(event.at))}</td>
          <td class="audit-user-cell">${userLabel}</td>
          <td><span class="audit-event-pill ${eventClass}">${escapeHtml(
            formatEvent(event.event)
          )}</span></td>
          <td>${escapeHtml(formatReport(event.reportType))}</td>
          <td class="audit-filters-cell">${escapeHtml(
            formatFilters(event.filters)
          )}</td>
          <td>${escapeHtml(event.status || "—")}</td>
          <td>${escapeHtml(event.fileName || "—")}</td>
        </tr>
      `;
    })
    .join("");

  if (auditStatusEl) {
    auditStatusEl.textContent = `Showing ${events.length} of ${allEvents.length} events.`;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadAuditLog() {
  if (auditStatusEl) auditStatusEl.textContent = "Loading audit log...";
  if (refreshAuditBtn) refreshAuditBtn.disabled = true;
  try {
    const response = await fetch("/api/audit-log?limit=1000", {
      credentials: "same-origin"
    });
    const payload = await readResponseJson(response);
    if (!response.ok) {
      throw new Error(payload?.error || "Could not load audit log");
    }
    allEvents = Array.isArray(payload.events) ? payload.events : [];
    populateReportFilter(allEvents);
    renderTable();
  } catch (error) {
    allEvents = [];
    if (auditTableBody) {
      auditTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="audit-empty">Could not load audit log.</td>
        </tr>
      `;
    }
    if (auditStatusEl) {
      auditStatusEl.textContent = `Failed: ${error.message || error}`;
    }
  } finally {
    if (refreshAuditBtn) refreshAuditBtn.disabled = false;
  }
}

function buildExportQuery() {
  const params = new URLSearchParams();
  params.set("limit", "5000");
  const email = String(auditEmailFilter?.value || "").trim();
  const report = String(auditReportFilter?.value || "").trim();
  const event = String(auditEventFilter?.value || "").trim();
  if (email) params.set("email", email);
  if (report) params.set("reportType", report);
  if (event) params.set("event", event);
  return params.toString();
}

async function exportAuditLog() {
  if (exportAuditBtn) exportAuditBtn.disabled = true;
  try {
    const response = await fetch(`/api/audit-log/export?${buildExportQuery()}`, {
      credentials: "same-origin"
    });
    if (!response.ok) {
      const payload = await readResponseJson(response).catch(() => ({}));
      throw new Error(payload?.error || "Export failed");
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = downloadUrl;
    a.download =
      response.headers
        .get("Content-Disposition")
        ?.match(/filename="?([^"]+)"?/i)?.[1] || `GRAB-audit-log-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
    if (auditStatusEl) {
      auditStatusEl.textContent = "Excel export downloaded.";
    }
  } catch (error) {
    window.alert(`Audit export failed: ${error.message || error}`);
  } finally {
    if (exportAuditBtn) exportAuditBtn.disabled = false;
  }
}

refreshAuditBtn?.addEventListener("click", () => {
  loadAuditLog();
});
exportAuditBtn?.addEventListener("click", () => {
  exportAuditLog();
});
auditEmailFilter?.addEventListener("input", () => renderTable());
auditReportFilter?.addEventListener("change", () => renderTable());
auditEventFilter?.addEventListener("change", () => renderTable());

startClock();
loadSignedInUser();
loadAuditLog();
