export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_HISTORY_ITEMS = 20;
export const LOCAL_SETTINGS_KEY = "privacySettings";
export const LOCAL_HISTORY_KEY = "privacyHistory";
export const SESSION_BINDINGS_KEY = "privacyBindings";

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const PROJECT_PATH_RE = new RegExp(`^/projects/(${UUID_PATTERN})/?$`);
const ALLOWED_THEMES = new Set(["dark", "light"]);
const GLOBAL_PANEL_ACTIONS = new Set(["forget", "setSettings", "clearHistory"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isValidWindowId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parseLovableProjectUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 2_048) return null;

  try {
    const url = new URL(rawUrl);
    if (url.origin !== "https://lovable.dev") return null;
    if (url.username || url.password || url.port) return null;
    if (url.search || url.hash) return null;

    const match = url.pathname.match(PROJECT_PATH_RE);
    if (!match) return null;

    return {
      projectUrl: url.href,
      projectId: match[1].toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function sanitizeBinding(value, expectedWindowId) {
  if (!hasExactKeys(value, ["windowId", "tabId", "projectUrl", "projectId"])) return null;
  if (!isValidWindowId(value.windowId) || !isValidTabId(value.tabId)) return null;
  if (expectedWindowId !== undefined && value.windowId !== expectedWindowId) return null;

  const parsed = parseLovableProjectUrl(value.projectUrl);
  if (!parsed || parsed.projectId !== String(value.projectId || "").toLowerCase()) return null;

  return {
    windowId: value.windowId,
    tabId: value.tabId,
    projectUrl: parsed.projectUrl,
    projectId: parsed.projectId,
  };
}

export function sanitizeBindingsMap(value) {
  if (!isPlainObject(value)) return {};

  const sanitized = {};
  for (const [key, binding] of Object.entries(value).slice(0, 32)) {
    const windowId = Number(key);
    if (!isValidWindowId(windowId) || String(windowId) !== key) continue;
    const clean = sanitizeBinding(binding, windowId);
    if (clean) sanitized[key] = clean;
  }
  return sanitized;
}

export function tabMatchesBinding(tab, binding) {
  const clean = sanitizeBinding(binding);
  if (!clean || !tab || tab.incognito === true) return false;
  if (tab.id !== clean.tabId || tab.windowId !== clean.windowId) return false;
  if (tab.url !== clean.projectUrl) return false;

  const parsed = parseLovableProjectUrl(tab.url);
  return Boolean(parsed && parsed.projectId === clean.projectId);
}

export function validateRequest(message) {
  if (!isPlainObject(message) || typeof message.action !== "string") {
    return { ok: false, error: "Invalid request." };
  }

  if (message.action === "getStatus") {
    if (!hasExactKeys(message, ["action", "windowId"]) || !isValidWindowId(message.windowId)) {
      return { ok: false, error: "Invalid request." };
    }
    return { ok: true, request: { action: "getStatus", windowId: message.windowId } };
  }

  if (message.action === "forget" || message.action === "clearHistory") {
    if (!hasExactKeys(message, ["action"])) return { ok: false, error: "Invalid request." };
    return { ok: true, request: { action: message.action } };
  }

  if (message.action === "setSettings") {
    if (!hasExactKeys(message, ["action", "settings"]) || !isPlainObject(message.settings)) {
      return { ok: false, error: "Invalid request." };
    }
    const keys = Object.keys(message.settings);
    if (keys.length !== 1) return { ok: false, error: "Change exactly one setting at a time." };

    if (keys[0] === "historyEnabled" && typeof message.settings.historyEnabled === "boolean") {
      return {
        ok: true,
        request: { action: "setSettings", settings: { historyEnabled: message.settings.historyEnabled } },
      };
    }
    if (keys[0] === "theme" && ALLOWED_THEMES.has(message.settings.theme)) {
      return {
        ok: true,
        request: { action: "setSettings", settings: { theme: message.settings.theme } },
      };
    }
    return { ok: false, error: "Invalid settings change." };
  }

  if (message.action === "sendPrompt") {
    if (!hasExactKeys(message, ["action", "windowId", "prompt"]) || !isValidWindowId(message.windowId)) {
      return { ok: false, error: "Invalid request." };
    }
    if (typeof message.prompt !== "string" || message.prompt.trim().length === 0) {
      return { ok: false, error: "Prompt cannot be blank." };
    }
    if (message.prompt.length > MAX_PROMPT_LENGTH) {
      return { ok: false, error: `Prompt exceeds ${MAX_PROMPT_LENGTH} characters.` };
    }
    return {
      ok: true,
      request: { action: "sendPrompt", windowId: message.windowId, prompt: message.prompt },
    };
  }

  return { ok: false, error: "Unknown action." };
}

export function validateTrustedSender(sender, request, runtimeId, inIncognitoContext = false) {
  if (!sender || !request || typeof runtimeId !== "string" || !runtimeId) {
    return { ok: false, error: "Untrusted sender." };
  }
  if (inIncognitoContext || sender.incognito === true || sender.tab) {
    return { ok: false, error: "This request is not allowed in this context." };
  }

  const extensionOrigin = `chrome-extension://${runtimeId}`;
  if (sender.id !== runtimeId || sender.origin !== extensionOrigin || typeof sender.url !== "string") {
    return { ok: false, error: "Untrusted sender." };
  }

  let senderUrl;
  try {
    senderUrl = new URL(sender.url);
  } catch {
    return { ok: false, error: "Untrusted sender." };
  }

  if (
    senderUrl.protocol !== "chrome-extension:" ||
    senderUrl.hostname !== runtimeId ||
    senderUrl.username ||
    senderUrl.password ||
    senderUrl.port ||
    senderUrl.pathname !== "/sidepanel.html" ||
    senderUrl.hash !== ""
  ) {
    return { ok: false, error: "Untrusted sender." };
  }

  const queryKeys = [...senderUrl.searchParams.keys()];
  if (queryKeys.length === 0) {
    if (request.action === "getStatus" || GLOBAL_PANEL_ACTIONS.has(request.action)) {
      return { ok: true, boundPanel: false };
    }
    return { ok: false, error: "Open the extension from the toolbar on a Lovable project." };
  }

  const queryWindowId = senderUrl.searchParams.get("windowId");
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "windowId" ||
    senderUrl.searchParams.getAll("windowId").length !== 1 ||
    !/^\d+$/.test(queryWindowId || "") ||
    !isValidWindowId(Number(queryWindowId)) ||
    String(Number(queryWindowId)) !== queryWindowId ||
    (!GLOBAL_PANEL_ACTIONS.has(request.action) && queryWindowId !== String(request.windowId))
  ) {
    return { ok: false, error: "Window context mismatch." };
  }

  return { ok: true, boundPanel: true };
}

export function sanitizePrivacySettings(value) {
  const settings = isPlainObject(value) ? value : {};
  return {
    historyEnabled: settings.historyEnabled === true,
    theme: ALLOWED_THEMES.has(settings.theme) ? settings.theme : "dark",
  };
}

function sanitizeHistoryItem(value) {
  if (!hasExactKeys(value, ["prompt", "timestamp"])) return null;
  if (
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0 ||
    value.prompt.length > MAX_PROMPT_LENGTH ||
    typeof value.timestamp !== "string"
  ) {
    return null;
  }

  const timestampMs = Date.parse(value.timestamp);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== value.timestamp) return null;
  return { prompt: value.prompt, timestamp: value.timestamp };
}

export function sanitizeLocalSnapshot(snapshot) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  const privacySettings = sanitizePrivacySettings(source[LOCAL_SETTINGS_KEY]);
  const privacyHistory = [];

  if (privacySettings.historyEnabled && Array.isArray(source[LOCAL_HISTORY_KEY])) {
    for (const value of source[LOCAL_HISTORY_KEY].slice(-MAX_HISTORY_ITEMS)) {
      const item = sanitizeHistoryItem(value);
      if (item) privacyHistory.push(item);
    }
  }

  return { privacySettings, privacyHistory };
}
