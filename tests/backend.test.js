import assert from "node:assert/strict";
import test from "node:test";

import { createPrivacyBackend } from "../background.js";
import { submitNativePrompt } from "../native-prompt.js";
import {
  MAX_PROMPT_LENGTH,
  SESSION_BINDINGS_KEY,
  parseLovableProjectUrl,
  validateRequest,
  validateTrustedSender,
} from "../privacy-policy.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_URL = `https://lovable.dev/projects/${PROJECT_ID}`;
const RUNTIME_ID = "synthetic-extension";

function makeEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

function makeStorageArea(initial = {}) {
  let values = structuredClone(initial);
  const accessLevels = [];
  return {
    async clear() {
      values = {};
    },
    async get(keys) {
      if (keys == null) return structuredClone(values);
      if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(values[key])]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          structuredClone(Object.hasOwn(values, key) ? values[key] : fallback),
        ]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async set(patch) {
      Object.assign(values, structuredClone(patch));
    },
    async setAccessLevel(options) {
      accessLevels.push(structuredClone(options));
    },
    snapshot() {
      return structuredClone(values);
    },
    accessLevels,
  };
}

function makeChrome({ local = {}, session = {}, sync = {}, executeScript } = {}) {
  const tabs = new Map();
  const localArea = makeStorageArea(local);
  const sessionArea = makeStorageArea(session);
  const syncArea = makeStorageArea(sync);
  const calls = { sidePanel: [], executeScript: [] };
  const chromeApi = {
    action: { onClicked: makeEvent() },
    extension: { inIncognitoContext: false },
    runtime: {
      id: RUNTIME_ID,
      onInstalled: makeEvent(),
      onMessage: makeEvent(),
      onStartup: makeEvent(),
    },
    scripting: {
      async executeScript(options) {
        calls.executeScript.push(options);
        if (executeScript) return executeScript(options);
        return [{ frameId: 0, result: { ok: true } }];
      },
    },
    sidePanel: {
      async open(options) {
        calls.sidePanel.push(["open", options]);
      },
      async setOptions(options) {
        calls.sidePanel.push(["setOptions", options]);
      },
    },
    storage: { local: localArea, session: sessionArea, sync: syncArea },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error("No tab");
        return structuredClone(tabs.get(tabId));
      },
    },
  };
  return { chromeApi, calls, localArea, sessionArea, syncArea, tabs };
}

function trustedSender(windowId = 7) {
  return {
    id: RUNTIME_ID,
    origin: `chrome-extension://${RUNTIME_ID}`,
    url: `chrome-extension://${RUNTIME_ID}/sidepanel.html?windowId=${windowId}`,
  };
}

test("project URLs are exact Lovable project URLs", () => {
  assert.deepEqual(parseLovableProjectUrl(PROJECT_URL), {
    projectUrl: PROJECT_URL,
    projectId: PROJECT_ID,
  });
  assert.equal(parseLovableProjectUrl(`http://lovable.dev/projects/${PROJECT_ID}`), null);
  assert.equal(parseLovableProjectUrl(`https://evil.lovable.dev/projects/${PROJECT_ID}`), null);
  assert.equal(parseLovableProjectUrl(`https://lovable.dev/projects/${PROJECT_ID}/settings`), null);
  assert.equal(parseLovableProjectUrl(`${PROJECT_URL}?token=synthetic-secret`), null);
  assert.equal(parseLovableProjectUrl(`${PROJECT_URL}#preview`), null);
  assert.equal(parseLovableProjectUrl("https://lovable.dev/projects/not-a-uuid"), null);
});

