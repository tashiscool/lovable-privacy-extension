/**
 * Runs inside the target tab's ISOLATED world. Keep this function self-contained:
 * chrome.scripting.executeScript serializes the function without module closures.
 */
export async function submitNativePrompt(expectedProjectUrl, prompt) {
  const fail = (error) => ({ ok: false, error });
  const parseProject = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(
        /^\/projects\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?$/,
      );
      if (
        url.origin !== "https://lovable.dev" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !match
      ) {
        return null;
      }
      return { href: url.href, projectId: match[1].toLowerCase() };
    } catch {
      return null;
    }
  };
  const pageStillMatches = () => {
    const expected = parseProject(expectedProjectUrl);
    const current = parseProject(window.location.href);
    return Boolean(
      expected &&
        current &&
        window.top === window &&
        window.location.href === expectedProjectUrl &&
        current.href === expected.href &&
        current.projectId === expected.projectId,
    );
  };
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const editorText = (editor) =>
    String(editor.innerText ?? editor.textContent ?? "")
      .replace(/\u200B/g, "")
      .replace(/\r\n/g, "\n");
  const hasExistingDraft = (form, editor) => {
    if (editorText(editor).trim().length > 0) return true;
    const fileInputs = [...form.querySelectorAll('input[type="file"]')];
    if (fileInputs.some((input) => input.files && input.files.length > 0)) return true;
    return Boolean(
      form.querySelector(
        '[data-attachment-id], [data-file-id], [data-testid="attachment-preview"], [data-testid="chat-attachment"]',
      ),
    );
  };
  const getEditor = (form) => {
    const editors = [...form.querySelectorAll('[contenteditable="true"]')].filter(visible);
    return editors.length === 1 ? editors[0] : null;
  };
  const getSendButton = (form) => {
    const buttons = [
      ...form.querySelectorAll(
        '#chatinput-send-message-button, button[type="submit"], button[aria-label="Send" i], button[aria-label^="Send " i]',
      ),
    ].filter(visible);
    return buttons.length === 1 ? buttons[0] : null;
  };
  const buttonDisabled = (button) =>
    !button ||
    button.disabled === true ||
    button.getAttribute("aria-disabled") === "true" ||
    button.getAttribute("data-disabled") === "true";

  try {
    if (typeof expectedProjectUrl !== "string" || typeof prompt !== "string" || !prompt.trim()) {
      return fail("Invalid prompt request.");
    }
    if (prompt.length > 20_000) return fail("Prompt is too long.");
    if (!pageStillMatches()) return fail("The Lovable project page changed. Reconnect from the toolbar.");

    const forms = [...document.querySelectorAll("form#chat-input")].filter(visible);
    if (forms.length !== 1) return fail("A unique Lovable chat form was not found.");
    const form = forms[0];
    const editor = getEditor(form);
    if (!editor) return fail("A unique editable Lovable prompt field was not found.");
    if (
      editor.isContentEditable !== true ||
      editor.getAttribute("aria-readonly") === "true" ||
      editor.getAttribute("aria-disabled") === "true"
    ) {
      return fail("The Lovable prompt field is not editable.");
    }
    if (hasExistingDraft(form, editor)) {
      return fail("Lovable already has a draft or attachment. Send or clear it before trying again.");
    }
    if (!getSendButton(form)) return fail("A unique Lovable Send button was not found.");

    editor.focus();
    if (!pageStillMatches()) return fail("The Lovable project page changed. Reconnect from the toolbar.");
    if (hasExistingDraft(form, editor)) {
      return fail("Lovable already has a draft or attachment. Send or clear it before trying again.");
    }

    if (typeof document.execCommand !== "function" || document.execCommand("insertText", false, prompt) !== true) {
      return fail("Lovable did not accept the prompt text.");
    }
    if (editorText(editor) !== prompt.replace(/\r\n/g, "\n")) {
      return fail("Lovable changed the prompt text before sending; it was not submitted.");
    }

    let sendButton = null;
    const deadline = Date.now() + 1_500;
    do {
      if (!pageStillMatches()) return fail("The Lovable project page changed; the prompt was not submitted.");
      sendButton = getSendButton(form);
      if (!sendButton) return fail("The Lovable Send button became ambiguous; the prompt was not submitted.");
      if (!buttonDisabled(sendButton)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);

    if (buttonDisabled(sendButton)) {
      return fail("Lovable kept the Send button disabled; the prompt was not submitted.");
    }
    if (!pageStillMatches() || editorText(editor) !== prompt.replace(/\r\n/g, "\n")) {
      return fail("The Lovable page or prompt changed; it was not submitted.");
    }

    sendButton.click();
    return { ok: true };
  } catch {
    return fail("Lovable could not accept the prompt safely.");
  }
}
