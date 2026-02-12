import { z, type ZodError } from "zod";

const uiConfigSchema = z
  .object({
    statusTtlSeconds: z.number().finite().min(0),
    alwaysOverride: z.boolean(),
    cacheMaxAgeSeconds: z.number().finite().min(0),
    emptyReadConfirmWindowSeconds: z.number().finite().min(0),
  })
  .strict();

type UiConfig = z.infer<typeof uiConfigSchema>;

const configResponseSchema = z
  .object({
    config: uiConfigSchema,
    meta: z
      .object({
        path: z.string().optional(),
        exists: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

const logStreamSchema = z.enum(["stdout", "stderr"]);
type LogStream = z.infer<typeof logStreamSchema>;
const logSortDirectionSchema = z.enum(["newest-first", "oldest-first"]);
type LogSortDirection = z.infer<typeof logSortDirectionSchema>;
const LOG_AUTO_REFRESH_INTERVAL_MS = 30_000;

const logsResponseSchema = z
  .object({
    ok: z.boolean(),
    stream: logStreamSchema,
    path: z.string(),
    lines: z.array(z.string()),
    totalLines: z.number().int().min(0),
    truncated: z.boolean(),
    missing: z.boolean(),
    configError: z.string().optional(),
  })
  .strict();

const clearLogsResponseSchema = z
  .object({
    ok: z.boolean(),
    stream: logStreamSchema,
    path: z.string(),
    missing: z.boolean(),
  })
  .strict();

const statusResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const formElement = document.querySelector<HTMLFormElement>("#config-form");
const statusElement = document.querySelector<HTMLDivElement>("#status");
const reloadButton = document.querySelector<HTMLButtonElement>("#reload-btn");
const resetButton = document.querySelector<HTMLButtonElement>("#reset-btn");
const saveButton = document.querySelector<HTMLButtonElement>("#save-btn");
const metaPathElement = document.querySelector<HTMLSpanElement>("#meta-path");
const metaExistsElement =
  document.querySelector<HTMLSpanElement>("#meta-exists");
const tabButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")
);
const tabPanels = {
  config: document.querySelector<HTMLElement>("#panel-config"),
  logs: document.querySelector<HTMLElement>("#panel-logs"),
};
const logClearButton =
  document.querySelector<HTMLButtonElement>("#logs-clear-btn");
const logReloadButton =
  document.querySelector<HTMLButtonElement>("#logs-reload-btn");
const logSearchInput = document.querySelector<HTMLInputElement>("#logs-search");
const logOutputElement = document.querySelector<HTMLDivElement>("#log-output");
const logMetaElement =
  document.querySelector<HTMLParagraphElement>("#logs-meta");
const logStreamButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".stream-btn[data-stream]")
);
const logSortButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".sort-btn[data-sort]")
);

let lastLoadedConfig: UiConfig | null = null;
let activeTab: "config" | "logs" = "config";
let activeLogStream: LogStream = "stdout";
let activeLogSortDirection: LogSortDirection = "newest-first";
let logsLoadedOnce = false;
let latestLogPath = "";
let latestLogLines: string[] = [];
let latestTotalLines = 0;
let latestLogsTruncated = false;
let latestLogsMissing = false;
let latestConfigError = "";