test("message and sender validation reject confused-deputy inputs", () => {
  assert.equal(validateRequest({ action: "sendPrompt", windowId: 7, prompt: " " }).ok, false);
  assert.equal(
    validateRequest({ action: "sendPrompt", windowId: 7, prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) }).ok,
    false,
  );
  assert.equal(validateRequest({ action: "getStatus", windowId: 7, extra: true }).ok, false);
  assert.deepEqual(validateRequest({ action: "forget" }), {
    ok: true,
    request: { action: "forget" },
  });
  assert.deepEqual(validateRequest({ action: "clearHistory" }), {
    ok: true,
    request: { action: "clearHistory" },
  });
  assert.deepEqual(validateRequest({ action: "setSettings", settings: { theme: "light" } }), {
    ok: true,
    request: { action: "setSettings", settings: { theme: "light" } },
  });
  assert.deepEqual(
    validateRequest({ action: "setSettings", settings: { historyEnabled: false } }),
    {
      ok: true,
      request: { action: "setSettings", settings: { historyEnabled: false } },
    },
  );
  assert.equal(
    validateRequest({ action: "setSettings", settings: { theme: "light", historyEnabled: true } }).ok,
    false,
  );
  assert.equal(validateRequest({ action: "setSettings", settings: { theme: "system" } }).ok, false);
  assert.equal(validateRequest({ action: "forget", windowId: 7 }).ok, false);
  assert.equal(validateRequest({ action: "unknown", windowId: 7 }).ok, false);

  const request = validateRequest({ action: "getStatus", windowId: 7 }).request;
  assert.deepEqual(validateTrustedSender(trustedSender(), request, RUNTIME_ID), {
    ok: true,
    boundPanel: true,
  });
  assert.equal(validateTrustedSender({ ...trustedSender(), tab: { id: 1 } }, request, RUNTIME_ID).ok, false);
  assert.equal(
    validateTrustedSender({ ...trustedSender(), origin: "https://lovable.dev" }, request, RUNTIME_ID).ok,
    false,
  );
  assert.equal(
    validateTrustedSender(
      { ...trustedSender(), url: `chrome-extension://${RUNTIME_ID}/sidepanel.html` },
      request,
      RUNTIME_ID,
    ).boundPanel,
    false,
  );
  const forgetRequest = validateRequest({ action: "forget" }).request;
  assert.equal(validateTrustedSender(trustedSender(), forgetRequest, RUNTIME_ID).ok, true);
  assert.equal(
    validateTrustedSender(
      { ...trustedSender(), url: `chrome-extension://${RUNTIME_ID}/sidepanel.html` },
      forgetRequest,
      RUNTIME_ID,
    ).ok,
    true,
  );
});

