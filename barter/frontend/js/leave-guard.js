const drafts = new Map();
const editorSelector = [
  "#ship-root input", "#ship-root select", "#parley-root input", "#tier-rules-root input",
  "#tuning-root input", "#navigation-root textarea", "#map-root textarea", "#viewer-root input",
].join(",");
const value = input => input.type === "checkbox" ? input.checked : input.value;

export function markDraftSaved(root) {
  for (const input of drafts.keys()) if (root?.contains(input)) drafts.set(input, value(input));
}

export function initLeaveGuard(hasPendingWork) {
  document.addEventListener("focusin", ({ target }) => {
    if (target.closest("dialog") && target.matches(editorSelector) && !drafts.has(target)) {
      drafts.set(target, value(target));
    }
  });
  window.addEventListener("beforeunload", event => {
    for (const input of drafts.keys()) if (!input.isConnected) drafts.delete(input);
    const unsavedEditor = [...drafts].some(([input, initial]) => value(input) !== initial);
    // Applied JSON is cleared; viewing a slot/map selector is never an unsaved edit.
    const unappliedJson = Boolean(document.querySelector("#trade-json-input")?.value.trim());
    if (hasPendingWork() || unsavedEditor || unappliedJson) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
