import {
  LOCAL_HISTORY_KEY as HISTORY_KEY,
  LOCAL_SETTINGS_KEY as SETTINGS_KEY,
  MAX_PROMPT_LENGTH,
  SESSION_BINDINGS_KEY,
  isValidWindowId,
  sanitizeBindingsMap,
  sanitizeLocalSnapshot,
} from "./privacy-policy.js";

const DEFAULT_SETTINGS = Object.freeze({
  historyEnabled: false,
  theme: "dark",
});

const TEMPLATES = Object.freeze([
  {
    label: "Fix bugs",
    prompt: "Analyze the current project for bugs and runtime errors. Fix the confirmed issues and explain each change briefly.",
  },
  {
    label: "Refactor safely",
    prompt: "Refactor the current implementation for clarity and maintainability without changing its behavior.",
  },
  {
    label: "Improve UI",
    prompt: "Improve the current interface hierarchy, responsiveness, and accessibility while preserving the existing product scope.",
  },
  {
    label: "Review code",
    prompt: "Review the current code for correctness, security, performance, and maintainability. Fix only issues supported by evidence.",
  },
  {
    label: "Add error handling",
    prompt: "Add clear, user-friendly error handling to the current flow while preserving successful behavior.",
  },
  {
    label: "Improve accessibility",
    prompt: "Audit the current interface for keyboard, screen-reader, focus, contrast, and responsive issues, then fix the confirmed problems.",
  },
]);

const state = {
  windowId: null,
  connected: false,
  projectId: "",
  projectUrl: "",
  inFlight: false,
  settings: { ...DEFAULT_SETTINGS },
  history: [],
};

let preferencesLoadSequence = 0;

const elements = {
  connectionPill: document.querySelector("#connection-pill"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionMessage: document.querySelector("#connection-message"),
  projectDetail: document.querySelector("#project-detail"),
  form: document.querySelector("#prompt-form"),
  prompt: document.querySelector("#prompt-input"),
  characterCount: document.querySelector("#character-count"),
  templateGrid: document.querySelector("#template-grid"),
  sendButton: document.querySelector("#send-button"),
  sendLabel: document.querySelector("#send-label"),
  feedback: document.querySelector("#feedback"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeIcon: document.querySelector("#theme-icon"),
  themeLabel: document.querySelector("#theme-label"),
  historyToggle: document.querySelector("#history-toggle"),
  historyRegion: document.querySelector("#history-region"),
  historyList: document.querySelector("#history-list"),
  historyEmpty: document.querySelector("#history-empty"),
  clearHistory: document.querySelector("#clear-history"),
  forgetButton: document.querySelector("#forget-button"),
};

function parseWindowId() {
  const raw = new URLSearchParams(window.location.search).get("windowId");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return isValidWindowId(value) && String(value) === raw ? value : null;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("The extension background service is unavailable."));
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message || "The extension background service did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(result || {});
    });
  });
}

function setFeedback(message, kind = "info") {
  elements.feedback.textContent = message;
  elements.feedback.dataset.kind = kind;
  elements.feedback.hidden = !message;
}

function updateSendAvailability() {
  const hasPrompt = elements.prompt.value.trim().length > 0;
  elements.sendButton.disabled = !state.connected || state.inFlight || !hasPrompt;
}

function setConnectionState(kind, label, message, detail = "") {
  elements.connectionPill.dataset.state = kind;
  elements.connectionLabel.textContent = label;
  elements.connectionMessage.textContent = message;
  elements.projectDetail.textContent = detail;
  elements.projectDetail.hidden = !detail;
  updateSendAvailability();
}

function formatProjectDetail(projectUrl, projectId) {
  if (projectUrl) {
    try {
      const parsed = new URL(projectUrl);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return String(projectUrl).slice(0, 240);
    }
  }

  if (projectId) return `Project ${String(projectId).slice(0, 12)}`;
  return "";
}

function applyTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  elements.themeToggle.setAttribute("aria-pressed", String(isLight));
  elements.themeToggle.setAttribute("aria-label", isLight ? "Use dark theme" : "Use light theme");
  elements.themeIcon.textContent = isLight ? "☾" : "☀";
  elements.themeLabel.textContent = isLight ? "Dark" : "Light";
}

