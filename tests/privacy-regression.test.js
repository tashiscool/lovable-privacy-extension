import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrivacyBackend } from '../background.js';
import {
  LOCAL_HISTORY_KEY,
  LOCAL_SETTINGS_KEY,
  MAX_HISTORY_ITEMS,
  MAX_PROMPT_LENGTH,
  parseLovableProjectUrl,
  sanitizeLocalSnapshot,
  sanitizePrivacySettings,
  validateRequest,
  validateTrustedSender,
} from '../privacy-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SYNTHETIC_PROJECT_ID = '12345678-1234-1234-1234-123456789abc';
const SYNTHETIC_PROJECT_URL = `https://lovable.dev/projects/${SYNTHETIC_PROJECT_ID}`;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function productionFiles(extensions) {
  const excludedDirectories = new Set([
    '.git',
    '.github',
    'docs',
    'fixtures',
    'node_modules',
    'test',
    'tests',
  ]);
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(ROOT, absolutePath));
      }
    }
  }

  visit(ROOT);
  return files.sort();
}

function matchingRules(relativePaths, rules) {
  const violations = [];

  for (const relativePath of relativePaths) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    for (const [label, pattern] of rules) {
      if (pattern.test(source)) violations.push(`${relativePath}: ${label}`);
    }
  }

  return violations;
}

function makeStorageArea(initial = {}) {
  let values = structuredClone(initial);

  return {
    async clear() {
      values = {};
    },
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(values);
      if (typeof keys === 'string') return { [keys]: structuredClone(values[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(values[key])]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          structuredClone(values[key] === undefined ? fallback : values[key]),
        ]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async set(next) {
      values = { ...values, ...structuredClone(next) };
    },
    async setAccessLevel() {},
    snapshot() {
      return structuredClone(values);
    },
  };
}

function makeBackendFixture({ local = {}, nativePrompt }) {
  const localArea = makeStorageArea(local);
  const sessionArea = makeStorageArea();
  const syncArea = makeStorageArea({ legacyCredential: 'synthetic' });
  const tabs = new Map();
  const chromeApi = {
    extension: { inIncognitoContext: false },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
    storage: { local: localArea, session: sessionArea, sync: syncArea },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('Missing synthetic tab');
        return structuredClone(tab);
      },
    },
    scripting: {
      async executeScript({ func, args }) {
        return [{ frameId: 0, result: await func(...args) }];
      },
    },
  };
  const backend = createPrivacyBackend(chromeApi, nativePrompt);

  return { backend, localArea, sessionArea, syncArea, tabs };
}

function delayedNativeSuccess() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  return {
    async nativePrompt() {
      markStarted();
      await blocked;
      return { ok: true };
    },
    release,
    started,
  };
}

test('manifest grants only the four privacy-reviewed permissions', () => {
  const manifest = readJson('manifest.json');

  assert.deepEqual(
    [...(manifest.permissions ?? [])].sort(),
    ['activeTab', 'scripting', 'sidePanel', 'storage'].sort(),
  );

  for (const field of [
    'content_scripts',
    'externally_connectable',
    'host_permissions',
    'oauth2',
    'optional_host_permissions',
    'optional_permissions',
    'update_url',
    'web_accessible_resources',
  ]) {
    assert.equal(
      Object.hasOwn(manifest, field),
      false,
      `manifest must not declare ${field}`,
    );
  }
});

test('only the privacy-reviewed executable entry points ship', () => {
  const shippedExecutables = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:html|js)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(shippedExecutables, [
    'background.js',
    'native-prompt.js',
    'privacy-policy.js',
    'sidepanel.html',
    'sidepanel.js',
  ]);

  for (const legacyPath of [
    'content-bridge.js',
    'content-templates.js',
    'content.js',
    'extension-config.js',
    'floating.css',
    'jszip.min.js',
    'license-gate.js',
    'lovable-auth.js',
    'lovable-feature-api.js',
    'pageHook.js',
    'sidepanel-templates.js',
    'sounds',
    'sounds.js',
    'user-messages.js',
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, legacyPath)),
      false,
      `legacy source must not ship: ${legacyPath}`,
    );
  }
});

test('background worker is an ES module and extension pages cannot connect out', () => {
  const manifest = readJson('manifest.json');

  assert.deepEqual(manifest.background, {
    service_worker: 'background.js',
    type: 'module',
  });

  const extensionCsp = manifest.content_security_policy?.extension_pages;
  assert.equal(typeof extensionCsp, 'string', 'extension_pages CSP is required');

  const directives = new Map(
    extensionCsp
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/);
        return [name.toLowerCase(), values];
      }),
  );

  assert.deepEqual(directives.get('connect-src'), ["'none'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
});

