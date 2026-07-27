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

function initMultiSelectDropdown(dropdownEl, placeholder) {
  const trigger = dropdownEl.querySelector(".dropdown-trigger");
  const valueEl = dropdownEl.querySelector(".dropdown-value");
  const menu = dropdownEl.querySelector(".dropdown-menu");
  const searchInput = dropdownEl.querySelector(".dropdown-search");
  let options = [];
  let filteredOptions = options;
  let selectedValues = new Set();
  let onSelect = null;
  let loading = false;
  let disabled = false;

  function selectableOptions() {
    return options.filter((option) => option.value);
  }

  function formatTriggerLabel() {
    const selected = selectableOptions().filter((option) =>
      selectedValues.has(option.value)
    );
    if (!selected.length) return placeholder;
    if (selected.length === 1) return selected[0].label;
    if (selected.length === selectableOptions().length) {
      return `All programmes (${selected.length})`;
    }
    return `${selected.length} programmes selected`;
  }

  function updateTrigger() {
    valueEl.textContent = formatTriggerLabel();
  }

  function notifyChange() {
    if (typeof onSelect === "function") {
      onSelect(getValues());
    }
  }

  function toggleValue(value) {
    if (!value) return;
    if (selectedValues.has(value)) selectedValues.delete(value);
    else selectedValues.add(value);
    updateTrigger();
    renderOptions();
    notifyChange();
  }

  function setAllSelected(selectAll) {
    selectedValues = new Set();
    if (selectAll) {
      selectableOptions().forEach((option) => selectedValues.add(option.value));
    }
    updateTrigger();
    renderOptions();
    notifyChange();
  }

  function close() {
    if (disabled) return;
    dropdownEl.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
    if (searchInput) searchInput.value = "";
    filteredOptions = options;
    renderOptions();
  }

  function renderOptions() {
    menu.innerHTML = "";
    if (disabled) return;
    if (loading) {
      const item = document.createElement("li");
      item.className = "dropdown-option loading";
      item.textContent = "Loading programmes...";
      menu.appendChild(item);
      return;
    }
    if (!options.length) {
      const item = document.createElement("li");
      item.className = "dropdown-option empty";
      item.textContent = "No programmes available";
      menu.appendChild(item);
      return;
    }

    const selectable = selectableOptions();
    if (selectable.length) {
      const allSelected =
        selectable.length > 0 &&
        selectable.every((option) => selectedValues.has(option.value));
      const action = document.createElement("li");
      action.className = "dropdown-option action-row";
      action.setAttribute("role", "option");
      const actionRow = document.createElement("div");
      actionRow.className = "dropdown-option-row";
      const actionCheckbox = document.createElement("input");
      actionCheckbox.type = "checkbox";
      actionCheckbox.className = "dropdown-checkbox";
      actionCheckbox.checked = allSelected;
      actionCheckbox.indeterminate =
        !allSelected &&
        selectable.some((option) => selectedValues.has(option.value));
      actionCheckbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      actionCheckbox.addEventListener("change", () => {
        setAllSelected(actionCheckbox.checked);
      });
      const actionLabel = document.createElement("span");
      actionLabel.className = "dropdown-option-label";
      actionLabel.textContent = allSelected ? "Clear all" : "Select all";
      actionRow.appendChild(actionCheckbox);
      actionRow.appendChild(actionLabel);
      action.appendChild(actionRow);
      action.addEventListener("click", (event) => {
        event.preventDefault();
        setAllSelected(!allSelected);
      });
      menu.appendChild(action);
    }

    if (!filteredOptions.length) {
      const item = document.createElement("li");
      item.className = "dropdown-option empty";
      item.textContent = "No matches found";
      menu.appendChild(item);
      return;
    }

    filteredOptions.forEach((option) => {
      if (!option.value) return;
      const item = document.createElement("li");
      const isSelected = selectedValues.has(option.value);
      item.className = "dropdown-option";
      if (isSelected) item.classList.add("selected");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", isSelected ? "true" : "false");

      const row = document.createElement("div");
      row.className = "dropdown-option-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "dropdown-checkbox";
      checkbox.checked = isSelected;
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("change", () => {
        toggleValue(option.value);
      });
      const label = document.createElement("span");
      label.className = "dropdown-option-label";
      label.textContent = option.label;
      row.appendChild(checkbox);
      row.appendChild(label);
      item.appendChild(row);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        toggleValue(option.value);
      });
      menu.appendChild(item);
    });
  }

  function getValues() {
    return selectableOptions()
      .filter((option) => selectedValues.has(option.value))
      .map((option) => option.value);
  }

  trigger?.addEventListener("click", () => {
    if (disabled) return;
    const isOpen = dropdownEl.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((openEl) => {
      if (openEl === dropdownEl) return;
      openEl.classList.remove("open");
      const openTrigger = openEl.querySelector(".dropdown-trigger");
      openTrigger?.setAttribute("aria-expanded", "false");
    });
    if (!isOpen) {
      dropdownEl.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      if (searchInput) searchInput.focus();
      renderOptions();
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
    filteredOptions = options.filter((option) =>
      option.label.toLowerCase().includes(term)
    );
    renderOptions();
  });

  valueEl.textContent = placeholder;
  renderOptions();

  return {
    setOptions(nextOptions, nextPlaceholder = placeholder) {
      options = [...(nextOptions || [])];
      filteredOptions = options;
      selectedValues = new Set();
      placeholder = nextPlaceholder;
      valueEl.textContent = placeholder;
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
        selectedValues = new Set();
        valueEl.textContent = placeholder;
        close();
      }
      renderOptions();
    },
    onChange(handler) {
      onSelect = handler;
    },
    getValues,
    getValue() {
      const values = getValues();
      return values.length === 1 ? values[0] : "";
    }
  };
}

