(() => {
  let host;
  const labels = { info: "안내", success: "완료", warning: "확인이 필요합니다", error: "처리하지 못했습니다" };
  function showHost() {
    const parent = document.activeElement?.closest("dialog:modal")
      || [...document.querySelectorAll("dialog:modal")].at(-1) || document.body;
    if (host.parentElement !== parent) {
      host.hidePopover();
      parent.append(host);
    }
    if (!host.matches(":popover-open")) host.showPopover();
  }
  new MutationObserver(() => {
    if (host?.childElementCount) showHost();
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open"] });
  function notice(message, kind = "warning") {
    if (!host?.isConnected) {
      host = document.createElement("section");
      host.className = "app-notices";
      host.setAttribute("aria-label", "작업 알림");
      host.setAttribute("popover", "manual");
      document.body.append(host);
    }
    // Attach inside the active modal so its inert background cannot disable the close button.
    showHost();
    const card = document.createElement("article");
    card.className = "app-notice";
    card.dataset.kind = kind;
    card.setAttribute("role", kind === "error" || kind === "warning" ? "alert" : "status");
    const symbol = document.createElement("span");
    symbol.className = "app-notice-symbol";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = kind === "success" ? "✓" : kind === "info" ? "i" : "!";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = labels[kind] || labels.info;
    const body = document.createElement("p");
    body.textContent = String(message);
    copy.append(title, body);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-notice-close";
    close.setAttribute("aria-label", "알림 닫기");
    close.textContent = "×";
    const dismiss = () => {
      card.remove();
      if (!host.childElementCount) host.hidePopover();
    };
    close.addEventListener("click", dismiss);
    card.append(symbol, copy, close);
    host.append(card);
    return dismiss;
  }
  window.BDONotifications = { notice };
})();
