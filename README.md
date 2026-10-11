# Lovable Companion — Privacy Edition

A privacy-focused fork of [Maxx's Lovable](https://github.com/maxieyy/unlimited-lovable-extension). It keeps a local prompt composer, prompt shortcuts, theme selection, and optional local history. Prompts are delivered through Lovable's normal chat interface in the project you select.

## What changed

- Removed the author's license server, analytics, device identifiers, third-party file uploads, prompt optimization service, and credential proxy.
- Removed token and cookie collection, persistent credential storage, page-world network interception, and WebSocket injection.
- Removed request rewriting that disguised ordinary prompts as error repairs. Normal Lovable credits and account rules apply.
- Removed remote source-download, publishing, Cloud, voice, and other controls that depended on unverified services. Use Lovable's own interface for those actions and attachments.
- Removed automatic page injection and broad host access. Temporary access is granted when you click the toolbar button on a Lovable project.
- Restricted extension pages to local resources and blocked their network connections with Content Security Policy.
- History is off by default. Enabling it stores at most 20 sent prompts locally. Turning it off deletes saved history. Forget local data clears extension storage and disconnects the selected project.
- Updating an existing installation purges legacy tokens, license keys, device IDs, and other obsolete extension storage. This cannot revoke previously exposed tokens or erase prior uploads to another server.

Read [PRIVACY.md](PRIVACY.md) for data flow and limits.

## Install

1. Download this repository's ZIP from GitHub and extract it, or clone it:
   ```sh
   git clone https://github.com/tashiscool/lovable-privacy-extension.git
   ```
2. If the original extension is installed, disable or remove it first. Its separate installation can still collect data.
3. In Chrome, open `chrome://extensions`, enable Developer mode, and select **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Open a project at `https://lovable.dev/projects/...` and click this extension's toolbar button. Compose a prompt and select **Send to Lovable**.

There is no build step, backend, activation key, or package installation. Chrome 116 or newer is required. Other Chromium browsers must implement the Side Panel API; they have not been validated here. Incognito use is disabled.

If the project tab changes or navigates to another project, click the toolbar button again to select it. Existing drafts and disabled Lovable controls are respected. Lovable can change its editor DOM, in which case sending stops until the adapter is updated.

## Development and verification

Node.js 22 or newer is needed only to run tests:

```sh
npm run check
npm test
```

Tests use Node's built-in test runner; there are no npm dependencies. Browser smoke tests use a separately installed Playwright package and synthetic fixtures, never a real Lovable account:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser-smoke.mjs
```

Runtime code lives in `background.js`, `privacy-policy.js`, `native-prompt.js`, and `sidepanel.js`. The extension has no persistent content script, external message handler, generic fetch proxy, or page-visible credential bridge.

## Attribution and license

Derived from Maxx's Lovable — Open Source Edition by maxieyy and its contributors. Original attribution and the [MIT license](LICENSE) are retained. This fork is independently maintained and is not an official Lovable product.