async function readResponseJson(response) {
  if (response.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("Sign in required");
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      `Server returned an empty response (HTTP ${response.status}). The export may have timed out — try again.`
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

async function fetchJson(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  const payload = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loadSignedInUser() {
  const userBar = document.getElementById("userBar");
  const userNameEl = document.getElementById("userName");
  if (!userBar || !userNameEl) return;

  try {
    const response = await fetch("/auth/me", { credentials: "same-origin" });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload?.authenticated || !payload?.user) return;
    const label = payload.user.name || payload.user.email || "Signed in";
    userNameEl.textContent = label;
    userBar.hidden = false;
  } catch {
    // Auth may be disabled in local development.
  }
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
    programmeDropdown.setOptions([], "Select programme(s)");
    return;
  }
  programmeDropdown.setLoading(true);
  try {
    const programmes = await fetchJson(
      `/api/programmes?categoryName=${encodeURIComponent(categoryName)}`
    );
    programmeDropdown.setOptions(
      programmes.map((p) => {
        const code = p.programme_code;
        return { value: code, label: code };
      }),
      "Select programme(s)"
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
loadSignedInUser();

const categoryDropdownEl = document.querySelector('[data-dropdown="category"]');
const programmeDropdownEl = document.querySelector('[data-dropdown="programme"]');
const categoryDropdown = initCustomDropdown(categoryDropdownEl, "Select category");
const programmeDropdown = initMultiSelectDropdown(
  programmeDropdownEl,
  "Select programme(s)"
);
programmeDropdown.setDisabled(true);

categoryDropdown.onChange(async (option) => {
  if (!option.value) {
    programmeDropdown.setDisabled(true);
    programmeDropdown.setOptions([], "Select programme(s)");
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
  const programmeCodes = programmeDropdown.getValues();
  if (!categoryName || !programmeCodes.length) {
    window.alert("Select a category and at least one programme first.");
    return;
  }
  const originalText = exportBtn.textContent;
  const startedAt = Date.now();
  let elapsedTicker = null;
  exportBtn.disabled = true;
  exportBtn.textContent = "Starting...";
  if (exportStatusEl) {
    exportStatusEl.textContent =
      programmeCodes.length === 1
        ? "Starting export job..."
        : `Starting batch export for ${programmeCodes.length} programmes...`;
  }
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
      credentials: "same-origin",
      body: JSON.stringify({
        categoryName,
        programmeCodes,
        programmeCode: programmeCodes.length === 1 ? programmeCodes[0] : undefined
      })
    });
    const startPayload = await readResponseJson(startResponse);
    if (!startResponse.ok || !startPayload?.jobId) {
      throw new Error(startPayload?.error || "Could not start export");
    }

    const jobId = startPayload.jobId;
    let latestJob = null;
    while (true) {
      const pollResponse = await fetch(
        `/api/export-excel/jobs/${encodeURIComponent(jobId)}`,
        { credentials: "same-origin" }
      );
      const job = await readResponseJson(pollResponse);
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
        const detail = job?.error || job?.message || "Export job failed";
        throw new Error(detail);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

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
        message = parseError?.message || `${message} (HTTP ${downloadResponse.status})`;
      }
      throw new Error(message);
    }
    const blob = await downloadResponse.blob();
    const exportMs = downloadResponse.headers.get("x-export-ms");
    const totalMs = downloadResponse.headers.get("x-total-ms");
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    const fallbackName =
      programmeCodes.length === 1
        ? `gradebook_${programmeCodes[0]}_${Date.now()}.xlsx`
        : `gradebook_batch_${programmeCodes.length}prog_${Date.now()}.xlsx`;
    a.download = latestJob?.fileName || fallbackName;
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
