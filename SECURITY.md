# Security

Report vulnerabilities privately through GitHub's private reporting feature when available. Never include tokens, cookies, account data, or real prompts in public issues.

Maintained boundaries:

- Only this extension's side panel can invoke privileged messages.
- Unknown actions and malformed payloads are rejected.
- Toolbar-selected window/tab/project must match before sending; the isolated adapter checks the URL again.
- Existing drafts, disabled controls, ambiguous editors, and incognito contexts are rejected.
- Credentials are never acquired or persisted. Networking and page-world bridges are absent.
- Old extension data is purged. Opt-in history is bounded and rendered as text.

Changes must pass `npm run check` and `npm test`. Use synthetic browser fixtures for smoke tests. New network destinations, credential access, automatic injection, or request rewriting are outside this fork's privacy contract.