test("startup migration preserves only sanitized opt-in privacy data and valid bindings", async () => {
  const binding = { windowId: 7, tabId: 12, projectUrl: PROJECT_URL, projectId: PROJECT_ID };
  const { chromeApi, localArea, sessionArea, syncArea } = makeChrome({
    local: {
      privacySettings: { historyEnabled: true, theme: "light", token: "synthetic-secret" },
      privacyHistory: [
        { prompt: "Keep me", timestamp: new Date(0).toISOString() },
        { prompt: "Drop me", timestamp: new Date(0).toISOString(), token: "synthetic-secret" },
      ],
      lovable_token: "synthetic-secret",
      analytics_id: "synthetic-id",
    },
    session: { [SESSION_BINDINGS_KEY]: { 7: binding }, legacySessionToken: "synthetic-secret" },
    sync: { legacyCredential: "synthetic-secret" },
  });

  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;

  assert.deepEqual(localArea.snapshot(), {
    privacySettings: { historyEnabled: true, theme: "light" },
    privacyHistory: [{ prompt: "Keep me", timestamp: new Date(0).toISOString() }],
  });
  assert.deepEqual(sessionArea.snapshot(), { [SESSION_BINDINGS_KEY]: { 7: binding } });
  assert.deepEqual(syncArea.snapshot(), {});
  assert.deepEqual(localArea.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  assert.deepEqual(sessionArea.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("toolbar binding is frozen to one tab, window, URL, and project", async () => {
  const { chromeApi, calls, tabs } = makeChrome();
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });

  backend.openPanelForToolbarClick(tabs.get(12));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await backend.getStatus(7, true), {
    ok: true,
    connected: true,
    projectUrl: PROJECT_URL,
    projectId: PROJECT_ID,
    tabId: 12,
  });
  assert.deepEqual(calls.sidePanel, [
    ["setOptions", { tabId: 12, path: "sidepanel.html?windowId=7", enabled: true }],
    ["open", { tabId: 12, windowId: 7 }],
  ]);

  tabs.set(12, { id: 12, windowId: 7, url: `${PROJECT_URL}/settings`, incognito: false });
  assert.deepEqual(await backend.getStatus(7, true), { ok: true, connected: false });
});

test("sendPrompt uses one top-frame isolated injection and rejects concurrent sends", async () => {
  let releaseInjection;
  let injectionStarted;
  const started = new Promise((resolve) => {
    injectionStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseInjection = resolve;
  });
  const { chromeApi, calls, tabs } = makeChrome({
    executeScript: async () => {
      injectionStarted();
      await blocked;
      return [{ frameId: 0, result: { ok: true } }];
    },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });
  await backend.bindFromToolbarTab(tabs.get(12));

  const first = backend.handleMessage(
    { action: "sendPrompt", windowId: 7, prompt: "Synthetic prompt" },
    trustedSender(),
  );
  await started;
  const duplicate = await backend.handleMessage(
    { action: "sendPrompt", windowId: 7, prompt: "Duplicate" },
    trustedSender(),
  );
  assert.deepEqual(duplicate, { ok: false, error: "A prompt is already being sent in this window." });

  releaseInjection();
  assert.deepEqual(await first, { ok: true, historySaved: true, historyEnabled: false });
  assert.equal(calls.executeScript.length, 1);
  assert.deepEqual(calls.executeScript[0].target, { tabId: 12, frameIds: [0] });
  assert.equal(calls.executeScript[0].world, "ISOLATED");
  assert.equal(calls.executeScript[0].func, submitNativePrompt);
  assert.deepEqual(calls.executeScript[0].args, [PROJECT_URL, "Synthetic prompt"]);
});

test("worker serializes reviewed settings and history mutations", async () => {
  const firstTimestamp = new Date(0).toISOString();
  const { chromeApi, localArea } = makeChrome({
    local: {
      privacySettings: { historyEnabled: true, theme: "dark" },
      privacyHistory: [{ prompt: "Existing", timestamp: firstTimestamp }],
    },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;

  const sender = { ...trustedSender(), url: `chrome-extension://${RUNTIME_ID}/sidepanel.html` };
  assert.deepEqual(
    await backend.handleMessage({ action: "setSettings", settings: { theme: "light" } }, sender),
    { ok: true, settings: { historyEnabled: true, theme: "light" } },
  );
  assert.deepEqual(localArea.snapshot(), {
    privacySettings: { historyEnabled: true, theme: "light" },
    privacyHistory: [{ prompt: "Existing", timestamp: firstTimestamp }],
  });

  assert.deepEqual(
    await backend.handleMessage(
      { action: "setSettings", settings: { historyEnabled: false } },
      sender,
    ),
    { ok: true, settings: { historyEnabled: false, theme: "light" } },
  );
  assert.deepEqual(localArea.snapshot(), {
    privacySettings: { historyEnabled: false, theme: "light" },
  });

  assert.deepEqual(await backend.handleMessage({ action: "clearHistory" }, sender), { ok: true });
  assert.deepEqual(localArea.snapshot(), {
    privacySettings: { historyEnabled: false, theme: "light" },
  });
});

test("confirmed native send records bounded history only when opted in", async () => {
  const { chromeApi, localArea, tabs } = makeChrome({
    local: { privacySettings: { historyEnabled: true, theme: "dark" }, privacyHistory: [] },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });
  await backend.bindFromToolbarTab(tabs.get(12));

  const result = await backend.handleMessage(
    { action: "sendPrompt", windowId: 7, prompt: "Store only after native success" },
    trustedSender(),
  );
  assert.deepEqual(result, { ok: true, historySaved: true, historyEnabled: true });
  const snapshot = localArea.snapshot();
  assert.equal(snapshot.privacyHistory.length, 1);
  assert.equal(snapshot.privacyHistory[0].prompt, "Store only after native success");
  assert.equal(new Date(snapshot.privacyHistory[0].timestamp).toISOString(), snapshot.privacyHistory[0].timestamp);
});

test("Forget is a barrier against delayed sends and new privacy mutations", async () => {
  let releaseInjection;
  let injectionStarted;
  const started = new Promise((resolve) => {
    injectionStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseInjection = resolve;
  });
  const { chromeApi, localArea, sessionArea, syncArea, tabs } = makeChrome({
    local: { privacySettings: { historyEnabled: true, theme: "dark" }, privacyHistory: [] },
    executeScript: async () => {
      injectionStarted();
      await blocked;
      return [{ frameId: 0, result: { ok: true } }];
    },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });
  await backend.bindFromToolbarTab(tabs.get(12));

  const sending = backend.handleMessage(
    { action: "sendPrompt", windowId: 7, prompt: "Must not return after Forget" },
    trustedSender(),
  );
  await started;

  const unboundSender = {
    ...trustedSender(),
    url: `chrome-extension://${RUNTIME_ID}/sidepanel.html`,
  };
  const forgetting = backend.handleMessage({ action: "forget" }, unboundSender);
  assert.deepEqual(
    await backend.handleMessage(
      { action: "setSettings", settings: { theme: "light" } },
      unboundSender,
    ),
    { ok: false, error: "Privacy data is being cleared. Try again." },
  );

  releaseInjection();
  assert.deepEqual(await sending, { ok: true, historySaved: false, historyEnabled: false });
  assert.deepEqual(await forgetting, { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(localArea.snapshot(), {});
  assert.deepEqual(sessionArea.snapshot(), {});
  assert.deepEqual(syncArea.snapshot(), {});
});

test("history storage failure never converts a confirmed native send into send failure", async () => {
  const { chromeApi, localArea, tabs } = makeChrome({
    local: { privacySettings: { historyEnabled: true, theme: "dark" }, privacyHistory: [] },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });
  await backend.bindFromToolbarTab(tabs.get(12));

  const normalSet = localArea.set.bind(localArea);
  localArea.set = async (patch) => {
    if (Array.isArray(patch.privacyHistory) && patch.privacyHistory.length > 0) {
      throw new Error("Synthetic quota failure");
    }
    return normalSet(patch);
  };

  assert.deepEqual(
    await backend.handleMessage(
      { action: "sendPrompt", windowId: 7, prompt: "Native send still succeeds" },
      trustedSender(),
    ),
    { ok: true, historySaved: false, historyEnabled: true },
  );
});

test("forget clears local, sync, session, and bindings", async () => {
  const { chromeApi, localArea, sessionArea, syncArea, tabs } = makeChrome({
    local: { privacySettings: { historyEnabled: true, theme: "light" } },
    sync: { legacy: true },
  });
  const backend = createPrivacyBackend(chromeApi);
  await backend.startup;
  tabs.set(12, { id: 12, windowId: 7, url: PROJECT_URL, incognito: false });
  await backend.bindFromToolbarTab(tabs.get(12));

  const unboundSender = {
    ...trustedSender(),
    url: `chrome-extension://${RUNTIME_ID}/sidepanel.html`,
  };
  assert.deepEqual(await backend.handleMessage({ action: "forget" }, unboundSender), {
    ok: true,
  });
  assert.deepEqual(localArea.snapshot(), {});
  assert.deepEqual(sessionArea.snapshot(), {});
  assert.deepEqual(syncArea.snapshot(), {});
});

test("native submitter fails closed when the page URL does not match", async () => {
  const previousWindow = globalThis.window;
  const syntheticWindow = { location: { href: PROJECT_URL }, top: null };
  syntheticWindow.top = syntheticWindow;
  globalThis.window = syntheticWindow;
  try {
    const result = await submitNativePrompt(
      `https://lovable.dev/projects/22222222-2222-4222-8222-222222222222`,
      "Synthetic prompt",
    );
    assert.deepEqual(result, {
      ok: false,
      error: "The Lovable project page changed. Reconnect from the toolbar.",
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
