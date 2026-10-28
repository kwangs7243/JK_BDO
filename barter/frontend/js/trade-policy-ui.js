import { state } from "./state.js";
import { saveSettings } from "./persistence.js";
import { validateUnusedTradePolicy } from "./domain/trade-unused-policy.js";

export function initTradePolicyUI(setStatus) {
  const dialog = document.querySelector("#trade-policy-dialog");
  const list = dialog.querySelector("[data-policy-items]");
  const search = dialog.querySelector('input[type="search"]');
  const unknown = dialog.querySelector("[data-policy-unknown]");
  const save = dialog.querySelector("[data-policy-save]");
  const message = dialog.querySelector('[role="status"]');
  let catalog, defaults;
  const ready = Promise.all(["trade-catalog.json", "trade-unused-policy.json"].map(async name => {
    const response = await fetch(`/assets/data/${name}`);
    if (!response.ok) throw new Error("품목 기준 자료를 불러오지 못했습니다.");
    return response.json();
  })).then(([data, policy]) => { catalog = data; defaults = validateUnusedTradePolicy(policy, data); });
  ready.catch(() => {});
  function filter() {
    const term = search.value.replace(/\s+/g, "");
    for (const row of list.querySelectorAll("label")) row.hidden = !row.textContent.replace(/\s+/g, "").includes(term);
  }
  search.addEventListener("input", filter);
  document.querySelector("#open-trade-policy").addEventListener("click", async () => {
    if (dialog.open) return;
    message.textContent = "";
    try {
      await ready;
      const policy = { ...defaults, ...state.settings.tradePolicy };
      unknown.checked = policy.autoExcludeUnregisteredOutputs;
      const excluded = new Set(policy.excludedOutputs);
      list.replaceChildren();
      const groups = [["특수 품목", catalog.specialItems], ...Object.entries(catalog.masterData)
        .sort(([left], [right]) => Number(right) - Number(left))
        .map(([tier, names]) => [Number(tier) === 0 ? "육지품" : `${tier}단 품목`, names])];
      for (const [title, names] of groups) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend"); legend.textContent = title; group.append(legend);
        for (const name of [...new Set(names)]) {
          const label = document.createElement("label"), check = document.createElement("input");
          check.type = "checkbox"; check.value = name; check.checked = excluded.has(name);
          label.append(check, document.createTextNode(name)); group.append(label);
        }
        list.append(group);
      }
      search.value = "";
      save.disabled = false;
      dialog.showModal();
      window.__bdoApplyAppZoom?.();
    } catch (error) { setStatus(error.message, "error"); }
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const policy = { excludedOutputs: [...new Set([...list.querySelectorAll("input:checked")].map(input => input.value))], autoExcludeUnregisteredOutputs: unknown.checked };
      validateUnusedTradePolicy({ version: 2, ...policy }, catalog);
      await saveSettings({ tradePolicy: policy });
      setStatus("자동 제외 품목을 저장했습니다. 다음 인식과 스케줄 생성부터 적용됩니다.", "success");
      dialog.close();
    } catch (error) { message.textContent = `저장하지 못했습니다: ${error.message}`; }
    finally { save.disabled = false; }
  });
}
