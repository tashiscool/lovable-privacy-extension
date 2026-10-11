# Contributing

This fork uses vanilla JavaScript and Manifest V3 in Chromium. It has no build step or backend.

Run `npm run check` and `npm test` with Node.js 22 or newer. No dependency installation is required. UI changes also need the synthetic Playwright smoke test documented in README.md and inspection at narrow and desktop sizes.

Preserve the privacy boundary: no credential collection, telemetry, third-party uploads, remote scripts, broad browser permissions, or billing manipulation. Render user text with safe DOM APIs. Test malformed messages, untrusted senders, changed projects, disabled native controls, and opt-in history cleanup.

Retain MIT attribution. Include validation and feature tradeoffs in pull requests. Never put real account data in fixtures or logs.