test('every manifest entry point and icon is a local file that exists', () => {
  const manifest = readJson('manifest.json');
  const referencedFiles = new Set([
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    manifest.devtools_page,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
  ]);

  referencedFiles.delete(undefined);

  for (const relativePath of referencedFiles) {
    assert.equal(typeof relativePath, 'string');
    assert.equal(path.isAbsolute(relativePath), false, `${relativePath} must be local`);
    assert.equal(
      relativePath.split(/[\\/]/).includes('..'),
      false,
      `${relativePath} must stay inside the extension`,
    );
    assert.equal(
      fs.statSync(path.join(ROOT, relativePath)).isFile(),
      true,
      `missing manifest asset: ${relativePath}`,
    );
  }
});

test('shipped JavaScript and HTML contain no network, capture, or page-tampering primitives', () => {
  const executableFiles = productionFiles(new Set(['.html', '.js']));
  const violations = matchingRules(executableFiles, [
    ['fetch()', /\bfetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['sendBeacon()', /\bsendBeacon\s*\(/],
    ['importScripts()', /\bimportScripts\s*\(/],
    ['dynamic import()', /\bimport\s*\(/],
    ['cookie API', /\b(?:chrome|browser)\.cookies\b/],
    ['document.cookie', /\bdocument\.cookie\b/],
    ['Cookie Store API', /\bcookieStore\b/],
    ['localStorage access', /\b(?:window\.)?localStorage\s*\./],
    ['sessionStorage access', /\b(?:window\.)?sessionStorage\s*\./],
    ['Authorization header', /(?:["']Authorization["']|\bAuthorization)\s*:/i],
    ['MAIN execution world', /\bworld\s*:\s*["']MAIN["']/i],
    ['postMessage()', /\bpostMessage\s*\(/],
    ['external runtime messaging', /\bruntime\.(?:connect|onMessageExternal|sendMessageExternal)\b/],
    ['native messaging', /\b(?:connectNative|sendNativeMessage)\s*\(/],
    ['request interception API', /\b(?:declarativeNetRequest|webRequest)\b/],
    ['proxy API', /\b(?:chrome|browser)\.proxy\b/],
    ['fetch monkey patch', /\b(?:globalThis|window)\.fetch\s*=/],
    ['XHR monkey patch', /\bXMLHttpRequest\.prototype\b/],
    ['Response monkey patch', /\bResponse\.prototype\b/],
    ['synthetic network response', /\bnew\s+Response\s*\(/],
    [
      'credit/quota mutation',
      /(?:\.\s*(?:credits?|quota|rateLimit|rate_limit)|\b(?:credits?|quota|rateLimit|rate_limit))\s*(?:\+\+|--|[+*/-]?=)/i,
    ],
  ]);

  assert.deepEqual(violations, []);
});

test('production modules import only packaged relative JavaScript', () => {
  const javascriptFiles = productionFiles(new Set(['.js']));
  const violations = [];

  for (const relativePath of javascriptFiles) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const imports = source.matchAll(/^\s*import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["'];?/gm);

    for (const match of imports) {
      const specifier = match[1];
      const importedPath = path.resolve(path.dirname(path.join(ROOT, relativePath)), specifier);
      if (
        !specifier.startsWith('./') ||
        path.extname(specifier) !== '.js' ||
        !importedPath.startsWith(`${ROOT}${path.sep}`) ||
        !fs.existsSync(importedPath) ||
        !fs.statSync(importedPath).isFile()
      ) {
        violations.push(`${relativePath}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('production URL literals are limited to the exact trusted Lovable origin', () => {
  const executableFiles = productionFiles(new Set(['.html', '.js']));
  const violations = [];

  for (const relativePath of executableFiles) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const urls = source.match(/\b(?:https?|wss?):\/\/[^\s"'`<>()]+/gi) ?? [];

    for (const url of urls) {
      if (url !== 'https://lovable.dev') {
        violations.push(`${relativePath}: ${url}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('shipped stylesheets do not import or reference remote resources', () => {
  const styleFiles = productionFiles(new Set(['.css']));
  const violations = matchingRules(styleFiles, [
    ['remote URL', /\b(?:https?|wss?):\/\//i],
    ['protocol-relative URL', /url\(\s*["']?\/\//i],
    ['remote @import', /@import\s+(?:url\s*\()?\s*["']?(?:[a-z]+:|\/\/)/i],
  ]);

  assert.deepEqual(violations, []);
});

test('side panel loads only packaged scripts and contains no inline handlers', () => {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  for (const [, attributes, body] of scriptTags) {
    const sourceMatch = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    assert.ok(sourceMatch, 'inline scripts are not allowed');

    const scriptPath = sourceMatch[1];
    assert.doesNotMatch(scriptPath, /^(?:[a-z]+:|\/\/|\/)/i);
    assert.equal(
      fs.statSync(path.join(ROOT, scriptPath)).isFile(),
      true,
      `missing packaged script: ${scriptPath}`,
    );
    assert.equal(body.trim(), '', `script ${scriptPath} must not contain inline code`);
  }

  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handlers are not allowed');
});

test('privacy settings default to history off and discard unknown fields', () => {
  assert.equal(LOCAL_SETTINGS_KEY, 'privacySettings');
  assert.equal(LOCAL_HISTORY_KEY, 'privacyHistory');

  assert.deepEqual(sanitizePrivacySettings(undefined), {
    historyEnabled: false,
    theme: 'dark',
  });
  assert.deepEqual(
    sanitizePrivacySettings({
      historyEnabled: 'true',
      theme: 'system',
      accessToken: 'synthetic-secret',
      uploadEndpoint: 'synthetic-endpoint',
    }),
    {
      historyEnabled: false,
      theme: 'dark',
    },
  );
  assert.deepEqual(
    sanitizePrivacySettings({ historyEnabled: true, theme: 'light', extra: true }),
    {
      historyEnabled: true,
      theme: 'light',
    },
  );
});

test('history is opt-in, bounded, and reduced to prompt and canonical timestamp', () => {
  const validItems = Array.from({ length: MAX_HISTORY_ITEMS + 5 }, (_, index) => ({
    prompt: `Synthetic prompt ${index}`,
    timestamp: new Date(index * 1_000).toISOString(),
  }));

  assert.deepEqual(
    sanitizeLocalSnapshot({
      [LOCAL_SETTINGS_KEY]: { historyEnabled: false, theme: 'dark' },
      [LOCAL_HISTORY_KEY]: validItems,
    }),
    {
      privacySettings: { historyEnabled: false, theme: 'dark' },
      privacyHistory: [],
    },
  );

  const rejectedHistory = sanitizeLocalSnapshot({
    [LOCAL_SETTINGS_KEY]: { historyEnabled: true, theme: 'light' },
    [LOCAL_HISTORY_KEY]: [
      { prompt: 'Rejected extra field', timestamp: new Date(0).toISOString(), token: 'synthetic' },
      { prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1), timestamp: new Date(0).toISOString() },
      { prompt: 'Rejected date', timestamp: '2026-01-01' },
    ],
    unrelatedLegacyToken: 'synthetic',
  });
  assert.deepEqual(rejectedHistory.privacyHistory, []);

  const snapshot = sanitizeLocalSnapshot({
    [LOCAL_SETTINGS_KEY]: { historyEnabled: true, theme: 'light' },
    [LOCAL_HISTORY_KEY]: validItems,
    unrelatedLegacyToken: 'synthetic',
  });

  assert.deepEqual(Object.keys(snapshot).sort(), ['privacyHistory', 'privacySettings']);
  assert.equal(snapshot.privacySettings.historyEnabled, true);
  assert.equal(snapshot.privacyHistory.length, MAX_HISTORY_ITEMS);
  assert.equal(snapshot.privacyHistory[0].prompt, 'Synthetic prompt 5');
  assert.equal(snapshot.privacyHistory.at(-1).prompt, 'Synthetic prompt 24');
  for (const item of snapshot.privacyHistory) {
    assert.deepEqual(Object.keys(item).sort(), ['prompt', 'timestamp']);
  }
});

test('project URLs cannot smuggle credentials, query data, fragments, or alternate origins', () => {
  const projectId = '12345678-1234-1234-1234-123456789abc';
  const trustedUrl = `https://lovable.dev/projects/${projectId}`;

  assert.deepEqual(parseLovableProjectUrl(trustedUrl), {
    projectUrl: trustedUrl,
    projectId,
  });

  for (const untrustedUrl of [
    `http://lovable.dev/projects/${projectId}`,
    `https://api.lovable.dev/projects/${projectId}`,
    `https://lovable.dev.evil.example/projects/${projectId}`,
    `https://user:password@lovable.dev/projects/${projectId}`,
    `https://lovable.dev:444/projects/${projectId}`,
    `https://lovable.dev/projects/${projectId}/extra`,
    `https://lovable.dev/projects/${projectId}?access_token=synthetic`,
    `https://lovable.dev/projects/${projectId}#synthetic-token`,
  ]) {
    assert.equal(parseLovableProjectUrl(untrustedUrl), null, untrustedUrl);
  }
});

test('runtime requests accept only this extension side panel and its exact window binding', () => {
  const runtimeId = 'abcdefghijklmnopabcdefghijklmnop';
  const extensionOrigin = `chrome-extension://${runtimeId}`;
  const request = validateRequest({ action: 'getStatus', windowId: 17 }).request;
  const sender = {
    id: runtimeId,
    origin: extensionOrigin,
    url: `${extensionOrigin}/sidepanel.html?windowId=17`,
  };

  assert.deepEqual(validateTrustedSender(sender, request, runtimeId), {
    ok: true,
    boundPanel: true,
  });
  assert.deepEqual(
    validateTrustedSender(
      { ...sender, url: `${extensionOrigin}/sidepanel.html` },
      request,
      runtimeId,
    ),
    { ok: true, boundPanel: false },
  );

  for (const untrustedSender of [
    { ...sender, id: 'different-extension' },
    { ...sender, origin: 'https://lovable.dev' },
    { ...sender, url: `${extensionOrigin}/sidepanel.html?windowId=18` },
    { ...sender, url: `${extensionOrigin}/sidepanel.html?windowId=17&extra=true` },
    { ...sender, url: `${extensionOrigin}/other.html?windowId=17` },
    { ...sender, tab: { id: 1 } },
  ]) {
    assert.equal(validateTrustedSender(untrustedSender, request, runtimeId).ok, false);
  }
});

test('the side panel is read-only with respect to privacy storage', () => {
  const source = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

  assert.doesNotMatch(
    source,
    /\bchrome\.storage\.(?:local|session|sync)\.(?:set|remove|clear)\s*\(/,
  );
});

test('forget cannot race a delayed successful send into restoring prompt history', async () => {
  const delayed = delayedNativeSuccess();
  const fixture = makeBackendFixture({
    local: {
      [LOCAL_SETTINGS_KEY]: { historyEnabled: true, theme: 'dark' },
      [LOCAL_HISTORY_KEY]: [],
    },
    nativePrompt: delayed.nativePrompt,
  });
  const tab = {
    id: 12,
    windowId: 7,
    url: SYNTHETIC_PROJECT_URL,
    incognito: false,
  };

  fixture.tabs.set(tab.id, tab);
  await fixture.backend.startup;
  await fixture.backend.bindFromToolbarTab(tab);

  const sending = fixture.backend.sendPrompt(tab.windowId, 'Synthetic delayed prompt');
  await delayed.started;
  const forgetting = fixture.backend.forgetAll();
  delayed.release();

  const [sendResult, forgetResult] = await Promise.all([sending, forgetting]);
  assert.deepEqual(sendResult, {
    ok: true,
    historySaved: false,
    historyEnabled: false,
  });
  assert.deepEqual(forgetResult, { ok: true });
  assert.deepEqual(fixture.localArea.snapshot(), {});
  assert.deepEqual(fixture.sessionArea.snapshot(), {});
  assert.deepEqual(fixture.syncArea.snapshot(), {});
});

test('opting out during a delayed send prevents that prompt from being retained', async () => {
  const delayed = delayedNativeSuccess();
  const fixture = makeBackendFixture({
    local: {
      [LOCAL_SETTINGS_KEY]: { historyEnabled: true, theme: 'light' },
      [LOCAL_HISTORY_KEY]: [
        { prompt: 'Synthetic existing prompt', timestamp: new Date(0).toISOString() },
      ],
    },
    nativePrompt: delayed.nativePrompt,
  });
  const tab = {
    id: 12,
    windowId: 7,
    url: SYNTHETIC_PROJECT_URL,
    incognito: false,
  };

  fixture.tabs.set(tab.id, tab);
  await fixture.backend.startup;
  await fixture.backend.bindFromToolbarTab(tab);

  const sending = fixture.backend.sendPrompt(tab.windowId, 'Synthetic delayed prompt');
  await delayed.started;
  assert.deepEqual(await fixture.backend.setSettings({ historyEnabled: false }), {
    ok: true,
    settings: { historyEnabled: false, theme: 'light' },
  });
  delayed.release();

  assert.deepEqual(await sending, {
    ok: true,
    historySaved: true,
    historyEnabled: false,
  });
  assert.deepEqual(fixture.localArea.snapshot(), {
    [LOCAL_SETTINGS_KEY]: { historyEnabled: false, theme: 'light' },
  });
});
