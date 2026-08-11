export function renderTime() {
  const timeDateEl = document.getElementById("timeDate");
  const timeClockEl = document.getElementById("timeClock");
  if (!timeDateEl || !timeClockEl) return;
  const now = new Date();
  timeDateEl.textContent = now
    .toLocaleDateString([], { day: "2-digit", month: "short" })
    .toUpperCase();
  timeClockEl.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Keep one layout; shrink on small screens, slight lift on large. */
export function fitUiScale() {
  const designWidth = 1280;
  const minScale = 0.68;
  const maxScale = 1.04;
  const next = Math.min(
    maxScale,
    Math.max(minScale, window.innerWidth / designWidth)
  );
  document.documentElement.style.setProperty("--ui-scale", next.toFixed(4));
}

/** Scale logo, nav, sign out, and time together so the header fits horizontally. */
export function fitSiteHeader() {
  const header = document.querySelector(".site-header");
  const brand = header?.querySelector(".brand");
  const nav = header?.querySelector(".site-nav");
  const actions = header?.querySelector(".top-bar-actions");
  if (!header || !brand || !nav || !actions) return;

  const measureUsed = () => {
    const styles = getComputedStyle(header);
    const gap = parseFloat(styles.columnGap) || 0;
    return brand.offsetWidth + nav.scrollWidth + actions.offsetWidth + gap * 2;
  };

  const applyFit = () => {
    fitUiScale();
    header.style.setProperty("--header-fit", "1");
    void header.offsetWidth;

    const styles = getComputedStyle(header);
    const padX =
      (parseFloat(styles.paddingLeft) || 0) +
      (parseFloat(styles.paddingRight) || 0);
    const available = header.clientWidth - padX;
    if (available <= 0) return;
    if (measureUsed() <= available + 1) return;

    let lo = 0.55;
    let hi = 1;
    let best = 0.55;
    for (let i = 0; i < 12; i += 1) {
      const mid = (lo + hi) / 2;
      header.style.setProperty("--header-fit", String(mid));
      void header.offsetWidth;
      if (measureUsed() <= available + 1) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    header.style.setProperty("--header-fit", String(best));
  };

  applyFit();
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", applyFit);
    return;
  }
  if (!header.dataset.fitBound) {
    header.dataset.fitBound = "1";
    const observer = new ResizeObserver(() => applyFit());
    observer.observe(document.documentElement);
    observer.observe(header);
  }
}

export function startClock() {
  fitUiScale();
  renderTime();
  setInterval(renderTime, 1000);
  fitSiteHeader();
}

export async function loadSignedInUser() {
  const userBar = document.getElementById("userBar");
  const userNameEl = document.getElementById("userName");

  try {
    const response = await fetch("/auth/me", { credentials: "same-origin" });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload?.authenticated || !payload?.user) return null;

    if (userBar && userNameEl) {
      const label = payload.user.name || payload.user.email || "Signed in";
      userNameEl.textContent = label;
      userBar.hidden = false;
    }

    applyFeatureAccess(payload);
    fitSiteHeader();
    return payload;
  } catch {
    // Auth may be disabled in local development.
    return null;
  }
}

/**
 * Hide nav/report links the signed-in role cannot use, and send restricted
 * users to their home report when they open a forbidden page.
 */
export function applyFeatureAccess(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : null;
  if (!features) return;

  const allowed = new Set(features);
  const homePath = payload.homePath || "/";

  document.querySelectorAll("[data-feature]").forEach((el) => {
    const feature = el.getAttribute("data-feature");
    if (!feature) return;
    const permitted = allowed.has(feature);
    el.hidden = !permitted;
    el.setAttribute("aria-hidden", permitted ? "false" : "true");
    if (!permitted && el.matches("a")) {
      el.setAttribute("tabindex", "-1");
    } else if (permitted && el.matches("a")) {
      el.removeAttribute("tabindex");
    }
  });

  const brand = document.querySelector(".brand");
  if (brand && homePath) {
    brand.setAttribute("href", homePath);
  }

  const currentFeature = document.body?.dataset?.feature;
  if (currentFeature && !allowed.has(currentFeature)) {
    window.location.replace(homePath);
  }
}

export async function readResponseJson(response) {
  if (response.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("Sign in required");
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      `Server returned an empty response (HTTP ${response.status}). The export may have timed out — try again with fewer programmes.`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(
      preview
        ? `Unexpected server response (HTTP ${response.status}): ${preview}`
        : `Unexpected server response (HTTP ${response.status})`
    );
  }
}

/** Lock the whole app UI while a report is building / downloading. */
export function setAppBusy(message = "Building report...") {
  document.body.classList.add("app-busy");
  document.body.setAttribute("aria-busy", "true");

  let overlay = document.getElementById("appBusyOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "appBusyOverlay";
    overlay.className = "app-busy-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "appBusyMessage");
    overlay.innerHTML = `
      <div class="app-busy-card">
        <span class="app-busy-spinner" aria-hidden="true"></span>
        <p id="appBusyMessage" class="app-busy-message"></p>
        <p class="app-busy-hint">Please wait — navigation and filters are locked until the download finishes.</p>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  updateAppBusy(message);
}

export function updateAppBusy(message) {
  const messageEl = document.getElementById("appBusyMessage");
  if (messageEl) {
    messageEl.textContent = message || "Building report...";
  }
}

export function clearAppBusy() {
  document.body.classList.remove("app-busy");
  document.body.removeAttribute("aria-busy");
  const overlay = document.getElementById("appBusyOverlay");
  if (overlay) overlay.remove();
}

/**
 * Poll an export job until done/failed. Retries transient parse/network errors
 * (common when Render restarts under memory pressure mid-export).
 */
export async function pollExportJob(
  jobId,
  { onUpdate, intervalMs = 1500, maxTransientRetries = 8 } = {}
) {
  let transientFailures = 0;
  while (true) {
    let job;
    try {
      const pollResponse = await fetch(
        `/api/export-excel/jobs/${encodeURIComponent(jobId)}`,
        { credentials: "same-origin" }
      );
      job = await readResponseJson(pollResponse);
      if (!pollResponse.ok) {
        throw new Error(job?.error || "Could not fetch export status");
      }
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      const detail = error?.message || String(error);
      if (transientFailures > maxTransientRetries) {
        throw new Error(
          `Lost contact with the export job after repeated failures (${detail}). ` +
            `The server may have restarted — try again with fewer programmes selected.`
        );
      }
      if (typeof onUpdate === "function") {
        onUpdate({
          status: "running",
          stage: "excel",
          message: `Waiting for export server... (retry ${transientFailures}/${maxTransientRetries})`
        });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    if (typeof onUpdate === "function") onUpdate(job);

    if (job?.status === "done") return job;
    if (job?.status === "failed") {
      throw new Error(job?.error || job?.message || "Export job failed");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
