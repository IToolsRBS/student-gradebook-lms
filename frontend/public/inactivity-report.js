import { loadSignedInUser, startClock, readResponseJson, pollExportJob, setAppBusy, updateAppBusy, clearAppBusy } from "./shared.js";

const exportBtn = document.getElementById("exportBtn");
const exportStatusEl = document.getElementById("exportStatus");
const exportProgressEl = document.getElementById("exportProgress");
const progressStageTextEl = document.getElementById("progressStageText");
const progressElapsedEl = document.getElementById("progressElapsed");
const progressFillEl = document.getElementById("progressFill");
const dateFromEl = document.getElementById("dateFrom");
const dateToEl = document.getElementById("dateTo");
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
      item.textContent = "Loading...";
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
      openEl
        .querySelector(".dropdown-trigger")
        ?.setAttribute("aria-expanded", "false");
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
    filteredOptions = options.filter((option) =>
      option.label.toLowerCase().includes(term)
    );
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
    }
  };
}

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

  function updateTrigger() {
    const selected = selectableOptions().filter((option) =>
      selectedValues.has(option.value)
    );
    if (!selected.length) {
      valueEl.textContent = placeholder;
      return;
    }
    if (selected.length === 1) {
      valueEl.textContent = selected[0].label;
      return;
    }
    const plural = pluralLabel();
    if (selected.length === selectableOptions().length) {
      valueEl.textContent = `All ${plural} (${selected.length})`;
      return;
    }
    valueEl.textContent = `${selected.length} ${plural} selected`;
  }

  function notifyChange() {
    if (typeof onSelect === "function") onSelect(getValues());
  }

  function toggleValue(value) {
    if (selectedValues.has(value)) selectedValues.delete(value);
    else selectedValues.add(value);
    updateTrigger();
    renderOptions();
    notifyChange();
  }

  function setAllSelected(checked) {
    selectedValues = new Set();
    if (checked) {
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
      item.textContent = "Loading...";
      menu.appendChild(item);
      return;
    }
    if (!options.length) {
      const item = document.createElement("li");
      item.className = "dropdown-option empty";
      item.textContent = "No options available";
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
      const actionRow = document.createElement("div");
      actionRow.className = "dropdown-option-row";
      const actionCheckbox = document.createElement("input");
      actionCheckbox.type = "checkbox";
      actionCheckbox.className = "dropdown-checkbox";
      actionCheckbox.checked = allSelected;
      actionCheckbox.indeterminate =
        !allSelected &&
        selectable.some((option) => selectedValues.has(option.value));
      actionCheckbox.addEventListener("click", (event) => event.stopPropagation());
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
      const row = document.createElement("div");
      row.className = "dropdown-option-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "dropdown-checkbox";
      checkbox.checked = isSelected;
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => toggleValue(option.value));
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
      openEl
        .querySelector(".dropdown-trigger")
        ?.setAttribute("aria-expanded", "false");
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
    getValues
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
    progressFillEl.style.width = `${Number(STAGE_PROGRESS[stage] || 5)}%`;
  }
}

function hideProgressUi() {
  if (!exportProgressEl) return;
  exportProgressEl.classList.remove("visible", "failed", "done");
}

function selectedPeriodValue() {
  const checked = document.querySelector(
    'input[name="inactivityPeriod"]:checked'
  );
  return checked?.value || "";
}

function syncCustomDateInputs() {
  const isCustom = selectedPeriodValue() === "custom";
  if (dateFromEl) dateFromEl.disabled = !isCustom;
  if (dateToEl) dateToEl.disabled = !isCustom;
  document
    .getElementById("dateFromField")
    ?.classList.toggle("is-disabled", !isCustom);
  document
    .getElementById("dateToField")
    ?.classList.toggle("is-disabled", !isCustom);
}

function resolveInactivityPeriod() {
  const selected = selectedPeriodValue();
  if (!selected) {
    throw new Error("Select an inactivity period first.");
  }
  if (selected !== "custom") return selected;

  const fromValue = String(dateFromEl?.value || "").trim();
  const toValue = String(dateToEl?.value || "").trim();
  if (!fromValue) {
    throw new Error("Select a From date for the custom inactivity period.");
  }

  const fromDate = new Date(`${fromValue}T00:00:00`);
  const toDate = toValue
    ? new Date(`${toValue}T00:00:00`)
    : new Date();
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error("Custom period dates are invalid.");
  }
  if (toDate < fromDate) {
    throw new Error("To date must be on or after the From date.");
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.max(
    1,
    Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay)
  );
  return String(days);
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
      programmes.map((p) => ({
        value: p.programme_code,
        label: p.programme_code
      })),
      "Select programme(s)"
    );
  } finally {
    programmeDropdown.setLoading(false);
  }
}

