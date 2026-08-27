import { loadSignedInUser, startClock, readResponseJson, pollExportJob, setAppBusy, updateAppBusy, clearAppBusy } from "./shared.js";

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

function deriveEntityLabel(placeholder) {
  const match = String(placeholder || "").match(/select\s+(\w+)/i);
  return match ? match[1].toLowerCase() : "item";
}

function pluralEntityLabel(entityLabel) {
  return entityLabel.endsWith("s") ? entityLabel : `${entityLabel}s`;
}

function initMultiSelectDropdown(dropdownEl, placeholder, config = {}) {
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
  let entityLabel = config.entityLabel || deriveEntityLabel(placeholder);
  const pluralLabel = () => pluralEntityLabel(entityLabel);

  function selectableOptions() {
    return options.filter((option) => option.value);
  }

  function formatTriggerLabel() {
    const selected = selectableOptions().filter((option) =>
      selectedValues.has(option.value)
    );
    if (!selected.length) return placeholder;
    if (selected.length === 1) return selected[0].label;
    const plural = pluralLabel();
    if (selected.length === selectableOptions().length) {
      return `All ${plural} (${selected.length})`;
    }
    return `${selected.length} ${plural} selected`;
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
      item.textContent = `Loading ${pluralLabel()}...`;
      menu.appendChild(item);
      return;
    }
    if (!options.length) {
      const item = document.createElement("li");
      item.className = "dropdown-option empty";
      item.textContent = `No ${pluralLabel()} available`;
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
      if (!config.entityLabel) {
        entityLabel = deriveEntityLabel(placeholder);
      }
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
      "Select intake(s)"
    );
  } finally {
    categoryDropdown.setLoading(false);
  }
}

startClock();
loadSignedInUser();

const categoryDropdownEl = document.querySelector('[data-dropdown="category"]');
const categoryDropdown = initMultiSelectDropdown(
  categoryDropdownEl,
  "Select intake(s)",
  { entityLabel: "intake" }
);

loadCategories(categoryDropdown).catch((error) => {
  window.alert(`Could not load intakes: ${error.message}`);
});

exportBtn?.addEventListener("click", async () => {
  const categoryNames = categoryDropdown.getValues();
  if (!categoryNames.length) {
    window.alert("Select at least one category (intake) first.");
    return;
  }

  const originalHtml = exportBtn.innerHTML;
  const startedAt = Date.now();
  let elapsedTicker = null;
  const isBatch = categoryNames.length > 1;
  const startMessage = isBatch
    ? `Starting batch export for ${categoryNames.length} intakes...`
    : "Starting export job...";
  exportBtn.disabled = true;
  exportBtn.textContent = "Starting...";
  setAppBusy(startMessage);
  if (exportStatusEl) exportStatusEl.textContent = startMessage;
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
      body: JSON.stringify({
        categoryNames,
        categoryName: categoryNames.length === 1 ? categoryNames[0] : undefined
      })
    });
    const startPayload = await readResponseJson(startResponse);
    if (!startResponse.ok || !startPayload?.jobId) {
      throw new Error(startPayload?.error || "Could not start export");
    }

    const jobId = startPayload.jobId;
    const latestJob = await pollExportJob(jobId, {
      onUpdate: (job) => {
        const stageText = job?.message || `Working: ${job?.stage || "processing"}`;
        updateAppBusy(stageText);
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
    updateAppBusy("Downloading Excel...");
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
    const fallbackName = isBatch
      ? `intake_summary_batch_${categoryNames.length}cat_${Date.now()}.xlsx`
      : `intake_summary_${categoryNames[0].replace(/\s+/g, "_")}_${Date.now()}.xlsx`;
    a.download = latestJob?.fileName || fallbackName;
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
    clearAppBusy();
    exportBtn.disabled = false;
    exportBtn.innerHTML = originalHtml;
    setTimeout(() => {
      hideProgressUi();
    }, 5000);
  }
});
