import { confirmAction } from "/portal-assets/feedback.js";
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
  let approvedNavigation = false;
  document.addEventListener("focusin", ({ target }) => {
    if (target.closest("dialog") && target.matches(editorSelector) && !drafts.has(target)) {
      drafts.set(target, value(target));
    }
  });
  const hasUnsaved = () => {
    for (const input of drafts.keys()) if (!input.isConnected) drafts.delete(input);
    const unsavedEditor = [...drafts].some(([input, initial]) => value(input) !== initial);
    // Applied JSON is cleared; viewing a slot/map selector is never an unsaved edit.
    const unappliedJson = Boolean(document.querySelector("#trade-json-input")?.value.trim());
    return hasPendingWork() || unsavedEditor || unappliedJson;
  };
  document.addEventListener("click", async event => {
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || link.target === "_blank" || link.hasAttribute("download") || link.getAttribute("href").startsWith("#") || !hasUnsaved()) return;
    event.preventDefault();
    if (!await confirmAction("적용하지 않은 입력이나 저장 중인 작업이 있습니다. 현재 페이지를 나갈까요?", {title:"페이지 이동", acceptLabel:"이동"})) return;
    approvedNavigation = true;
    location.assign(link.href);
    setTimeout(() => { approvedNavigation = false; }, 1000);
  });
  window.addEventListener("beforeunload", event => {
    if (!approvedNavigation && hasUnsaved()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
