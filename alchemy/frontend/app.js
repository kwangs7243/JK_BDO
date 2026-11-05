import { confirmAction, notice } from "/portal-assets/feedback.js";
import { workbench } from "./workbench.js";
import { api } from "./api.js";
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (v) =>
  v == null
    ? "미확인"
    : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const qty = (v) => {
  if (!/^\d+$/.test(String(v)) || Number(v) > 1e9)
    throw Error("수량은 0~10억 사이 정수로 입력하세요.");
  return Number(v);
};
const labels = {
  unknown: "재고 확인 필요",
  yield_unknown: "수율 기록 확인 필요",
  supplied: "확보",
  ready: "지금 단독 제작 가능",
  short: "재료 부족",
  unverified: "검증 필요",
  in_progress: "제작 중",
};
const badge = (s) =>
  `<span class="badge ${esc(s)}">${esc(labels[s] ?? s)}</span>`;
const link = (id, g) =>
  "/alchemy/recipes/" +
  encodeURIComponent(id) +
  (g ? "?goal=" + encodeURIComponent(g) : "");
const date = (v) =>
  v ? new Date(v).toLocaleString("ko-KR") : "확인 이력 없음";
const names = new Map(),
  icons = new Map(),
  cache = new Map(),
  dirty = new Set();
const startStocks = new Map();
let stockConflict = false;
let state,
  catalog,
  plans = [],
  goal = null,
  detail = null,
  jobDetail = null,
  rows = [],
  offset = 0,
  query = "",
  preferencesLoaded = false,
  displayCatalogVersion = null,
  job,
  backup,
  fullCatalog,
  pending = null,
  busy = false;
const page = location.pathname.includes("/recipes/")
  ? "detail"
  : (["inventory", "history", "settings"].find((p) =>
      location.pathname.endsWith("/" + p),
    ) ?? "dashboard");
