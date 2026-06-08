const exportBtn = document.getElementById("exportBtn");
const exportStatusEl = document.getElementById("exportStatus");
const exportProgressEl = document.getElementById("exportProgress");
const progressStageTextEl = document.getElementById("progressStageText");
const progressElapsedEl = document.getElementById("progressElapsed");
const progressFillEl = document.getElementById("progressFill");
const timeDateEl = document.getElementById("timeDate");
const timeClockEl = document.getElementById("timeClock");
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
      item.textContent = placeholder.includes("category")
        ? "Loading categories..."
        : "Loading programmes...";
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
      item.setAttribute("aria-selected", option.value === selectedValue ? "true" : "false");
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
    setDisabled(isDisabled) {
      disabled = Boolean(isDisabled);
      dropdownEl.classList.toggle("disabled", disabled);
      if (disabled) {
        selectedValue = "";
        valueEl.textContent = placeholder;
        close();
      }
      renderOptions();
    },
    onChange(handler) {
      onSelect = handler;
    },
    getValue() {
      return selectedValue;
    },
    getSelectedLabel() {
      const match = options.find((option) => option.value === selectedValue);
      return match?.label || "";
    }
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
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

async function loadProgrammes(programmeDropdown, categoryName) {
  if (!categoryName) {
    programmeDropdown.setOptions([], "Select programme");
    return;
  }
  programmeDropdown.setLoading(true);
  try {
    const programmes = await fetchJson(
      `/api/programmes?categoryName=${encodeURIComponent(categoryName)}`
    );
    programmeDropdown.setOptions(
      programmes.map((p) => {
        const prefix = p.programme_code;
        const name = p.program_name || prefix;
        return {
          value: prefix,
          label: name === prefix ? prefix : `${prefix} — ${name}`
        };
      }),
      "Select programme"
    );
  } finally {
    programmeDropdown.setLoading(false);
  }
}

function renderTime() {
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

renderTime();
setInterval(renderTime, 1000);

const categoryDropdownEl = document.querySelector('[data-dropdown="category"]');
const programmeDropdownEl = document.querySelector('[data-dropdown="programme"]');
const categoryDropdown = initCustomDropdown(categoryDropdownEl, "Select category");
const programmeDropdown = initCustomDropdown(programmeDropdownEl, "Select programme");
programmeDropdown.setDisabled(true);

categoryDropdown.onChange(async (option) => {
  if (!option.value) {
    programmeDropdown.setDisabled(true);
    programmeDropdown.setOptions([], "Select programme");
    return;
  }
  programmeDropdown.setDisabled(false);
  await loadProgrammes(programmeDropdown, option.value);
});

loadCategories(categoryDropdown).catch((error) => {
  window.alert(`Could not load categories: ${error.message}`);
});

exportBtn?.addEventListener("click", async () => {
  const categoryName = categoryDropdown.getValue();
  const programmeCode = programmeDropdown.getValue();
  if (!categoryName || !programmeCode) {
    window.alert("Select category and programme first.");
    return;
  }
  const originalText = exportBtn.textContent;
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
    if (progressElapsedEl) progressElapsedEl.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);
  try {
    const startResponse = await fetch("/api/export-excel/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryName,
        programmeCode
      })
    });
    const startPayload = await startResponse.json();
    if (!startResponse.ok || !startPayload?.jobId) {
      throw new Error(startPayload?.error || "Could not start export");
    }

    const jobId = startPayload.jobId;
    let latestJob = null;
    while (true) {
      const pollResponse = await fetch(
        `/api/export-excel/jobs/${encodeURIComponent(jobId)}`
      );
      const job = await pollResponse.json();
      if (!pollResponse.ok) {
        throw new Error(job?.error || "Could not fetch export status");
      }
      latestJob = job;
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

      if (job?.status === "done") break;
      if (job?.status === "failed") {
        throw new Error(job?.error || job?.message || "Export job failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    exportBtn.textContent = "Downloading...";
    if (exportStatusEl) exportStatusEl.textContent = "Downloading Excel...";
    const downloadResponse = await fetch(
      `/api/export-excel/jobs/${encodeURIComponent(jobId)}/download`
    );
    if (!downloadResponse.ok) {
      const payload = await downloadResponse.json();
      throw new Error(payload?.error || "Download failed");
    }
    const blob = await downloadResponse.blob();
    const exportMs = downloadResponse.headers.get("x-export-ms");
    const totalMs = downloadResponse.headers.get("x-total-ms");
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = latestJob?.fileName || `gradebook_${programmeCode}_${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
    if (exportStatusEl) {
      const timingParts = [];
      if (exportMs) timingParts.push(`excel ${Math.round(Number(exportMs) / 1000)}s`);
      if (totalMs) timingParts.push(`total ${Math.round(Number(totalMs) / 1000)}s`);
      const timingText = timingParts.length ? ` (${timingParts.join(" | ")})` : "";
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
    if (exportStatusEl) exportStatusEl.textContent = `Failed: ${error.message || error}`;
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
    exportBtn.textContent = originalText;
    setTimeout(() => {
      hideProgressUi();
    }, 5000);
  }
});
