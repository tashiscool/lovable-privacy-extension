import {
  LOCAL_HISTORY_KEY,
  LOCAL_SETTINGS_KEY,
  MAX_HISTORY_ITEMS,
  SESSION_BINDINGS_KEY,
  isValidTabId,
  isValidWindowId,
  parseLovableProjectUrl,
  sanitizeBindingsMap,
  sanitizeLocalSnapshot,
  tabMatchesBinding,
  validateRequest,
  validateTrustedSender,
} from "./privacy-policy.js";
import { submitNativePrompt } from "./native-prompt.js";

const TRUSTED_CONTEXTS = "TRUSTED_CONTEXTS";

function makeError(error) {
  return { ok: false, error };
}

export function createPrivacyBackend(chromeApi, nativePrompt = submitNativePrompt) {
  if (!chromeApi?.runtime?.id) throw new Error("Chrome extension APIs are unavailable.");

  const pendingBindings = new Map();
  const sendsInFlight = new Map();
  let bindingMutation = Promise.resolve();
  let privacyMutation = Promise.resolve();
  let forgetPromise = null;

  const requireStorageAreas = () => {
    if (!chromeApi.storage?.local || !chromeApi.storage?.session || !chromeApi.storage?.sync) {
      throw new Error("Required privacy storage APIs are unavailable.");
    }
  };

  async function enforceStorageAccess() {
    requireStorageAreas();
    if (
      typeof chromeApi.storage.local.setAccessLevel !== "function" ||
      typeof chromeApi.storage.session.setAccessLevel !== "function"
    ) {
      throw new Error("Trusted-context storage isolation is unavailable.");
    }
    await Promise.all([
      chromeApi.storage.local.setAccessLevel({ accessLevel: TRUSTED_CONTEXTS }),
      chromeApi.storage.session.setAccessLevel({ accessLevel: TRUSTED_CONTEXTS }),
    ]);
  }

  async function migratePrivacyStorage() {
    await enforceStorageAccess();
    const [localSnapshot, sessionSnapshot] = await Promise.all([
      chromeApi.storage.local.get(null),
      chromeApi.storage.session.get(null),
    ]);
    const sanitizedLocal = sanitizeLocalSnapshot(localSnapshot);
    const sanitizedBindings = sanitizeBindingsMap(sessionSnapshot?.[SESSION_BINDINGS_KEY]);

    await Promise.all([
      chromeApi.storage.local.clear(),
      chromeApi.storage.sync.clear(),
      chromeApi.storage.session.clear(),
    ]);
    await chromeApi.storage.local.set({
      [LOCAL_SETTINGS_KEY]: sanitizedLocal.privacySettings,
      [LOCAL_HISTORY_KEY]: sanitizedLocal.privacyHistory,
    });
    if (Object.keys(sanitizedBindings).length > 0) {
      await chromeApi.storage.session.set({ [SESSION_BINDINGS_KEY]: sanitizedBindings });
    }
  }

  const startup = migratePrivacyStorage();
  startup.catch(() => {});

  function queueBindingMutation(operation) {
    const next = bindingMutation.then(operation, operation);
    bindingMutation = next.catch(() => {});
    return next;
  }

  function queuePrivacyMutation(operation) {
    const next = privacyMutation.then(operation, operation);
    privacyMutation = next.catch(() => {});
    return next;
  }

  async function readBindings() {
    await startup;
    await bindingMutation;
    const snapshot = await chromeApi.storage.session.get(SESSION_BINDINGS_KEY);
    return sanitizeBindingsMap(snapshot?.[SESSION_BINDINGS_KEY]);
  }

  function writeBinding(windowId, binding) {
    return queueBindingMutation(async () => {
      await startup;
      const snapshot = await chromeApi.storage.session.get(SESSION_BINDINGS_KEY);
      const bindings = sanitizeBindingsMap(snapshot?.[SESSION_BINDINGS_KEY]);
      if (binding) bindings[String(windowId)] = binding;
      else delete bindings[String(windowId)];

      if (Object.keys(bindings).length > 0) {
        await chromeApi.storage.session.set({ [SESSION_BINDINGS_KEY]: bindings });
      } else {
        await chromeApi.storage.session.remove(SESSION_BINDINGS_KEY);
      }
    });
  }

  function clearBindingsAfterInstall() {
    return queueBindingMutation(async () => {
      await startup;
      pendingBindings.clear();
      await chromeApi.storage.session.clear();
    });
  }

  async function getValidatedBinding(windowId) {
    const pending = pendingBindings.get(windowId);
    if (pending) await pending.catch(() => {});

    const bindings = await readBindings();
    const binding = bindings[String(windowId)];
    if (!binding) return null;

    let tab;
    try {
      tab = await chromeApi.tabs.get(binding.tabId);
    } catch {
      await writeBinding(windowId, null);
      return null;
    }

    if (!tabMatchesBinding(tab, binding)) {
      await writeBinding(windowId, null);
      return null;
    }
    return binding;
  }

  async function bindFromToolbarTab(tab) {
    if (!tab || tab.incognito === true || !isValidWindowId(tab.windowId)) return null;

    const windowId = tab.windowId;
    if (!isValidTabId(tab.id)) {
      await writeBinding(windowId, null);
      return null;
    }

    const project = parseLovableProjectUrl(tab.url);
    if (!project) {
      await writeBinding(windowId, null);
      return null;
    }

    const binding = {
      windowId,
      tabId: tab.id,
      projectUrl: project.projectUrl,
      projectId: project.projectId,
    };
    await writeBinding(windowId, binding);
    return binding;
  }

  function openPanelForToolbarClick(tab) {
    if (!tab || tab.incognito === true || !isValidWindowId(tab.windowId) || !isValidTabId(tab.id)) return;
    if (forgetPromise) return;

    const windowId = tab.windowId;
    const pending = bindFromToolbarTab(tab);
    pendingBindings.set(windowId, pending);
    pending
      .finally(() => {
        if (pendingBindings.get(windowId) === pending) pendingBindings.delete(windowId);
      })
      .catch(() => {});

    const path = `sidepanel.html?windowId=${encodeURIComponent(String(windowId))}`;
    Promise.resolve(chromeApi.sidePanel.setOptions({ tabId: tab.id, path, enabled: true }))
      .then(() => chromeApi.sidePanel.open({ tabId: tab.id, windowId }))
      .catch(() => {});
  }

  async function getStatus(windowId, panelHasBindingContext) {
    await startup;
    if (!panelHasBindingContext) return { ok: true, connected: false };

    const binding = await getValidatedBinding(windowId);
    if (!binding) return { ok: true, connected: false };
    return {
      ok: true,
      connected: true,
      projectUrl: binding.projectUrl,
      projectId: binding.projectId,
      tabId: binding.tabId,
    };
  }

  async function setSettings(settingsPatch) {
    if (forgetPromise) return makeError("Privacy data is being cleared. Try again.");

    try {
      const settings = await queuePrivacyMutation(async () => {
        await startup;
        const snapshot = await chromeApi.storage.local.get([LOCAL_SETTINGS_KEY, LOCAL_HISTORY_KEY]);
        const current = sanitizeLocalSnapshot(snapshot);
        const next = sanitizeLocalSnapshot({
          [LOCAL_SETTINGS_KEY]: { ...current.privacySettings, ...settingsPatch },
          [LOCAL_HISTORY_KEY]: current.privacyHistory,
        });

        if (next.privacySettings.historyEnabled === false) {
          // One set removes the sensitive payload before the optional key cleanup.
          await chromeApi.storage.local.set({
            [LOCAL_SETTINGS_KEY]: next.privacySettings,
            [LOCAL_HISTORY_KEY]: [],
          });
          await chromeApi.storage.local.remove(LOCAL_HISTORY_KEY);
        } else {
          await chromeApi.storage.local.set({
            [LOCAL_SETTINGS_KEY]: next.privacySettings,
            [LOCAL_HISTORY_KEY]: next.privacyHistory,
          });
        }
        return next.privacySettings;
      });
      return { ok: true, settings };
    } catch {
      return makeError("Privacy settings could not be saved.");
    }
  }

  async function clearHistory() {
    if (forgetPromise) return makeError("Privacy data is being cleared. Try again.");
    try {
      await queuePrivacyMutation(async () => {
        await startup;
        await chromeApi.storage.local.remove(LOCAL_HISTORY_KEY);
      });
      return { ok: true };
    } catch {
      return makeError("Local history could not be cleared.");
    }
  }

  async function recordHistoryAfterSend(prompt) {
    if (forgetPromise) return { historySaved: false, historyEnabled: false };

    try {
      return await queuePrivacyMutation(async () => {
        await startup;
        if (forgetPromise) return { historySaved: false, historyEnabled: false };

        const snapshot = await chromeApi.storage.local.get([LOCAL_SETTINGS_KEY, LOCAL_HISTORY_KEY]);
        if (forgetPromise) return { historySaved: false, historyEnabled: false };

        const current = sanitizeLocalSnapshot(snapshot);
        if (!current.privacySettings.historyEnabled) {
          // History is intentionally off, so the privacy policy was satisfied
          // without writing the prompt and there is no persistence warning.
          return { historySaved: true, historyEnabled: false };
        }

        const privacyHistory = [
          ...current.privacyHistory,
          { prompt, timestamp: new Date().toISOString() },
        ].slice(-MAX_HISTORY_ITEMS);
        await chromeApi.storage.local.set({
          [LOCAL_SETTINGS_KEY]: current.privacySettings,
          [LOCAL_HISTORY_KEY]: privacyHistory,
        });
        return { historySaved: true, historyEnabled: true };
      });
    } catch {
      return { historySaved: false, historyEnabled: true };
    }
  }

  async function sendPrompt(windowId, prompt) {
    await startup;
    if (forgetPromise) return makeError("Privacy data is being cleared. Try again.");
    if (sendsInFlight.has(windowId)) return makeError("A prompt is already being sent in this window.");

    const operation = (async () => {
      const binding = await getValidatedBinding(windowId);
      if (!binding) return makeError("No Lovable project is connected. Use the toolbar on the project tab.");

      // Validate immediately before injection; the injected function repeats the same
      // exact-URL check inside the page before editing and before clicking Send.
      let tab;
      try {
        tab = await chromeApi.tabs.get(binding.tabId);
      } catch {
        await writeBinding(windowId, null);
        return makeError("The Lovable project tab closed. Reconnect from the toolbar.");
      }
      if (!tabMatchesBinding(tab, binding)) {
        await writeBinding(windowId, null);
        return makeError("The Lovable project page changed. Reconnect from the toolbar.");
      }

      let injectionResults;
      try {
        injectionResults = await chromeApi.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] },
          world: "ISOLATED",
          func: nativePrompt,
          args: [binding.projectUrl, prompt],
        });
      } catch {
        return makeError("The prompt could not be sent safely. Reconnect and try again.");
      }

      if (!Array.isArray(injectionResults) || injectionResults.length !== 1) {
        return makeError("The target page returned an invalid result.");
      }
      const result = injectionResults[0]?.result;
      if (!result || result.ok !== true) {
        return makeError(
          typeof result?.error === "string" && result.error.length <= 240
            ? result.error
            : "Lovable did not confirm the native send.",
        );
      }
      const historyResult = await recordHistoryAfterSend(prompt);
      return { ok: true, ...historyResult };
    })();

    sendsInFlight.set(windowId, operation);
    try {
      return await operation;
    } finally {
      if (sendsInFlight.get(windowId) === operation) sendsInFlight.delete(windowId);
    }
  }

  async function forgetAll() {
    if (forgetPromise) return forgetPromise;
    forgetPromise = (async () => {
      await startup.catch(() => {});
      await Promise.allSettled([...pendingBindings.values(), ...sendsInFlight.values()]);
      await bindingMutation;
      await privacyMutation;
      await Promise.all([
        chromeApi.storage.local.clear(),
        chromeApi.storage.sync.clear(),
        chromeApi.storage.session.clear(),
      ]);
      pendingBindings.clear();
      return { ok: true };
    })();
    try {
      return await forgetPromise;
    } finally {
      forgetPromise = null;
    }
  }

  async function handleMessage(message, sender) {
    const validated = validateRequest(message);
    if (!validated.ok) return makeError(validated.error);
    const request = validated.request;
    const trusted = validateTrustedSender(
      sender,
      request,
      chromeApi.runtime.id,
      chromeApi.extension?.inIncognitoContext === true,
    );
    if (!trusted.ok) return makeError(trusted.error);

    if (request.action === "getStatus") {
      try {
        return await getStatus(request.windowId, trusted.boundPanel);
      } catch {
        return makeError("The privacy backend is unavailable.");
      }
    }
    if (request.action === "sendPrompt") {
      if (!trusted.boundPanel) return makeError("Open the extension from the toolbar on a Lovable project.");
      return sendPrompt(request.windowId, request.prompt);
    }
    if (request.action === "setSettings") {
      return setSettings(request.settings);
    }
    if (request.action === "clearHistory") {
      return clearHistory();
    }
    if (request.action === "forget") {
      try {
        return await forgetAll();
      } catch {
        return makeError("Privacy data could not be cleared.");
      }
    }
    return makeError("Unknown action.");
  }

  function register() {
    chromeApi.action.onClicked.addListener(openPanelForToolbarClick);
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleMessage(message, sender).then(sendResponse, () => sendResponse(makeError("Request failed.")));
      return true;
    });
    // Never inherit a binding across an install/update boundary. A fresh toolbar
    // click is required to grant activeTab and create a new session binding.
    chromeApi.runtime.onInstalled.addListener(() => {
      clearBindingsAfterInstall().catch(() => {});
    });
    chromeApi.runtime.onStartup.addListener(() => {
      enforceStorageAccess().catch(() => {});
    });
  }

  return {
    bindFromToolbarTab,
    clearHistory,
    clearBindingsAfterInstall,
    enforceStorageAccess,
    forgetAll,
    getStatus,
    handleMessage,
    migratePrivacyStorage,
    openPanelForToolbarClick,
    recordHistoryAfterSend,
    register,
    sendPrompt,
    setSettings,
    startup,
  };
}

if (globalThis.chrome?.runtime?.id) {
  createPrivacyBackend(globalThis.chrome).register();
}