const name = (id) => names.get(id) ?? id;
function remember(items) {
  for (const i of Array.isArray(items) ? items : Object.values(items)) {
    names.set(i.item_id, i.name);
    if (/^icons\/[A-Za-z0-9_-]{1,100}\.(?:png|webp)$/.test(i.icon ?? ""))
      icons.set(i.item_id, i.icon);
  }
}
const icon = (id, large = false) =>
  icons.has(id)
    ? `<img class="item-icon${large ? " large" : ""}" src="/alchemy/assets/${esc(icons.get(id))}" width="${large ? 44 : 28}" height="${large ? 44 : 28}" alt="" data-item-id="${esc(id)}" loading="lazy" decoding="async">`
    : "";
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (
      !(image instanceof HTMLImageElement) ||
      !image.matches(".item-icon") ||
      image.dataset.failed
    )
      return;
    image.dataset.failed = "true";
    image.classList.add("image-unavailable");
    image.alt = "이미지 확인 필요";
    image.title = name(image.dataset.itemId) + " · 이미지 확인 필요";
    image.src = "/alchemy/assets/item-unavailable.svg";
  },
  true,
);
function batchButtons(row, title = "횟수 입력") {
  const batches = row.batches?.length
    ? row.batches
    : [{ recipe_id: row.recipe_id, calls: row.calls ?? 1 }];
  return batches
    .map(
      (b) =>
        `<button type="button" class="small" data-start="${row.item_id}" data-recipe="${b.recipe_id}" data-calls="${b.calls}">${esc(title)}${batches.length > 1 ? ` · ${fmt(b.planned_output)}개 (${fmt(b.calls)}회)` : ""}</button>`,
    )
    .join("");
}
function batchPolicy() {
  if (
    !goal ||
    new Set(
      detail.recipes.filter((r) => r.batch_group).map((r) => r.output_quantity),
    ).size !== 2
  )
    return "";
  const current = goal.batch_policies?.[detail.item.item_id] ?? "manual";
  return `<form id="batch-policy-form" data-protect><label>배치 선택 기준<select name="policy">${[
    ["manual", "수동 경로 고정"],
    ["surplus", "목표 초과 생산 최소화"],
    ["shortage", "현재고 기반 직접 재료 부족량 최소화"],
    ["calls", "제작 회차 최소화"],
  ]
    .map(
      ([key, label]) =>
        `<option value="${key}" ${key === current ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label><button type="submit">배치 기준 저장</button><p class="hint">10개·100개식을 조합합니다. 부족량은 직접 투입 재료 개수의 합으로 비교하며, 은화 비용이나 전체 하위 제작 비용을 뜻하지 않습니다. 미확인 재고는 별도로 표시합니다.</p></form>`;
}
function updatePanel() {
  const update = state.catalog_update;
  if (!update?.available) return "";
  if (update.base_unknown)
    return `<section class="panel"><h2>카탈로그 기준 버전 확인 필요</h2><p>기존 수정본을 유지했습니다. 기준 버전이 없어 자동 병합할 수 없습니다. 백업을 내보낸 뒤 새 배포본과 비교해 카탈로그를 가져오세요.</p></section>`;
  return `<section class="panel"><h2>배포 카탈로그 갱신</h2><p>배포 버전 ${esc(update.upstream_version)} · 사용자 수정이 없는 항목은 최신 값으로 표시합니다. 충돌한 제작식은 새 제작을 보류합니다.</p><form id="catalog-update-form" data-protect>${update.conflicts.map((c) => `<details class="catalog-conflict"><summary>${esc(c.key)} · 양쪽 변경</summary><div class="conflict-values"><pre>${esc(JSON.stringify(c.user, null, 2))}</pre><pre>${esc(JSON.stringify(c.upstream, null, 2))}</pre></div><label>왼쪽: 내 수정 / 오른쪽: 배포 수정<select name="${esc(c.key)}" required><option value="">유지할 값 선택</option><option value="user">내 수정 유지</option><option value="upstream">배포 수정 적용</option></select></label></details>`).join("")}<button type="submit">선택 병합하고 이전 상태 백업</button></form></section>`;
}
function status(text, kind = "info") {
  $("#status").textContent = text;
  $("#status").dataset.kind = kind;
  if (text && (kind === "error" || kind === "success")) notice(text, kind);
}
const report = (error) => { if (!error.reported) status(error.message, "error"); };
function hasDraft() {
  for (const f of dirty) if (!f.isConnected) dirty.delete(f);
  return dirty.size > 0;
}
async function leave() {
  if (busy || pending) {
    status("저장 중이거나 결과 확인이 필요합니다. 저장 결과를 먼저 확인하세요.", "error");
    return false;
  }
  return (
    !hasDraft() || await confirmAction("저장하지 않은 입력이 있습니다. 변경을 버릴까요?")
  );
}
function guard() {
  if (hasDraft()) {
    status(
      "입력 중인 내용을 먼저 저장하거나 새로 불러오기로 취소하세요.",
      "error",
    );
    return false;
  }
  return true;
}
async function recipe(id) {
  if (cache.has(id)) return cache.get(id);
  const result = await api("/recipes/" + encodeURIComponent(id));
  remember(result.items);
  cache.set(id, result);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return result;
}
async function load() {
  $("#content").setAttribute("aria-busy", "true");
  [state, catalog] = await Promise.all([api("/state"), api("/catalog")]);
  remember(catalog.craftables ?? catalog.products);
  if (displayCatalogVersion !== catalog.version) {
    for (let itemOffset = 0; itemOffset < catalog.item_count; itemOffset += 200) {
      remember((await api(`/items?limit=200&offset=${itemOffset}`)).items);
    }
    displayCatalogVersion = catalog.version;
  }
  if (!preferencesLoaded) {
    query = state.settings.inventory_filter ?? "";
    preferencesLoaded = true;
  }

  $("#page-title").textContent = {
    dashboard: "제작하기",
    detail: "제작 대상 상세",
    inventory: "연금 창고",
    history: "제작·재고 기록",
    settings: "데이터·백업",
  }[page];
  $(`nav [data-nav=${page === "detail" ? "dashboard" : page}]`)?.setAttribute(
    "aria-current",
    "page",
  );
  $("#data-version").textContent =
    `RECIPE ${catalog.version} · 저장 버전 ${state.revision}`;
  document.body.classList.toggle("workbench-page", page === "dashboard" || page === "detail");
  document.body.classList.toggle("inventory-page", page === "inventory");
  if (page === "dashboard") { goal = null; await workbench($("#content"), {api, esc, icon, fmt, jobs, report, inventory: state.inventory}); }
  if (page === "detail") await renderDetail();
  if (page === "inventory") await inventory();
  if (page === "history") await history();
  if (page === "settings") settings();
  if (page !== "settings" && state.catalog_update?.available) {
    $("#content").insertAdjacentHTML(
      "afterbegin",
      `<p class="callout">카탈로그 갱신 확인이 필요합니다. <a href="/alchemy/settings">데이터·백업에서 확인</a></p>`,
    );
  }
  $("#content").setAttribute("aria-busy", "false");
  status("저장 상태를 확인했습니다. 미확인 재고는 0개와 구분합니다.");
}
async function save(action, fields, form, keepStart = false) {
  if (busy) return;
  for (const f of dirty)
    if (f.isConnected && f !== form)
      throw Error(
        "다른 입력 내용이 남아 있습니다. 먼저 저장하거나 취소하세요.",
      );
  const signature = JSON.stringify({ action, fields });
  if (pending && pending.signature !== signature)
    throw Error("이전 저장 결과를 먼저 재확인하세요.");
  pending ??= {
    signature,
    action,
    keepStart,
    body: {
      ...fields,
      mutationId: crypto.randomUUID(),
      baseRevision: state.revision,
    },
  };
  busy = true;
  document
    .querySelectorAll("button[type=submit]")
    .forEach((b) => (b.disabled = true));
  status("트랜잭션을 저장하는 중입니다.");
  if ($("#start-form")) startPreview();
  try {
    const result = await api("/mutations/" + action, pending.body);
    pending = null;
    $("#retry-area").hidden = true;
    if (form) dirty.delete(form);
    cache.clear();
    fullCatalog = null;
    if (keepStart) startStocks.clear();
    else $("#work-dialog").close();
    await load();
    if (keepStart) dirty.add(form);
    status("저장을 확인했습니다. 제작 계획을 다시 계산했습니다.", "success");
    if (result.previous_backup_id) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = " · 복원 전 백업 내려받기";
      a.onclick = (event) => {
        event.preventDefault();
        download(
          "/backup?id=" + encodeURIComponent(result.previous_backup_id),
          "BDO-alchemy-before-restore.json",
        ).catch(report);
      };
      $("#status").append(a);
    }
    return result;
  } catch (error) {
    if (error.uncertain) {
      $("#retry-area").hidden = false;
      status(
        "저장 응답을 받지 못했습니다. 같은 트랜잭션으로 결과를 재확인하세요.",
        "error",
      );
    } else {
      pending = null;
      $("#retry-area").hidden = true;
      if (error.status === 409) {
        if (keepStart) stockConflict = true;
        state = await api("/state");
      }
      report(error);
    }
    error.reported = true;
    throw error;
  } finally {
    busy = false;
    document
      .querySelectorAll("button[type=submit]")
      .forEach((b) => (b.disabled = false));
    if ($("#start-form")) startPreview();
  }
}
function jobs() {
  return `<section class="jobs-section jobs-panel"><div class="jobs-heading"><h2>진행 중인 제작</h2><small>${state.jobs.length}건</small></div><div class="jobs-list">${state.jobs.length ? state.jobs.map(j => `<article class="job-tile">${icon(j.recipe.output_item_id)}<div class="job-description"><h3>${esc(name(j.recipe.output_item_id))}</h3><p>${j.track_inventory === false ? "재고 미반영" : "재료 차감 완료"} · ${esc(j.recipe.method)}</p></div><span class="job-calls">${fmt(j.calls)}<small>회</small></span><div class="job-actions"><button type="button" data-finish="${j.job_id}">결과 입력 ↗</button><button type="button" class="danger" data-cancel="${j.job_id}">미실행 취소</button></div></article>`).join("") : '<p class="empty">진행 중인 제작이 없습니다. 재료를 확인한 뒤 시작하세요.</p>'}</div></section>`;
}

function yieldBasis(r) {
  const h = r.yield_history;
  if (r.yield_source === "history")
    return `기록 평균 ${fmt(r.expected_yield)}개/회 · 누적 ${fmt(h.total_calls)}회 (${fmt(h.jobs)}건)`;
  if (r.yield_source === "manual")
    return `수동 설정 ${fmt(r.expected_yield)}개/회`;
  if (r.batches?.length > 1)
    return r.batches
      .map((b) => `${fmt(b.planned_output)}개 배치 · ${fmt(b.calls)}회`)
      .join(" + ");
  if (r.yield_source === "fixed") return `고정 ${fmt(r.expected_yield)}개/회`;
  if (r.yield_source === "minimum")
    return `기록 없음 · ${fmt(r.expected_yield)}개/회 가정`;
  return "재고 확인 후 계산";
}
function focusedRows(p) {
  const byId = new Map(p.rows.map((r) => [r.item_id, r]));
  const reachable = new Set();
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const input of byId.get(id)?.inputs ?? []) visit(input.item_id);
  };
  visit(detail.item.item_id);
  return p.rows.filter((r) => reachable.has(r.item_id));
}
function materialTable(materials) {
  return materials.length
    ? `<div class="table-wrap"><table><thead><tr><th>재료</th><th class="num">필요</th><th class="num">재고</th><th class="num">예약</th><th class="num">부족</th><th>상태</th></tr></thead><tbody>${materials.map((r) => `<tr><td class="item-name"><a href="${link(r.item_id, goal?.goal_id)}">${icon(r.item_id)}${esc(r.name)}</a></td><td class="num">${fmt(r.need)}</td><td class="num">${fmt(r.stock)}</td><td class="num">${fmt(r.allocated)}</td><td class="num">${fmt(r.missing)}</td><td>${badge(r.status)}</td></tr>`).join("")}</tbody></table></div>`
    : '<div class="empty">표시할 재료가 없습니다.</div>';
}
function recipeCards() {
  return detail.recipes
    .map(
      (r) =>
        `<details class="recipe-option"><summary><strong>${esc(r.method)} · ${fmt(r.output_quantity)}개 기준</strong>${badge(r.verification === "verified" ? "supplied" : "unverified")}<span class="source-tag">${r.source_kind === "official" ? "공식 패치 대조" : r.source_kind === "user_checked" ? "사용자 확인" : "보조 DB 대조"} · ${esc(r.verified_at ?? "미확인")}</span></summary><ul>${r.inputs.map((i) => `<li>${icon(i.item_id)}${esc(name(i.item_id))} ${fmt(i.quantity)}개${i.alternatives?.length ? " · 검증된 대체 가능" : ""}</li>`).join("")}</ul><p class="hint">${r.yield_type === "fixed" ? "고정 산출" : "가변 산출: 내 기록 평균으로 계획 · 실제 입력량만 재고 반영"} · 요구 단계 ${esc(r.required_skill ?? "미확인")}</p>${detail.yield_history?.[r.recipe_id] ? `<p class="yield-record">내 완료 기록 · ${fmt(detail.yield_history[r.recipe_id].average)}개/회 · 누적 ${fmt(detail.yield_history[r.recipe_id].total_calls)}회 / ${fmt(detail.yield_history[r.recipe_id].total_output)}개</p>` : '<p class="hint">이 제작식의 완료 기록이 없습니다.</p>'}${
          r.audit?.status === "UNRESOLVED"
            ? `<p class="hint">추가 확인 필요: ${r.audit.unresolved_fields
                .map(
                  (f) =>
                    ({
                      yield_type: "실제 산출 범위",
                      alternatives: "대체재 제작 경로",
                      user_changes: "사용자 수정 내용 재검증",
                    })[f] ?? f,
                )
                .map(esc)
                .join(" / ")}</p>`
            : ""
        }<p class="sources">${r.source_urls.map((url, i) => `<a href="${esc(/^https?:\/\//.test(url) ? url : "#")}" target="_blank" rel="noopener noreferrer">검증 출처 ${i + 1} ↗</a>`).join("")}</p><div class="actions">${goal ? `<button type="button" data-select-recipe="${r.recipe_id}">이 경로로 계획</button>` : ""}<button type="button" data-start="${r.output_item_id}" data-recipe="${r.recipe_id}" ${r.verification !== "verified" || r.update_conflict || detail.errors.some((v) => v.recipe_id === r.recipe_id) ? "disabled" : ""}>제작 시작 미리보기</button></div></details>`,
    )
    .join("");
}
async function renderDetail() {
  goal = null;
  const id = decodeURIComponent(location.pathname.split("/recipes/")[1]);
  await workbench($("#content"), {api, esc, icon, fmt, jobs, report, inventory: state.inventory}, id);
}

function tree(p) {
  const filter = $("#plan-filter").value,
    q = $("#plan-search").value;
  const filtered = p.rows.filter(
    (r) =>
      r.name.includes(q) &&
      (filter === "all" ||
        (filter === "short" && (r.missing !== 0 || r.unknown)) ||
        (filter === "ready" && r.ready) ||
        (filter === "base" && !r.recipe_id)),
  );
  if (filter !== "all" || q) {
    $("#plan-tree").innerHTML =
      materialTable(filtered) +
      filtered
        .filter((r) => r.calls)
        .map(
          (r) =>
            `<div class="tree-actions"><span>${esc(r.name)} · 계획상 ${fmt(r.calls)}회 / 예상 ${fmt(r.planned_output)}개</span><button class="small" type="button" data-start="${r.item_id}" data-recipe="${r.recipe_id}" data-calls="${r.calls}">제작 미리보기</button></div>`,
        )
        .join("");
    return;
  }
  const byId = new Map(p.rows.map((r) => [r.item_id, r]));
  const node = (r) =>
    `<details class="tree-node" data-tree="${r.item_id}"><summary><strong>${icon(r.item_id)}${esc(r.name)}</strong>${badge(r.status)}<span class="counts">필요 ${fmt(r.need)} · 보유 ${fmt(r.stock)} · 부족 ${fmt(r.missing)}${r.calls ? " · 계획상 " + fmt(r.calls) + "회" : ""}</span></summary><div class="branch-slot"></div></details>`;
  $("#plan-tree").innerHTML =
    (byId.get(detail.item.item_id) ?? p.rows[0])
      ? node(byId.get(detail.item.item_id) ?? p.rows[0])
      : '<div class="empty">보류한 목표입니다.</div>';
  $("#plan-tree").addEventListener(
    "toggle",
    (event) => {
      const d = event.target;
      if (!d.open || !d.matches("[data-tree]") || d.dataset.rendered) return;
      d.dataset.rendered = "1";
      const r = byId.get(d.dataset.tree);
      $(".branch-slot", d).innerHTML =
        `<div class="tree-actions"><a href="${link(r.item_id, goal?.goal_id)}">제작식·수급 보기 ↗</a>${r.recipe_id ? `${batchButtons(r, "제작 미리보기")}` : ""}</div>${r.ready ? `<p class="hint">${r.plan_ready ? "현재고를 계획 순서에 배정 가능" : "공유 재료 중복: 현재고 순서 배정 부족"}</p>` : ""}${r.calls ? `<p class="hint">계획 산출 ${fmt(r.planned_output)}개 · 초과 ${fmt(r.surplus)}개 · ${esc(yieldBasis(r))}</p>` : ""}${r.inputs.map((v) => (byId.has(v.item_id) ? node(byId.get(v.item_id)) : "")).join("")}`;
    },
    { capture: true },
  );
  const first = $("[data-tree]");
  if (first) first.open = true;
}

async function inventory() {
  const data = await api(`/items?q=${encodeURIComponent(query)}&offset=0&limit=200`);
  rows = [...data.items];
  for(let i=200;i<data.total;i+=200) rows.push(...(await api(`/items?q=${encodeURIComponent(query)}&offset=${i}&limit=200`)).items);
  remember(rows);
  const groups = [["intermediate", "시약·중간재"], ["product", "비약·완성품"], ["raw", "기본 재료"]];
  const group = i => i.role === "intermediate" ? "intermediate" : i.craftable ? "product" : "raw";
  const stockSlot = i => { const tag = i.craftable ? "a" : "div"; return `<div class="stock-slot"><${tag} class="stock-item" ${i.craftable ? `href="${link(i.item_id)}"` : ""}>${icon(i.item_id,true)}<span class="stock-name">${esc(i.name)}</span></${tag}><input type="number" min="0" max="1000000000" value="${i.quantity??""}" data-stock="${esc(i.item_id)}" aria-label="${esc(i.name)} 실제 재고" placeholder="미확인"></div>`; };
  $("#content").innerHTML = `<header class="stock-heading"><div><h2>연금 창고</h2><p>필요한 재료의 보유량을 직접 확인하고 수정하세요.</p></div><form id="inventory-search"><input type="search" name="q" value="${esc(query)}" placeholder="창고에서 품목 찾기" aria-label="창고 품목 검색"><button type="submit">검색</button></form></header><nav class="stock-index" aria-label="창고 분류">${groups.map(([key,label])=>`<a href="#stock-${key}">${label}</a>`).join("")}</nav><form id="inventory-form" data-protect>${groups.map(([key,label])=>{const entries=rows.filter(i=>group(i)===key);return entries.length?`<section class="stock-shelves" id="stock-${key}"><header class="stock-shelf-heading"><h3>${label}</h3><span>${entries.length}종</span></header><div class="stock-grid">${entries.map(stockSlot).join("")}</div></section>`:"";}).join("")}${rows.length?"":'<p class="empty">검색한 품목이 없습니다.</p>'}<div class="stock-save-bar"><span>빈칸은 미확인 · 0은 확인한 0개</span><button class="primary" type="submit">변경한 재고 저장</button></div></form><details class="stock-bulk"><summary>여러 품목 한 번에 입력</summary><form id="bulk-form" data-protect><label for="bulk-text">품목명 = 수량</label><textarea id="bulk-text" name="text" placeholder="맑은 액체 시약 = 500" required></textarea><button type="submit">일괄 입력 미리보기</button></form></details>`;
}

async function history() {
  const [data, all] = await Promise.all([
    api("/history?offset=" + offset),
    api("/items?limit=200"),
  ]);
  remember(all.items);
  const actionNames = {
    inventory: "재고 변경",
    goal: "목표 변경",
    start: "제작 시작",
    finish: "제작 완료",
    cancel: "제작 취소",
    correct: "결과 정정",
    restore: "백업 복원",
    settings: "설정 변경",
    catalog: "레시피 변경",
    catalog_update: "배포 제작식 갱신",
  };
  $("#content").innerHTML =
    `<div class="intro"><div><h2>제작·재고 기록</h2><p class="muted">재고 증감과 제작 작업을 트랜잭션 단위로 기록합니다.</p></div></div><section class="panel"><h2>제작·재고 원장</h2>${
      data.events.length
        ? data.events
            .map((v) => {
              const j = v.result.job;
              return `<details class="history-event"><summary><span class="badge">${actionNames[v.action] ?? esc(v.action)}</span><span>${j ? esc(name(j.recipe.output_item_id)) + " · " + fmt(j.executed_calls ?? j.calls) + "회" : v.result.goal ? esc(name(v.result.goal.item_id)) : v.result.changed_items ? fmt(v.result.changed_items.length) + "개 품목" : ""}</span><time>${date(v.at)}</time></summary><p class="hint">거래 ID ${esc(v.transaction_id)}</p>${
                j
                  ? `<p class="hint">시작 시 입력: ${j.inputs_per_call.map((i) => esc(name(i.item_id)) + " × " + fmt(i.quantity * j.calls)).join(" / ")}</p><p class="hint">실제 산출: ${
                      Object.entries(j.outputs)
                        .map(([id, q]) => esc(name(id)) + " " + fmt(q))
                        .join(" / ") || "미등록"
                    }</p>${j.status === "completed" ? `<button type="button" class="small" data-correct="${j.job_id}">결과 정정 기록</button>` : ""}`
                  : ""
              }<p class="hint">${esc(v.result.reason ?? "")}</p><details><summary class="hint">거래 상세</summary><pre>${esc(JSON.stringify(v, null, 2))}</pre></details></details>`;
            })
            .join("")
        : '<div class="empty">아직 제작·재고 기록이 없습니다.</div>'
    }<div class="table-actions"><span class="hint">총 ${data.total}건</span><div class="actions"><button type="button" data-page="-1" ${offset === 0 ? "disabled" : ""}>이전</button><button type="button" data-page="1" ${offset + 50 >= data.total ? "disabled" : ""}>다음</button></div></div></section>`;
}
function settings() {
  $("#content").innerHTML =
    `${updatePanel()}<div class="intro"><div><h2>데이터·백업</h2><p class="muted">연금 재고·제작 기록과 저장 데이터를 함께 내보냅니다. 물교 데이터는 포함하지 않습니다.</p></div></div><div class="settings-grid"><section class="panel"><h2>연금 데이터 백업</h2><p class="hint">스키마 ${state.schema_version} · SQLite. 복원 전 현재 연금 상태는 별도 자동 백업됩니다.</p><button class="primary" type="button" id="export-backup">전체 데이터 내보내기</button><hr><label for="backup-file" class="hint">가져올 연금 백업 JSON</label><input type="file" id="backup-file" accept="application/json,.json"><div id="backup-preview"></div></section><section class="panel"><h2>레시피 카탈로그</h2><p>${catalog.item_count}개 품목 · ${catalog.recipe_count}개 제작식</p><p class="hint">공식 패치 대조 ${catalog.official_recipe_count}개 · 보조 DB·사용자 대조 ${catalog.recipe_count - catalog.official_recipe_count}개<br>버전 ${esc(catalog.version)}</p>${catalog.notes.map((n) => `<p class="hint">${esc(n)}</p>`).join("")}<div class="actions"><button type="button" id="export-catalog">카탈로그 내보내기</button><button type="button" id="edit-catalog">제작식 편집</button></div><p class="hint">출처와 검증 상태를 함께 관리합니다. 미검증 제작식은 자동 차감을 차단합니다.</p><label for="catalog-file" class="hint">카탈로그 JSON 가져오기</label><input type="file" id="catalog-file" accept="application/json,.json"><div id="catalog-preview"></div></section></div><section class="panel"><h2>화면 기본 설정</h2><form id="preferences-form" data-protect><div class="form-row"><label>제작 트리 기본 표시<select name="tree_filter">${Object.entries(
      {
        all: "전체 단계",
        short: "부족·미확인만",
        ready: "제작 가능한 단계",
        base: "최하위 재료만",
      },
    )
      .map(
        ([v, t]) =>
          `<option value="${v}" ${state.settings.tree_filter === v ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="wide">재고 기본 검색어<input name="inventory_filter" maxlength="1000" value="${esc(state.settings.inventory_filter ?? "")}" placeholder="빈칸: 전체 품목"></label><button type="submit">화면 설정 저장</button></div></form><p class="hint">연금 DB와 백업에 저장합니다. 미저장 입력과 제작 결과는 변경하지 않습니다.</p></section><section class="panel catalog-editor" id="catalog-editor" hidden></section>`;
}
function modal(title, html) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
  $("#work-dialog").showModal();
}
const modalButtons = (text) =>
  `<div class="dialog-actions"><button type="button" data-close>취소</button><button class="primary" type="submit">${text}</button></div>`;
async function startModal(id, rid, calls = 1) {
  if (!guard()) return;
  jobDetail = await recipe(id);
  const r =
    jobDetail.recipes.find((r) => r.recipe_id === rid) ?? jobDetail.recipes[0];
  if (!r) throw Error("제작식이 없는 외부 수급 품목입니다.");
  startStocks.clear();
  stockConflict = false;
  const planned = goal
    ? plans
        .find((p) => p.goal_id === goal.goal_id)
        ?.rows.find((v) => v.recipe_id === r.recipe_id)
    : null;
  if (
    r.yield_type !== "fixed" &&
    !["history", "manual"].includes(planned?.yield_source)
  )
    calls = calls > 1 ? calls : "";
  modal(
    name(id) + " · 제작 시작",
    `<form id="start-form" class="dialog-form" data-protect><div class="form-row"><label class="wide">제작 경로<select name="recipe_id" id="start-recipe">${jobDetail.recipes.map((v) => `<option value="${v.recipe_id}" ${v.recipe_id === r.recipe_id ? "selected" : ""}>${esc(v.method)} · ${v.output_quantity}개 단위</option>`).join("")}</select></label><label>제작할 횟수<input type="number" name="calls" min="1" max="1000000000" value="${calls}" placeholder="직접 입력" required></label></div><label><input id="track-inventory" type="checkbox" ${goal ? "checked" : ""}> 재고도 함께 반영</label><div id="start-ingredients"></div><div class="start-stock-actions"><div><strong>재료 재고 바로 확인</strong><p class="hint">게임에서 확인한 실제 보유량을 입력하세요. 빈칸은 미확인, 0은 확인한 0개입니다.</p><p id="start-stock-status" role="status"></p></div><div class="actions"><button type="button" id="save-start-stock">변경한 재고 저장</button><button type="button" id="reload-start-stock">입력 취소·최신 재고</button><button type="button" id="retry-start-stock" hidden>저장 결과 재확인</button></div></div><div class="callout">재고 반영을 선택한 작업만 재료를 차감합니다. 완료 후 실제 수행 횟수와 나온 개수를 입력하면 DB에 누적되고 다음 계획의 수율에 반영됩니다.</div>${modalButtons("작업 시작")}</form>`,
  );
  startIngredients();
}
const startRecipe = () =>
  jobDetail.recipes.find((r) => r.recipe_id === $("#start-recipe").value);
function startIngredients() {
  const r = startRecipe();
  $("#start-ingredients").innerHTML =
    `<p class="hint">${esc(r.method)} · 최소 산출 ${r.output_quantity}개/회 · 요구 단계 ${esc(r.required_skill ?? "미확인")}</p><div class="table-wrap"><table><thead><tr><th>소비 재료 · 혼합 투입 없음</th><th class="num">현재 보유</th><th class="num">차감 수량</th><th>확인</th></tr></thead><tbody>${r.inputs
      .map((i) => {
        const chosen =
          goal?.substitutions?.[r.recipe_id + ":" + i.item_id] ?? i.item_id;
        return `<tr><td><span data-input-icon>${icon(chosen)}</span><select data-substitute="${i.item_id}" aria-label="${esc(name(i.item_id))} 소비 재료">${[{ item_id: i.item_id, quantity: i.quantity }, ...(i.alternatives ?? [])].map((v) => `<option value="${v.item_id}" data-quantity="${v.quantity}" ${chosen === v.item_id ? "selected" : ""}>${esc(name(v.item_id))} · 1회 ${v.quantity}개</option>`).join("")}</select></td><td class="num"><input type="number" min="0" max="1000000000" step="1" data-start-stock placeholder="미확인"></td><td class="num" data-consume></td><td data-ready></td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div>${r.verification !== "verified" || jobDetail.errors.some((v) => v.recipe_id === r.recipe_id) ? '<p class="error-note">검증 필요 또는 순환 참조가 있는 제작식입니다. 제작을 시작할 수 없습니다.</p>' : ""}`;
  startPreview();
}
function startStockChanges() {
  return [...startStocks].map(([item_id, raw]) => ({item_id, quantity: raw === "" ? null : qty(raw)}))
    .filter(v => v.quantity !== (state.inventory[v.item_id] ?? null));
}
function startPreview() {
  const form = $("#start-form"), rawCalls = $("[name=calls]", form).value;
  const calls = /^\d+$/.test(rawCalls) && Number(rawCalls) >= 1 && Number(rawCalls) <= 1e9 ? Number(rawCalls) : null;
  const totals = new Map();
  for (const s of form.querySelectorAll("[data-substitute]"))
    totals.set(s.value, (totals.get(s.value) ?? 0) + Number(s.selectedOptions[0].dataset.quantity) * calls);
  let enough = calls !== null;
  for (const s of form.querySelectorAll("[data-substitute]")) {
    const tr = s.closest("tr"),
      needed = Number(s.selectedOptions[0].dataset.quantity) * calls,
      current = state.inventory[s.value];
    $("[data-input-icon]", tr).innerHTML = icon(s.value);
    const input = $("[data-start-stock]", tr);
    input.dataset.item = s.value;
    input.setAttribute("aria-label", `${name(s.value)} 실제 보유량`);
    if (input !== document.activeElement)
      input.value = startStocks.has(s.value) ? startStocks.get(s.value) : current ?? "";
    $("[data-consume]", tr).textContent =
      calls == null ? "횟수 입력" : fmt(needed);
    $("[data-ready]", tr).innerHTML =
      calls == null
        ? ""
        : badge(
            current == null ? "unknown" : current >= totals.get(s.value) ? "ready" : "short",
          );
    if (current == null || !Number.isSafeInteger(totals.get(s.value)) || current < totals.get(s.value)) enough = false;
  }
  let changes = [], invalid = [...form.querySelectorAll("[data-start-stock]")].some(input => input.validity.badInput);
  try { changes = startStockChanges(); } catch { invalid = true; }
  $("#start-stock-status").textContent = stockConflict
    ? "다른 창에서 재고가 변경됐습니다. 최신 재고를 불러온 뒤 다시 확인하세요."
    : invalid ? "보유량은 0~10억 사이 정수로 입력하세요."
    : changes.length ? `저장 전 ${changes.length}종 · ${changes.map(v => `${name(v.item_id)} ${fmt(v.quantity)}`).join(" / ")}`
    : "저장된 재고로 비교하고 있습니다.";
  $("#save-start-stock").disabled = busy || !!pending || stockConflict || invalid || !changes.length;
  $("#reload-start-stock").disabled = busy || !!pending;
  $("#retry-start-stock").hidden = !pending;
  $("#retry-start-stock").disabled = busy;
  const tracking = $("#track-inventory").checked;
  $(".start-stock-actions", form).hidden = !tracking;
  for (const field of form.querySelectorAll("[data-start-stock]")) field.closest("td").hidden = !tracking;
  $("button[type=submit]", form).disabled = busy || !!pending || (tracking && (stockConflict || invalid || !!changes.length || !enough)) || calls === null
    || startRecipe().verification !== "verified" || jobDetail.errors.some(v => v.recipe_id === startRecipe().recipe_id);
  for (const input of form.querySelectorAll("input, select")) input.disabled = busy || !!pending;
}
async function finishModal(id, correct = false) {
  if (!guard()) return;
  job = (await api("/jobs/" + encodeURIComponent(id))).job;
  const d = await recipe(job.recipe.output_item_id);
  remember(d.items);
  modal(
    name(job.recipe.output_item_id) +
      (correct ? " · 결과 정정" : " · 실제 제작 결과"),
    `<form id="finish-form" class="dialog-form" data-protect data-correct="${correct}"><div class="form-row"><label>실제로 수행한 횟수<input type="number" name="executed_calls" min="0" max="${job.calls}" value="${correct ? job.executed_calls : job.calls}" ${correct ? "readonly" : ""} required></label><span class="hint">시작 ${fmt(job.calls)}회 · ${correct ? "산출량만 정정합니다." : "재고 반영 작업의 미수행 재료만 반환합니다."}</span></div><p class="hint">일반품·상위품·부산물을 각각 입력하세요. 주 산출량은 0도 명시 입력합니다. 추가 산출의 빈칸은 추가 없음입니다.</p>${[job.recipe.output_item_id, ...(job.recipe.additional_output_ids ?? [])].map((id, i) => `<div class="output-row"><span>${icon(id)}${esc(name(id))}<small class="hint"><br>현재 재고 ${fmt(state.inventory[id])}</small></span><label>실제 산출량<input type="number" min="0" max="1000000000" value="${correct ? (job.outputs[id] ?? 0) : ""}" data-output="${id}" ${i === 0 ? "required" : ""} aria-label="${esc(name(id))} 실제 산출량"></label><label>${job.track_inventory === false ? "재고 미반영 · 기록만 저장" : state.inventory[id] == null ? `제작 전 보유량 확인<input type="number" min="0" max="1000000000" data-baseline="${id}" placeholder="미확인 → 직접 확인">` : "확인된 기존 수량에 추가"}</label></div>`).join("")}${correct ? '<label>정정 사유<textarea name="reason" required></textarea></label><p class="callout">이후 작업에서 소비한 수량과 충돌하면 정정을 중단하고 원장을 유지합니다.</p>' : '<p class="callout">재고 미반영 작업은 산출 기록만 저장합니다. 재고 반영 작업에서 미확인 결과물은 제작 전 보유량을 확인하세요.</p>'}${modalButtons(correct ? "정정 기록 저장" : "실제 산출량으로 제작 완료")}</form>`,
  );
}
function adjustModal(id) {
  if (!guard()) return;
  modal(
    name(id) + " · 수급·사용",
    `<form id="adjust-form" class="dialog-form" data-protect data-item="${id}"><p class="hint">현재 실제 재고 ${fmt(state.inventory[id])}개</p><div class="form-row"><label>변경 유형<select name="kind"><option value="gather">채집·노드 수급 추가</option><option value="purchase">거래소 구매 추가</option><option value="use">게임에서 사용 차감</option><option value="adjustment">실사 절대 수량 보정</option></select></label><label>수량<input type="number" min="0" name="quantity" required></label></div><label>변경 사유<textarea name="reason" required></textarea></label>${modalButtons("재고 변경 저장")}</form>`,
  );
}
async function download(path, filename) {
  const data = await api(path),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function editCatalog() {
  if (!guard()) return;
  fullCatalog = await api("/catalog?full=1");
  remember(fullCatalog.items);
  $("#catalog-editor").hidden = false;
  $("#catalog-editor").innerHTML =
    `<h2>제작식 편집</h2><label>대상 제작식<select id="edit-recipe">${fullCatalog.recipes.map((r) => `<option value="${r.recipe_id}">${esc(name(r.output_item_id))} · ${esc(r.method)} · ${r.output_quantity}개</option>`).join("")}</select></label><div id="recipe-editor"></div>`;
  recipeEditor();
}
function recipeEditor() {
  const r = fullCatalog.recipes.find(
    (v) => v.recipe_id === $("#edit-recipe").value,
  );
  $("#recipe-editor").innerHTML =
    `<form id="recipe-edit-form" data-protect><div class="form-row"><label>산출 단위<input type="number" min="1" name="output_quantity" value="${r.output_quantity}" required></label><label>산출 유형<select name="yield_type">${["fixed", "variable", "additional"].map((t) => `<option value="${t}" ${r.yield_type === t ? "selected" : ""}>${{ fixed: "고정", variable: "가변", additional: "추가 산출" }[t]}</option>`).join("")}</select></label><label>제작 방식<input name="method" value="${esc(r.method)}" required></label><label>요구 단계<input name="required_skill" value="${esc(r.required_skill ?? "")}" placeholder="미확인"></label></div><div class="table-wrap"><table><thead><tr><th>재료</th><th>1회 수량</th></tr></thead><tbody>${r.inputs.map((i) => `<tr><td>${icon(i.item_id)}${esc(name(i.item_id))}</td><td><input type="number" min="1" value="${i.quantity}" data-recipe-input="${i.item_id}" aria-label="${esc(name(i.item_id))} 제작식 수량" required></td></tr>`).join("")}</tbody></table></div><div class="form-row"><label class="wide">검증 출처 URL<input type="url" name="source" value="${esc(r.source_urls[0])}" required></label><label>검증 상태<select name="verification"><option value="review_required">검증 필요 · 제작 차단</option><option value="verified" ${r.verification === "verified" ? "selected" : ""}>직접 대조 확인 · 제작 허용</option></select></label></div><label>변경 사유<input name="reason" required></label><p class="hint">배포 원본을 덮어쓰지 않고 연금 DB에 사용자 카탈로그로 저장합니다. 변경 시 새 버전과 확인일을 남깁니다. 대체 재료가 있는 수량을 바꾸면 기존 치환은 해제됩니다.</p><button class="primary" type="submit">제작식 변경 저장</button></form>`;
}

async function submit(form) {
  const f = new FormData(form);
  if (form.id === "preferences-form") {
    await save(
      "settings",
      {
        settings: {
          tree_filter: f.get("tree_filter"),
          inventory_filter: f.get("inventory_filter"),
        },
      },
      form,
    );
    query = state.settings.inventory_filter ?? "";
  }
  if (form.id === "goal-form")
    await save(
      "goal",
      {
        ...(goal ?? {}),
        item_id: f.get("item_id"),
        quantity: qty(f.get("quantity")),
        mode: f.get("mode"),
        priority: qty(f.get("priority")),
      },
      form,
    );
  if (form.id === "inventory-search") {
    if (!guard()) return;
    query = f.get("q");
    offset = 0;
    await inventory();
  }
  if (form.id === "inventory-form") {
    const changes = [...form.querySelectorAll("[data-stock]")]
      .map((i) => ({
        item_id: i.dataset.stock,
        quantity: i.value === "" ? null : qty(i.value),
      }))
      .filter(
        (v) =>
          v.quantity !==
          (rows.find((i) => i.item_id === v.item_id)?.quantity ?? null),
      );
    if (!changes.length) {
      dirty.delete(form);
      status("변경한 수량이 없습니다.");
      return;
    }
    await save("inventory", { changes }, form);
  }
  if (form.id === "bulk-form") {
    for (const d of dirty)
      if (d.isConnected && d !== form)
        throw Error("다른 재고 입력을 먼저 저장하세요.");
    const all = (await api("/items?limit=200")).items;
    remember(all);
    const lines = f
        .get("text")
        .split(/\r?\n/)
        .filter((s) => s.trim()),
      changes = [],
      seen = new Set();
    if (lines.length > 200)
      throw Error("한 번에 최대 200개 품목까지 입력하세요.");
    for (const line of lines) {
      const parts = line.split(/\t|=/).map((v) => v.trim());
      if (parts.length !== 2) throw Error("품목명 = 수량 형식을 확인하세요.");
      const found = all.filter(
        (i) => i.name === parts[0] || i.aliases?.includes(parts[0]),
      );
      if (found.length !== 1 || seen.has(found[0].item_id))
        throw Error(parts[0] + ": 중복·미등록·모호한 이름입니다.");
      seen.add(found[0].item_id);
      changes.push({ item_id: found[0].item_id, quantity: qty(parts[1]) });
    }
    dirty.delete(form);
    modal(
      "일괄 재고 변경 미리보기",
      `<form id="bulk-apply" data-protect><div class="table-wrap"><table><thead><tr><th>품목</th><th>현재</th><th>변경 후</th></tr></thead><tbody>${changes.map((v) => `<tr><td>${icon(v.item_id)}${esc(name(v.item_id))}</td><td>${fmt(state.inventory[v.item_id])}</td><td>${fmt(v.quantity)}</td></tr>`).join("")}</tbody></table></div><p class="callout">${changes.length}개 품목의 절대 수량을 저장합니다.</p>${modalButtons("일괄 적용")}</form>`,
    );
    $("#bulk-apply")._changes = changes;
    dirty.add($("#bulk-apply"));
  }
  if (form.id === "bulk-apply")
    await save("inventory", { changes: form._changes }, form);
  if (form.id === "batch-policy-form") {
    await save(
      "goal",
      {
        ...goal,
        batch_policies: {
          ...goal.batch_policies,
          [detail.item.item_id]: f.get("policy"),
        },
      },
      form,
    );
  }
  if (form.id === "catalog-update-form") {
    await save(
      "catalog_update",
      { token: state.catalog_update.token, resolutions: Object.fromEntries(f) },
      form,
    );
  }
  if (form.id === "start-form") {
    if ($("#track-inventory").checked && (stockConflict || startStockChanges().length))
      throw Error("수정한 재고를 먼저 저장하거나 최신 재고를 불러오세요.");
    const r = startRecipe(),
      substitutions = { ...(goal?.substitutions ?? {}) };
    for (const s of form.querySelectorAll("[data-substitute]"))
      substitutions[r.recipe_id + ":" + s.dataset.substitute] = s.value;
    await save(
      "start",
      {
        track_inventory: $("#track-inventory").checked,
        recipe_id: r.recipe_id,
        calls: qty(f.get("calls")),
        goal_id: goal?.goal_id ?? null,
        choices: goal?.choices ?? {},
        substitutions,
      },
      form,
    );
  }
  if (form.id === "finish-form") {
    const outputs = {},
      baseline_counts = {};
    for (const i of form.querySelectorAll("[data-output]"))
      if (i.value !== "") outputs[i.dataset.output] = qty(i.value);
    for (const i of form.querySelectorAll("[data-baseline]"))
      if (i.value !== "") baseline_counts[i.dataset.baseline] = qty(i.value);
    await save(
      form.dataset.correct === "true" ? "correct" : "finish",
      {
        job_id: job.job_id,
        outputs,
        baseline_counts,
        executed_calls: qty(f.get("executed_calls")),
        reason: f.get("reason") ?? "",
      },
      form,
    );
  }
  if (form.id === "adjust-form")
    await save(
      "inventory",
      {
        changes: [
          {
            item_id: form.dataset.item,
            kind: f.get("kind"),
            quantity: qty(f.get("quantity")),
          },
        ],
        reason: f.get("reason"),
      },
      form,
    );
  if (form.id === "yield-form") {
    const expected_yields = { ...goal.expected_yields },
      id = f.get("recipe_id");
    if (f.get("expected") === "") delete expected_yields[id];
    else expected_yields[id] = Number(f.get("expected"));
    await save("goal", { ...goal, expected_yields }, form);
  }
  if (form.id === "recipe-edit-form") {
    const data = structuredClone(fullCatalog),
      r = data.recipes.find((r) => r.recipe_id === $("#edit-recipe").value);
    Object.assign(r, {
      output_quantity: qty(f.get("output_quantity")),
      yield_type: f.get("yield_type"),
      method: f.get("method"),
      required_skill: f.get("required_skill") || null,
      verification: f.get("verification"),
      source_urls: [f.get("source")],
      source_kind: "user_checked",
      verified_at:
        f.get("verification") === "verified"
          ? new Date().toISOString().slice(0, 10)
          : null,
      verification_note: "사용자 확인: " + f.get("reason"),
    });
    for (const i of form.querySelectorAll("[data-recipe-input]")) {
      const input = r.inputs.find((v) => v.item_id === i.dataset.recipeInput);
      if (input.quantity !== qty(i.value)) delete input.alternatives;
      input.quantity = qty(i.value);
    }
    data.version = catalog.version + "+user-" + Date.now();
    r.data_version = data.version;
    const check = await api("/catalog/preview", data);
    if (check.errors.length) throw Error(check.errors.join(" / "));
    await save("catalog", { catalog: data }, form);
  }
}
document.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(event.target).catch(report);
});
document.addEventListener("input", (event) => {
  const f = event.target.closest("form[data-protect]");
  if (f) dirty.add(f);
  if (event.target.id === "plan-search")
    tree(plans.find((p) => p.goal_id === goal.goal_id));
  if (event.target.matches("[data-start-stock]")) startStocks.set(event.target.dataset.item, event.target.value);
  if (event.target.closest("#start-form") && (event.target.id === "track-inventory" || event.target.name === "calls" || event.target.matches("[data-start-stock]"))) {
    try {
      startPreview();
    } catch (error) {
      report(error);
    }
  }
});
document.addEventListener("change", async (event) => {
  try {
    const i = event.target,
      form = i.closest("form[data-protect]");
    if (form) dirty.add(form);
    if (i.id === "plan-filter")
      tree(plans.find((p) => p.goal_id === goal.goal_id));
    if (i.id === "assume-zero") {
      if (guard())
        await save("goal", { ...goal, assume_unknown_zero: i.checked });
    }
    if (i.id === "yield-recipe")
      $("#yield-form [name=expected]").value =
        goal.expected_yields?.[i.value] ?? "";
    if (i.id === "start-recipe") startIngredients();
    if (i.matches("[data-substitute]")) startPreview();
    if (i.id === "edit-recipe" && guard()) recipeEditor();
    if (i.id === "backup-file" && i.files[0] && guard()) {
      backup = JSON.parse(await i.files[0].text());
      const result = await api("/backup/preview", backup);
      $("#backup-preview").innerHTML =
        `<pre class="backup-preview">검증 완료: ${result.items}개 품목 / ${result.goals}개 목표 / ${result.jobs}개 작업\n데이터 ${esc(result.data_version)}</pre><p class="callout">현재 연금 데이터를 교체합니다. 복원 전 상태는 자동 백업합니다.</p><button type="button" class="danger" id="restore-backup">확인한 백업으로 복원</button>`;
    }
    if (i.id === "catalog-file" && i.files[0] && guard()) {
      fullCatalog = JSON.parse(await i.files[0].text());
      const result = await api("/catalog/preview", fullCatalog);
      $("#catalog-preview").innerHTML =
        `<p class="hint">${result.items}개 품목 / ${result.recipes}개 제작식 · ${esc(result.version)}</p>${result.errors.map((s) => `<p class="error-note">${esc(s)}</p>`).join("")}<button id="import-catalog" type="button" ${result.errors.length ? "disabled" : ""}>확인한 카탈로그 적용</button>`;
    }
  } catch (error) {
    report(error);
  }
});
document.addEventListener("click", async (event) => {
  const a = event.target.closest("a[href]");
  if (
    a &&
    !a.getAttribute("href").startsWith("#") &&
    a.target !== "_blank" &&
    hasDraft()
  ) {
    event.preventDefault();
    if (!(await leave())) return;
    dirty.clear();
    location.assign(a.href);
    return;
  }
  const b = event.target.closest("button");
  if (!b || b.type === "submit") return;
  try {
    if (b.matches("[data-close]") || b.id === "close-dialog") {
      if (await leave()) {
        dirty.clear();
        $("#work-dialog").close();
      }
      return;
    }
    if (b.id === "refresh") {
      if ((await leave()) && !pending) {
        dirty.clear();
        cache.clear();
        await load();
      }
      return;
    }
    if ((b.id === "retry" || b.id === "retry-start-stock") && pending) {
      const task = pending;
      await save(task.action, JSON.parse(task.signature).fields, task.keepStart ? $("#start-form") : [...dirty][0], task.keepStart);
      return;
    }
    if (b.id === "save-start-stock") {
      const changes = startStockChanges();
      if (!stockConflict && changes.length) await save("inventory", {changes}, $("#start-form"), true);
      return;
    }
    if (b.id === "reload-start-stock") {
      if (busy || pending) return;
      await load();
      startStocks.clear();
      stockConflict = false;
      startPreview();
      return;
    }
    if (b.dataset.start) {
      await startModal(
        b.dataset.start,
        b.dataset.recipe,
        Number(b.dataset.calls ?? 1),
      );
      return;
    }
    if (b.dataset.finish) {
      await finishModal(b.dataset.finish);
      return;
    }
    if (b.dataset.correct) {
      await finishModal(b.dataset.correct, true);
      return;
    }
    if (b.dataset.cancel) {
      if (
        guard() &&
        await confirmAction(
          "실제 제작을 전혀 진행하지 않았나요? 차감한 재료를 전부 반환합니다. 일부 제작했다면 결과 입력에서 수행 횟수를 입력하세요.",
        )
      )
        await save("cancel", { job_id: b.dataset.cancel });
      return;
    }
    if (b.dataset.adjust) {
      adjustModal(b.dataset.adjust);
      return;
    }
    if (b.dataset.delete) {
      if (
        guard() &&
        await confirmAction("목표를 삭제할까요? 실제 재고와 제작 기록은 유지합니다.")
      )
        await save("goal", { goal_id: b.dataset.delete, delete: true });
      return;
    }
    if (b.dataset.active) {
      if (!guard()) return;
      const g = state.goals.find((g) => g.goal_id === b.dataset.active);
      await save("goal", { ...g, active: !g.active });
      return;
    }
    if (b.dataset.selectRecipe) {
      if (guard()) {
        const r = detail.recipes.find(
          (r) => r.recipe_id === b.dataset.selectRecipe,
        );
        await save("goal", {
          ...goal,
          choices: { ...goal.choices, [r.output_item_id]: r.recipe_id },
          batch_policies: {
            ...goal.batch_policies,
            [r.output_item_id]: "manual",
          },
        });
      }
      return;
    }
    if (b.dataset.page) {
      if (!guard()) return;
      offset = Math.max(0, offset + 50 * Number(b.dataset.page));
      if (page === "inventory") await inventory();
      else await history();
      return;
    }
    if (b.id === "copy-shortages") {
      const materials = plans
        .find((p) => p.goal_id === goal.goal_id)
        .rows.filter((r) => !r.recipe_id && (r.missing !== 0 || r.unknown));
      await navigator.clipboard.writeText(
        materials
          .map(
            (r) =>
              r.name +
              "\t" +
              (r.missing == null ? "재고 확인 필요" : fmt(r.missing)),
          )
          .join("\n"),
      );
      status("부족 재료를 복사했습니다.", "success");
    }
    if (b.id === "export-backup")
      await download(
        "/backup",
        "BDO-alchemy-" + new Date().toISOString().slice(0, 10) + ".json",
      );
    if (b.id === "export-catalog")
      await download("/catalog?full=1", "BDO-alchemy-catalog.json");
    if (b.id === "edit-catalog") await editCatalog();
    if (
      b.id === "restore-backup" &&
      guard() &&
      await confirmAction("미리보기에서 확인한 연금 백업으로 복원할까요?")
    )
      await save("restore", { backup });
    if (
      b.id === "import-catalog" &&
      guard() &&
      await confirmAction("확인한 카탈로그를 적용할까요?")
    )
      await save("catalog", { catalog: fullCatalog });
  } catch (error) {
    report(error);
  }
});
$("#work-dialog").addEventListener("cancel", async (event) => {
  event.preventDefault();
  if (await leave()) { dirty.clear(); $("#work-dialog").close(); }
});
window.addEventListener("beforeunload", (event) => {
  if (hasDraft() || busy || pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    cache.clear();
    names.clear();
    icons.clear();
    state = null;
    plans = [];
    fullCatalog = null;
  }
});
load().catch((error) => {
  $("#content").setAttribute("aria-busy", "false");
  report(error);
});
