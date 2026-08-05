import { loadSignedInUser, startClock, readResponseJson, pollExportJob } from "./shared.js";

const exportBtn = document.getElementById("exportBtn");
const exportStatusEl = document.getElementById("exportStatus");
const exportProgressEl = document.getElementById("exportProgress");
const progressStageTextEl = document.getElementById("progressStageText");
const progressElapsedEl = document.getElementById("progressElapsed");
const progressFillEl = document.getElementById("progressFill");
const STAGE_PROGRESS = {
  queued: 10,
  excel: 60,
  done: 100,
  error: 100
};

function initCustomDropdown(dropdownEl, placeholder) {
  const trigger = dropdownEl.querySelector(".dropdown-trigger");
  const valueEl = dropdownEl.querySelector(".dropdown-value");
  const menu = dropdownEl.querySelector(".dropdown-menu");
  const searchInput = dropdownEl.querySelector(".dropdown-search");
  let options = [{ value: "", label: placeholder }];
  let filteredOptions = options;
  let selectedValue = "";
  let onSelect = null;
  let loading = false;
  let disabled = false;

  function close() {
    if (disabled) return;
    dropdownEl.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
    if (searchInput) searchInput.value = "";
    filteredOptions = options;
  }

  function renderOptions() {
    menu.innerHTML = "";
    if (disabled) return;
    if (loading) {
      const item = document.createElement("li");
      item.className = "dropdown-option loading";
      item.textContent = "Loading categories...";
      menu.appendChild(item);
      return;
    }
    if (!filteredOptions.length) {
      const item = document.createElement("li");
      item.className = "dropdown-option empty";
      item.textContent = "No matches found";
      menu.appendChild(item);
      return;
    }
    filteredOptions.forEach((option) => {
      const item = document.createElement("li");
      item.className = "dropdown-option";
      if (option.value === selectedValue) item.classList.add("selected");
      item.setAttribute("role", "option");
      item.setAttribute(
        "aria-selected",
        option.value === selectedValue ? "true" : "false"
      );
      item.textContent = option.label;
      item.addEventListener("click", () => {
        selectedValue = option.value;
        valueEl.textContent = option.label;
        renderOptions();
        close();
        if (typeof onSelect === "function") onSelect(option);
      });
      menu.appendChild(item);
    });
  }

  trigger?.addEventListener("click", () => {
    if (disabled) return;
    const isOpen = dropdownEl.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((openEl) => {
      openEl.classList.remove("open");
      const openTrigger = openEl.querySelector(".dropdown-trigger");
      openTrigger?.setAttribute("aria-expanded", "false");
    });
    if (!isOpen) {
      dropdownEl.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      if (searchInput) searchInput.focus();
    } else {
      close();
    }
  });

  document.addEventListener("click", (event) => {
    if (!dropdownEl.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  searchInput?.addEventListener("input", () => {
    if (disabled) return;
    const term = searchInput.value.trim().toLowerCase();
    filteredOptions = options.filter((option) => {
      if (!option.value) return true;
      return option.label.toLowerCase().includes(term);
    });
    renderOptions();
  });

  valueEl.textContent = placeholder;
  renderOptions();

  return {
    setOptions(nextOptions, nextPlaceholder = placeholder) {
      options = [{ value: "", label: nextPlaceholder }, ...(nextOptions || [])];
      filteredOptions = options;
      selectedValue = "";
      valueEl.textContent = nextPlaceholder;
      loading = false;
      renderOptions();
    },
    setLoading(isLoading) {
      loading = isLoading;
      dropdownEl.classList.toggle("loading", loading);
      renderOptions();
    },
    onChange(handler) {
      onSelect = handler;
    },
    getValue() {
      return selectedValue;
    }
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function setProgressUi({
  visible = true,
  stage = "queued",
  text = "Starting...",
  elapsedMs = 0,
  failed = false,
  done = false
}) {
  if (!exportProgressEl) return;
  exportProgressEl.classList.toggle("visible", visible);
  exportProgressEl.classList.toggle("failed", failed);
  exportProgressEl.classList.toggle("done", done);
  if (progressStageTextEl) progressStageTextEl.textContent = text;
  if (progressElapsedEl) progressElapsedEl.textContent = formatElapsed(elapsedMs);
  if (progressFillEl) {
    const pct = Number(STAGE_PROGRESS[stage] || 5);
    progressFillEl.style.width = `${pct}%`;
  }
}

function hideProgressUi() {
  if (!exportProgressEl) return;
  exportProgressEl.classList.remove("visible", "failed", "done");
}

async function loadCategories(categoryDropdown) {
  categoryDropdown.setLoading(true);
  try {
    const categories = await fetchJson("/api/categories");
    categoryDropdown.setOptions(
      categories.map((c) => ({
        value: c.category_name,
        label: c.category_name
      })),
      "Select category"
    );
  } finally {
    categoryDropdown.setLoading(false);
  }
}

startClock();
loadSignedInUser();

const categoryDropdownEl = document.querySelector('[data-dropdown="category"]');
const categoryDropdown = initCustomDropdown(
  categoryDropdownEl,
  "Select category"
);

loadCategories(categoryDropdown).catch((error) => {
  window.alert(`Could not load categories: ${error.message}`);
});

exportBtn?.addEventListener("click", async () => {
  const categoryName = categoryDropdown.getValue();
  if (!categoryName) {
    window.alert("Select a category (intake) first.");
    return;
  }

  const originalHtml = exportBtn.innerHTML;
  const startedAt = Date.now();
  let elapsedTicker = null;
  exportBtn.disabled = true;
  exportBtn.textContent = "Starting...";
  if (exportStatusEl) exportStatusEl.textContent = "Starting export job...";
  setProgressUi({
    visible: true,
    stage: "queued",
    text: "Queued for processing...",
    elapsedMs: 0
  });
  elapsedTicker = setInterval(() => {
    if (progressElapsedEl) {
      progressElapsedEl.textContent = formatElapsed(Date.now() - startedAt);
    }
  }, 1000);

  try {
    const startResponse = await fetch("/api/export-intake-summary/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ categoryName })
    });
    const startPayload = await readResponseJson(startResponse);
    if (!startResponse.ok || !startPayload?.jobId) {
      throw new Error(startPayload?.error || "Could not start export");
    }

    const jobId = startPayload.jobId;
    const latestJob = await pollExportJob(jobId, {
      onUpdate: (job) => {
        const stageText = job?.message || `Working: ${job?.stage || "processing"}`;
        setProgressUi({
          visible: true,
          stage: job?.stage || "queued",
          text: stageText,
          elapsedMs: Date.now() - startedAt,
          failed: job?.status === "failed",
          done: job?.status === "done"
        });
        if (exportStatusEl) exportStatusEl.textContent = stageText;
      }
    });

    exportBtn.textContent = "Downloading...";
    if (exportStatusEl) exportStatusEl.textContent = "Downloading Excel...";
    const downloadResponse = await fetch(
      `/api/export-excel/jobs/${encodeURIComponent(jobId)}/download`,
      { credentials: "same-origin" }
    );
    if (!downloadResponse.ok) {
      let message = "Download failed";
      try {
        const payload = await readResponseJson(downloadResponse);
        message = payload?.error || message;
      } catch (parseError) {
        message =
          parseError?.message || `${message} (HTTP ${downloadResponse.status})`;
      }
      throw new Error(message);
    }

    const blob = await downloadResponse.blob();
    const exportMs = downloadResponse.headers.get("x-export-ms");
    const totalMs = downloadResponse.headers.get("x-total-ms");
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download =
      latestJob?.fileName ||
      `intake_summary_${categoryName.replace(/\s+/g, "_")}_${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);

    if (exportStatusEl) {
      const timingParts = [];
      if (exportMs) {
        timingParts.push(`excel ${Math.round(Number(exportMs) / 1000)}s`);
      }
      if (totalMs) {
        timingParts.push(`total ${Math.round(Number(totalMs) / 1000)}s`);
      }
      const timingText = timingParts.length
        ? ` (${timingParts.join(" | ")})`
        : "";
      exportStatusEl.textContent = `Done. Excel download started.${timingText}`;
    }
    setProgressUi({
      visible: true,
      stage: "done",
      text: "Completed successfully.",
      elapsedMs: Date.now() - startedAt,
      done: true
    });
  } catch (error) {
    window.alert(`Export failed: ${error.message || error}`);
    if (exportStatusEl) {
      exportStatusEl.textContent = `Failed: ${error.message || error}`;
    }
    setProgressUi({
      visible: true,
      stage: "error",
      text: `Failed: ${error.message || error}`,
      elapsedMs: Date.now() - startedAt,
      failed: true
    });
  } finally {
    if (elapsedTicker) clearInterval(elapsedTicker);
    exportBtn.disabled = false;
    exportBtn.innerHTML = originalHtml;
    setTimeout(() => {
      hideProgressUi();
    }, 5000);
  }
});