function updateCharacterCount() {
  const length = elements.prompt.value.length;
  elements.characterCount.textContent = `${length.toLocaleString()} / ${MAX_PROMPT_LENGTH.toLocaleString()}`;
  updateSendAvailability();
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderHistory() {
  elements.historyRegion.hidden = !state.settings.historyEnabled;
  elements.historyList.replaceChildren();

  const hasHistory = state.settings.historyEnabled && state.history.length > 0;
  elements.historyEmpty.hidden = hasHistory;
  elements.clearHistory.disabled = !hasHistory;

  if (!hasHistory) return;

  [...state.history].reverse().forEach((entry) => {
    const item = document.createElement("li");
    item.className = "history-item";

    const copy = document.createElement("div");
    copy.className = "history-copy";

    const prompt = document.createElement("p");
    prompt.className = "history-prompt";
    prompt.textContent = entry.prompt;

    const time = document.createElement("time");
    time.className = "history-time";
    time.dateTime = entry.timestamp;
    time.textContent = formatTimestamp(entry.timestamp);

    const restore = document.createElement("button");
    restore.className = "history-restore";
    restore.type = "button";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore prompt sent ${formatTimestamp(entry.timestamp)}`);
    restore.addEventListener("click", () => {
      elements.prompt.value = entry.prompt;
      updateCharacterCount();
      elements.prompt.focus();
      elements.prompt.scrollIntoView({ block: "center", behavior: "smooth" });
      setFeedback("Prompt restored. Review it before sending.", "success");
    });

    copy.append(prompt, time);
    item.append(copy, restore);
    elements.historyList.append(item);
  });
}

function renderTemplates() {
  const fragment = document.createDocumentFragment();

  TEMPLATES.forEach((template) => {
    const button = document.createElement("button");
    button.className = "template-button";
    button.type = "button";
    button.textContent = template.label;
    button.title = template.prompt;
    button.addEventListener("click", () => {
      elements.prompt.value = template.prompt;
      updateCharacterCount();
      elements.prompt.focus();
      setFeedback("Shortcut added to the prompt. Nothing has been sent.");
    });
    fragment.append(button);
  });

  elements.templateGrid.replaceChildren(fragment);
}

async function loadLocalPreferences() {
  const sequence = ++preferencesLoadSequence;
  const stored = await storageGet([SETTINGS_KEY, HISTORY_KEY]);
  const snapshot = sanitizeLocalSnapshot(stored);
  if (sequence !== preferencesLoadSequence) return false;

  state.settings = snapshot.privacySettings;
  state.history = snapshot.privacyHistory;

  elements.historyToggle.checked = state.settings.historyEnabled;
  applyTheme(state.settings.theme);
  renderHistory();
  return true;
}

async function setReviewedSetting(patch) {
  const response = await sendRuntimeMessage({ action: "setSettings", settings: patch });
  if (!response?.ok) throw new Error(response?.error || "Could not update local privacy settings.");
  await loadLocalPreferences();
}

function disconnectFromBinding(message) {
  state.connected = false;
  state.projectId = "";
  state.projectUrl = "";
  setConnectionState("disconnected", "Not connected", message);
}

function bindStorageSynchronization() {
  if (!chrome.storage?.onChanged?.addListener) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes[SETTINGS_KEY] || changes[HISTORY_KEY])) {
      loadLocalPreferences().catch(() => {
        setFeedback("Local privacy data changed, but this panel could not refresh it.", "warning");
      });
      return;
    }

    if (areaName !== "session" || !changes[SESSION_BINDINGS_KEY] || state.windowId === null) return;

    const bindings = sanitizeBindingsMap(changes[SESSION_BINDINGS_KEY].newValue);
    if (!bindings[String(state.windowId)]) {
      disconnectFromBinding(
        "This panel is no longer connected. Open a Lovable project and click the extension toolbar button to reconnect.",
      );
      return;
    }

    refreshConnection();
  });
}

async function refreshConnection() {
  if (state.windowId === null) {
    state.connected = false;
    setConnectionState(
      "disconnected",
      "Not connected",
      "Open a Lovable project, then click the extension toolbar button to connect this panel.",
    );
    return false;
  }

  state.connected = false;
  setConnectionState("checking", "Checking", "Checking the project selected from the Lovable toolbar…");

  try {
    const response = await sendRuntimeMessage({ action: "getStatus", windowId: state.windowId });
    if (!response?.ok) throw new Error(response?.error || "Could not check the selected project.");

    state.connected = response.connected === true;
    state.projectUrl = typeof response.projectUrl === "string" ? response.projectUrl : "";
    state.projectId = typeof response.projectId === "string" ? response.projectId : "";

    if (state.connected) {
      setConnectionState(
        "connected",
        "Connected",
        "Ready to send through Lovable's normal project interface.",
        formatProjectDetail(state.projectUrl, state.projectId),
      );
      return true;
    }

    setConnectionState(
      "disconnected",
      "Not connected",
      "Open a Lovable project, then click the extension toolbar button in that window.",
    );
    return true;
  } catch (error) {
    state.connected = false;
    setConnectionState(
      "error",
      "Unavailable",
      error instanceof Error ? error.message : "Could not check the selected Lovable project.",
    );
    return false;
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.inFlight) return;

  const prompt = elements.prompt.value;
  if (!prompt.trim()) {
    setFeedback("Enter a prompt before sending.", "error");
    elements.prompt.focus();
    return;
  }

  if (!state.connected || state.windowId === null) {
    setFeedback("Connect a Lovable project from the extension toolbar before sending.", "error");
    return;
  }

  state.inFlight = true;
  updateSendAvailability();
  elements.forgetButton.disabled = true;
  elements.sendButton.setAttribute("aria-busy", "true");
  elements.sendLabel.textContent = "Sending…";
  setFeedback("Sending through Lovable…");

  try {
    const response = await sendRuntimeMessage({
      action: "sendPrompt",
      windowId: state.windowId,
      prompt,
    });

    if (!response?.ok) throw new Error(response?.error || "Lovable did not accept the prompt.");

    elements.prompt.value = "";
    updateCharacterCount();
    setFeedback("Prompt sent to Lovable.", "success");

    try {
      await loadLocalPreferences();
      if (response.historySaved === false) {
        setFeedback("Prompt sent to Lovable, but local history was not saved.", "warning");
      }
    } catch {
      setFeedback("Prompt sent to Lovable, but local history could not be refreshed.", "warning");
    }
  } catch (error) {
    setFeedback(
      error instanceof Error ? error.message : "The prompt could not be sent. Your text is still here.",
      "error",
    );
  } finally {
    state.inFlight = false;
    elements.sendButton.removeAttribute("aria-busy");
    elements.sendLabel.textContent = "Send to Lovable";
    elements.forgetButton.disabled = false;
    updateSendAvailability();
  }
}

async function handleHistoryToggle() {
  const requested = elements.historyToggle.checked;
  elements.historyToggle.disabled = true;

  try {
    await setReviewedSetting({ historyEnabled: requested });
    setFeedback(
      requested
        ? "Local sent-prompt history is enabled."
        : "Local history is off and previously saved prompts were deleted.",
      "success",
    );
  } catch {
    elements.historyToggle.checked = state.settings.historyEnabled;
    setFeedback("Could not update local history settings.", "error");
  } finally {
    elements.historyToggle.disabled = false;
  }
}

async function clearHistory() {
  elements.clearHistory.disabled = true;
  try {
    const response = await sendRuntimeMessage({ action: "clearHistory" });
    if (!response?.ok) throw new Error(response?.error || "Could not clear local prompt history.");
    await loadLocalPreferences();
    setFeedback("Local prompt history cleared.", "success");
  } catch {
    setFeedback("Could not clear local prompt history.", "error");
  } finally {
    elements.clearHistory.disabled = state.history.length === 0;
  }
}

async function toggleTheme() {
  const previous = state.settings.theme;
  const requested = previous === "light" ? "dark" : "light";
  elements.themeToggle.disabled = true;

  try {
    await setReviewedSetting({ theme: requested });
  } catch {
    applyTheme(previous);
    setFeedback("Could not save the theme setting.", "error");
  } finally {
    elements.themeToggle.disabled = false;
  }
}

async function forgetLocalData() {
  if (state.inFlight) {
    setFeedback("Wait for the current send to finish before forgetting local data.", "warning");
    return;
  }

  const confirmed = window.confirm(
    "Forget local history, settings, and this panel's selected project? This cannot be undone.",
  );
  if (!confirmed) return;

  elements.forgetButton.disabled = true;
  elements.forgetButton.textContent = "Forgetting…";

  try {
    const response = await sendRuntimeMessage({ action: "forget" });
    if (!response?.ok) throw new Error(response?.error || "The background service could not forget local data.");

    state.settings = { ...DEFAULT_SETTINGS };
    state.history = [];
    state.connected = false;
    state.projectId = "";
    state.projectUrl = "";
    state.windowId = null;

    elements.prompt.value = "";
    elements.historyToggle.checked = false;
    applyTheme(DEFAULT_SETTINGS.theme);
    updateCharacterCount();
    renderHistory();
    setConnectionState(
      "disconnected",
      "Not connected",
      "Local data was forgotten. Open a Lovable project and click the extension toolbar button to reconnect.",
    );
    setFeedback("Local extension data forgotten.", "success");
  } catch (error) {
    setFeedback(
      error instanceof Error ? error.message : "Could not forget local extension data.",
      "error",
    );
  } finally {
    elements.forgetButton.disabled = false;
    elements.forgetButton.textContent = "Forget local data";
  }
}

function bindEvents() {
  elements.form.addEventListener("submit", handleSubmit);
  elements.prompt.addEventListener("input", updateCharacterCount);
  elements.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.historyToggle.addEventListener("change", handleHistoryToggle);
  elements.clearHistory.addEventListener("click", clearHistory);
  elements.forgetButton.addEventListener("click", forgetLocalData);
  bindStorageSynchronization();
}

async function initialize() {
  bindEvents();
  renderTemplates();
  updateCharacterCount();
  applyTheme(DEFAULT_SETTINGS.theme);

  state.windowId = parseWindowId();

  if (state.windowId === null) {
    await refreshConnection();
    return;
  }

  // The worker completes its storage migration before getStatus resolves.
  const workerReady = await refreshConnection();
  if (!workerReady) return;

  try {
    await loadLocalPreferences();
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
    state.history = [];
    applyTheme(DEFAULT_SETTINGS.theme);
    renderHistory();
    setFeedback("Local preferences could not be loaded; privacy defaults are active.", "error");
  }
}

initialize();
