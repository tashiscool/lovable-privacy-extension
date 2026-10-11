# Privacy behavior

## Data flow

The toolbar selects one Lovable project tab. The side panel sends a prompt to the extension service worker only after an explicit Send action. The worker validates the sender, message, selected tab, window, and unchanged project URL. A short-lived script in Chrome's isolated world inserts the prompt into Lovable's existing chat and clicks its normal enabled send control.

Lovable receives the prompt through its own application under its account, privacy, and billing rules. Scripts on that page can observe text entered into its editor, just as when you type directly. The extension makes no direct network requests and never impersonates free repair actions.

## Storage

- Theme and the history opt-in setting are stored in extension-local storage.
- With history enabled, up to 20 sent prompts and timestamps are saved locally. This is plain text in the browser profile, not encrypted by the extension. History is disabled by default and is never synced or uploaded.
- Selected tab/window and project URL are kept in session storage, which Chrome clears on extension reload or browser restart. A changed project or tab invalidates selection.
- Drafts are not persisted. Passwords, access tokens, cookies, license keys, device fingerprints, attachments, and account profiles are never collected.

Local and session storage are restricted to trusted extension contexts. Turning history off deletes it. **Forget local data** clears local/session/sync extension storage, disconnects the project, and clears the panel draft.

## Permissions and network

Only `activeTab`, `scripting`, `sidePanel`, and `storage` are requested. There are no permanent host permissions, cookie access, broad tab access, alarms, web-accessible resources, or external connections. No page hook or fetch, XMLHttpRequest, or WebSocket modification is installed.

Extension-page Content Security Policy blocks network connections, frames, remote scripts/fonts, and form submissions. Prompt delivery is confined to the exact selected HTTPS Lovable project. No requests go to the original author's backend or `lovable-api.com`.

## Prior installations and exposure

Initialization purges obsolete storage and validates retained settings/history. A separate unpacked directory receives a different Chrome extension ID, so this fork cannot delete data belonging to a separate installation of the original extension. Disable/remove that installation independently.

Code changes cannot erase attachments or analytics already sent elsewhere. If you previously used credential-sharing features, revoke affected sessions through Lovable's account controls. Browser backups and profile access remain subject to the browser and operating system.

## Verification limits

Tests exercise trust boundaries, permissions, storage cleanup, UI behavior, and native-editor delivery with synthetic fixtures. They do not authenticate to a real Lovable account, perform paid actions, or verify future Lovable editor changes. Sending fails when the expected editor or enabled send control cannot be identified.