function formatZodError(error: ZodError) {
  return error.errors
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function setStatusMessage(kind: "ok" | "error" | "info", message: string) {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.classList.remove("ok", "error");
  if (kind === "ok") statusElement.classList.add("ok");
  if (kind === "error") statusElement.classList.add("error");
}

function getInput(id: string) {
  return document.getElementById(id);
}

function getNumericInput(id: string) {
  const element = getInput(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  return element;
}

function getCheckboxInput(id: string) {
  const element = getInput(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing checkbox: ${id}`);
  }
  return element;
}

function setInputValue(id: string, value: string | number | boolean) {
  const element = getInput(id);
  if (!(element instanceof HTMLInputElement)) return;
  if (element.type === "checkbox") {
    element.checked = value === true;
    return;
  }
  element.value = String(value);
}

function setFormValues(config: UiConfig) {
  setInputValue("statusTtlSeconds", config.statusTtlSeconds);
  setInputValue("alwaysOverride", config.alwaysOverride);
  setInputValue("cacheMaxAgeSeconds", config.cacheMaxAgeSeconds);
  setInputValue(
    "emptyReadConfirmWindowSeconds",
    config.emptyReadConfirmWindowSeconds
  );
}

function readNonNegativeNumber(id: string, label: string) {
  const input = getNumericInput(id);
  const value = input.value.trim();
  if (!value) throw new Error(`${label} is required.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function collectFormValues(): UiConfig {
  return {
    statusTtlSeconds: readNonNegativeNumber(
      "statusTtlSeconds",
      "Status TTL (seconds)"
    ),
    alwaysOverride: getCheckboxInput("alwaysOverride").checked,
    cacheMaxAgeSeconds: readNonNegativeNumber(
      "cacheMaxAgeSeconds",
      "Cache max age (seconds)"
    ),
    emptyReadConfirmWindowSeconds: readNonNegativeNumber(
      "emptyReadConfirmWindowSeconds",
      "Empty read window (seconds)"
    ),
  };
}

function setActiveTab(nextTab: "config" | "logs") {
  activeTab = nextTab;
  for (const tabButton of tabButtons) {
    const tabName = tabButton.dataset.tab;
    const isActive = tabName === nextTab;
    tabButton.classList.toggle("is-active", isActive);
    tabButton.setAttribute("aria-selected", String(isActive));
    tabButton.setAttribute("tabindex", isActive ? "0" : "-1");
  }

  const configPanel = tabPanels.config;
  const logsPanel = tabPanels.logs;
  if (configPanel) {
    const isConfigVisible = nextTab === "config";
    configPanel.hidden = !isConfigVisible;
    configPanel.setAttribute("aria-hidden", String(!isConfigVisible));
  }
  if (logsPanel) {
    const isLogsVisible = nextTab === "logs";
    logsPanel.hidden = !isLogsVisible;
    logsPanel.setAttribute("aria-hidden", String(!isLogsVisible));
  }
}

function activateTab(nextTab: "config" | "logs") {
  setActiveTab(nextTab);
  if (nextTab === "logs" && !logsLoadedOnce) {
    logsLoadedOnce = true;
    void loadLogsFromServer();
  }
}

function isLogStream(value: string): value is LogStream {
  return value === "stdout" || value === "stderr";
}

function isLogSortDirection(value: string): value is LogSortDirection {
  return value === "newest-first" || value === "oldest-first";
}

function setActiveLogStream(stream: LogStream) {
  activeLogStream = stream;
  for (const button of logStreamButtons) {
    const isActive = button.dataset.stream === stream;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function setActiveLogSortDirection(direction: LogSortDirection) {
  activeLogSortDirection = direction;
  for (const button of logSortButtons) {
    const isActive = button.dataset.sort === direction;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function setLogsActionButtonsDisabled(disabled: boolean) {
  if (logReloadButton) logReloadButton.disabled = disabled;
  if (logClearButton) logClearButton.disabled = disabled;
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, searchTerm: string) {
  if (!searchTerm) return escapeHtml(text);
  const pattern = new RegExp(`(${escapeRegExp(searchTerm)})`, "gi");
  return text
    .split(pattern)
    .map((part) => {
      if (part.toLowerCase() === searchTerm.toLowerCase()) {
        return `<mark>${escapeHtml(part)}</mark>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function getStderrLineClass(line: string) {
  if (/^\s*at\s+/.test(line)) return "is-stderr-stack";
  if (/^\s*\d+\s+\|/.test(line)) return "is-stderr-code";
  if (/^Bun v\d+\.\d+\.\d+/.test(line)) return "is-stderr-runtime";
  if (
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/.test(line)
  ) {
    return "is-stderr-error";
  }
  if (/\/\S+:\d+:\d+/.test(line)) return "is-stderr-path";
  return "";
}

function renderLogLine(line: string, searchTerm: string) {
  const structuredMatch =
    /^(\d{4}-\d{2}-\d{2}T\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/.exec(line);

  if (!structuredMatch) {
    if (activeLogStream === "stderr") {
      const stderrLineClass = getStderrLineClass(line);
      if (stderrLineClass) {
        return `<div class="log-line ${stderrLineClass}">${highlightText(
          line,
          searchTerm
        )}</div>`;
      }
    }
    return `<div class="log-line">${highlightText(line, searchTerm)}</div>`;
  }

  const timestamp = structuredMatch[1];
  const level = structuredMatch[2];
  const rest = structuredMatch[3];
  const metadataMatch = /^(.*?)(\s+\{.*\})$/.exec(rest);
  const message = metadataMatch ? metadataMatch[1] : rest;
  const metadata = metadataMatch ? metadataMatch[2].trim() : "";
  const levelClass = `is-${level.toLowerCase()}`;

  return [
    '<div class="log-line">',
    `<span class="log-ts">${highlightText(timestamp, searchTerm)}</span> `,
    `<span class="log-level ${levelClass}">${highlightText(
      level,
      searchTerm
    )}</span> `,
    `<span class="log-message">${highlightText(message, searchTerm)}</span>`,
    metadata
      ? ` <span class="log-json">${highlightText(metadata, searchTerm)}</span>`
      : "",
    "</div>",
  ].join("");
}

function renderLogs() {
  if (!logOutputElement || !logSearchInput || !logMetaElement) return;
  const searchTerm = logSearchInput.value.trim();
  const normalizedSearch = searchTerm.toLowerCase();
  const filteredLines = normalizedSearch
    ? latestLogLines.filter((line) =>
        line.toLowerCase().includes(normalizedSearch)
      )
    : latestLogLines;
  const visibleLines =
    activeLogSortDirection === "newest-first"
      ? [...filteredLines].reverse()
      : filteredLines;

  if (visibleLines.length === 0) {
    logOutputElement.innerHTML = `<div class="log-empty">${
      latestLogsMissing
        ? "Log file does not exist yet."
        : normalizedSearch
        ? "No lines match your search."
        : "No log lines to display."
    }</div>`;
  } else {
    logOutputElement.innerHTML = visibleLines
      .map((line) => renderLogLine(line, searchTerm))
      .join("");
  }

  const parts = [
    activeLogStream.toUpperCase(),
    `order: ${
      activeLogSortDirection === "newest-first"
        ? "newest first"
        : "oldest first"
    }`,
    latestLogPath ? `path: ${latestLogPath}` : "",
    `showing ${visibleLines.length}/${latestLogLines.length} loaded`,
    latestLogsTruncated ? `tail of ${latestTotalLines} total lines` : "",
  ].filter(Boolean);

  let message = parts.join(" • ");
  if (latestConfigError) {
    message = `${message} • config warning: ${latestConfigError}`;
  }
  logMetaElement.textContent = message;
}

async function loadConfigFromServer() {
  setStatusMessage("info", "Loading config...");
  try {
    const response = await fetch("/api/ui-config", {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (response.status === 401) {
      setStatusMessage("error", "Authentication required.");
      return;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || response.statusText);
    }

    const payload = await response.json();
    const parsed = configResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }

    lastLoadedConfig = parsed.data.config;
    setFormValues(parsed.data.config);
    if (metaPathElement)
      metaPathElement.textContent = parsed.data.meta?.path ?? "Unknown";
    if (metaExistsElement) {
      metaExistsElement.textContent =
        parsed.data.meta?.exists === false ? "No (will create)" : "Yes";
    }
    setStatusMessage("ok", "Config loaded.");
  } catch (error) {
    setStatusMessage(
      "error",
      error instanceof Error ? error.message : "Failed to load config."
    );
  }
}

async function saveConfigToServer() {
  let config: UiConfig;
  try {
    const values = collectFormValues();
    const parsed = uiConfigSchema.safeParse(values);
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }
    config = parsed.data;
  } catch (error) {
    setStatusMessage(
      "error",
      error instanceof Error ? error.message : "Validation failed."
    );
    return;
  }

  setStatusMessage("info", "Saving...");
  if (saveButton) saveButton.disabled = true;
  try {
    const response = await fetch("/api/ui-config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      body: JSON.stringify(config),
    });
    const payload = await response.json();
    const parsed = statusResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }
    if (!response.ok || parsed.data.ok === false) {
      throw new Error(parsed.data.error ?? "Save failed.");
    }
    setStatusMessage("ok", "Saved.");
    lastLoadedConfig = config;
  } catch (error) {
    setStatusMessage(
      "error",
      error instanceof Error ? error.message : "Save failed."
    );
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

async function loadLogsFromServer() {
  if (logMetaElement) {
    logMetaElement.textContent = `Loading ${activeLogStream} logs...`;
  }
  setLogsActionButtonsDisabled(true);

  try {
    const response = await fetch(
      `/api/logs?stream=${activeLogStream}&limit=2500`,
      {
        headers: { Accept: "application/json" },
        credentials: "include",
      }
    );

    if (response.status === 401) {
      throw new Error("Authentication required.");
    }

    const payload = await response.json();
    const statusPayload = statusResponseSchema.safeParse(payload);
    if (!response.ok) {
      if (statusPayload.success && statusPayload.data.error) {
        throw new Error(statusPayload.data.error);
      }
      throw new Error("Failed to load logs.");
    }

    const parsed = logsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }

    latestLogPath = parsed.data.path;
    latestLogLines = parsed.data.lines;
    latestTotalLines = parsed.data.totalLines;
    latestLogsTruncated = parsed.data.truncated;
    latestLogsMissing = parsed.data.missing;
    latestConfigError = parsed.data.configError ?? "";
    renderLogs();
  } catch (error) {
    latestLogPath = "";
    latestLogLines = [];
    latestTotalLines = 0;
    latestLogsTruncated = false;
    latestLogsMissing = false;
    latestConfigError = "";
    if (logOutputElement) {
      logOutputElement.innerHTML = `<div class="log-empty">${
        error instanceof Error
          ? escapeHtml(error.message)
          : "Failed to load logs."
      }</div>`;
    }
    if (logMetaElement) {
      logMetaElement.textContent =
        error instanceof Error ? error.message : "Failed to load logs.";
    }
  } finally {
    setLogsActionButtonsDisabled(false);
  }
}

async function clearActiveLogsOnServer() {
  if (logMetaElement) {
    logMetaElement.textContent = `Clearing ${activeLogStream} logs...`;
  }
  setLogsActionButtonsDisabled(true);

  try {
    const response = await fetch(`/api/logs?stream=${activeLogStream}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      credentials: "include",
    });

    if (response.status === 401) {
      throw new Error("Authentication required.");
    }

    const payload = await response.json();
    const statusPayload = statusResponseSchema.safeParse(payload);
    if (!response.ok) {
      if (statusPayload.success && statusPayload.data.error) {
        throw new Error(statusPayload.data.error);
      }
      throw new Error("Failed to clear logs.");
    }

    const parsed = clearLogsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }

    await loadLogsFromServer();
  } catch (error) {
    if (logMetaElement) {
      logMetaElement.textContent =
        error instanceof Error ? error.message : "Failed to clear logs.";
    }
  } finally {
    setLogsActionButtonsDisabled(false);
  }
}

for (const tabButton of tabButtons) {
  tabButton.addEventListener("click", () => {
    const targetTab = tabButton.dataset.tab;
    if (targetTab !== "config" && targetTab !== "logs") return;
    activateTab(targetTab);
  });

  tabButton.addEventListener("keydown", (event) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    const tabOrder: Array<"config" | "logs"> = ["config", "logs"];
    const currentIndex = tabOrder.indexOf(activeTab);
    let nextTab = activeTab;

    if (event.key === "Home") {
      nextTab = tabOrder[0];
    } else if (event.key === "End") {
      nextTab = tabOrder[tabOrder.length - 1];
    } else if (event.key === "ArrowRight") {
      nextTab = tabOrder[(currentIndex + 1) % tabOrder.length];
    } else if (event.key === "ArrowLeft") {
      nextTab =
        tabOrder[(currentIndex - 1 + tabOrder.length) % tabOrder.length];
    }

    activateTab(nextTab);
    const nextButton = document.querySelector<HTMLButtonElement>(
      `.tab[data-tab="${nextTab}"]`
    );
    nextButton?.focus();
  });
}

for (const streamButton of logStreamButtons) {
  streamButton.addEventListener("click", () => {
    const stream = streamButton.dataset.stream;
    if (!stream || !isLogStream(stream) || stream === activeLogStream) return;
    setActiveLogStream(stream);
    void loadLogsFromServer();
  });
}

for (const sortButton of logSortButtons) {
  sortButton.addEventListener("click", () => {
    const direction = sortButton.dataset.sort;
    if (
      !direction ||
      !isLogSortDirection(direction) ||
      direction === activeLogSortDirection
    ) {
      return;
    }
    setActiveLogSortDirection(direction);
    renderLogs();
  });
}

logSearchInput?.addEventListener("input", () => {
  renderLogs();
});

logReloadButton?.addEventListener("click", () => {
  void loadLogsFromServer();
});

logClearButton?.addEventListener("click", () => {
  void clearActiveLogsOnServer();
});

reloadButton?.addEventListener("click", () => {
  void loadConfigFromServer();
});

resetButton?.addEventListener("click", () => {
  if (!lastLoadedConfig) return;
  setFormValues(lastLoadedConfig);
  setStatusMessage("ok", "Reset to last loaded values.");
});

formElement?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfigToServer();
});

window.setInterval(() => {
  if (activeTab !== "logs") return;
  void loadLogsFromServer();
}, LOG_AUTO_REFRESH_INTERVAL_MS);

setActiveTab(activeTab);
setActiveLogStream(activeLogStream);
setActiveLogSortDirection(activeLogSortDirection);
void loadConfigFromServer();