async function loadModules(moduleDropdown, categoryName, programmeCodes) {
  moduleDropdown.setLoading(true);
  try {
    const modules = await fetchJson(
      `/api/modules?categoryName=${encodeURIComponent(categoryName)}&programmeCodes=${encodeURIComponent(programmeCodes.join(","))}`
    );
    moduleDropdown.setOptions(
      modules.map((m) => ({
        value: m.module_code,
        label:
          m.module_name && m.module_name !== m.module_code
            ? `${m.module_name} (${m.module_code})`
            : m.module_name || m.module_code
      })),
      "Select module(s)"
    );
  } finally {
    moduleDropdown.setLoading(false);
  }
}

function resetModules(moduleDropdown, hintEl) {
  moduleDropdown.setDisabled(true);
  moduleDropdown.setOptions([], "Select module(s)");
  if (hintEl) hintEl.hidden = false;
}

startClock();
loadSignedInUser();
syncCustomDateInputs();

document
  .querySelectorAll('input[name="inactivityPeriod"]')
  .forEach((input) => {
    input.addEventListener("change", syncCustomDateInputs);
  });

const categoryDropdown = initCustomDropdown(
  document.querySelector('[data-dropdown="category"]'),
  "Select category"
);
const programmeDropdown = initMultiSelectDropdown(
  document.querySelector('[data-dropdown="programme"]'),
  "Select programme(s)",
  { entityLabel: "programme" }
);
const moduleDropdown = initMultiSelectDropdown(
  document.querySelector('[data-dropdown="module"]'),
  "Select module(s)",
  { entityLabel: "module" }
);
const moduleHintEl = document.getElementById("moduleHint");

programmeDropdown.setDisabled(true);
moduleDropdown.setDisabled(true);

categoryDropdown.onChange(async (option) => {
  resetModules(moduleDropdown, moduleHintEl);
  if (!option.value) {
    programmeDropdown.setDisabled(true);
    programmeDropdown.setOptions([], "Select programme(s)");
    return;
  }
  programmeDropdown.setDisabled(false);
  await loadProgrammes(programmeDropdown, option.value);
});

programmeDropdown.onChange(async (programmeCodes) => {
  const categoryName = categoryDropdown.getValue();
  const codes = Array.isArray(programmeCodes)
    ? programmeCodes
    : programmeDropdown.getValues();
  if (!categoryName || !codes.length) {
    resetModules(moduleDropdown, moduleHintEl);
    return;
  }
  moduleDropdown.setDisabled(false);
  if (moduleHintEl) moduleHintEl.hidden = true;
  try {
    await loadModules(moduleDropdown, categoryName, codes);
  } catch (error) {
    resetModules(moduleDropdown, moduleHintEl);
    window.alert(`Could not load modules: ${error.message}`);
  }
});

loadCategories(categoryDropdown).catch((error) => {
  window.alert(`Could not load categories: ${error.message}`);
});

exportBtn?.addEventListener("click", async () => {
  const categoryName = categoryDropdown.getValue();
  const programmeCodes = programmeDropdown.getValues();

  if (!categoryName) {
    window.alert("Select a category (intake) first.");
    return;
  }

  let inactivityPeriod;
  try {
    inactivityPeriod = resolveInactivityPeriod();
  } catch (error) {
    window.alert(error.message || error);
    return;
  }

  const originalHtml = exportBtn.innerHTML;
  const startedAt = Date.now();
  let elapsedTicker = null;
  exportBtn.disabled = true;
  exportBtn.textContent = "Starting...";
  setAppBusy("Starting export job...");
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
    const startResponse = await fetch("/api/export-inactivity-report/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        categoryName,
        programmeCodes,
        inactivityPeriod
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
    const periodSlug =
      inactivityPeriod === "never" ? "never" : `${inactivityPeriod}d`;
    a.download =
      latestJob?.fileName ||
      `inactivity_report_${periodSlug}_${categoryName.replace(/\s+/g, "_")}_${Date.now()}.xlsx`;
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
    setTimeout(() => hideProgressUi(), 5000);
  }
});
