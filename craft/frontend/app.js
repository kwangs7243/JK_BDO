import { notice } from "/portal-assets/feedback.js";
import { calculate } from "./calculator.js";

const $ = selector => document.querySelector(selector);
const fmt = value => value === null ? "미확인" : Number(value).toLocaleString("ko-KR");
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
let items = [], categories = {}, inventory = {}, preferences = {revision:0, favorites:[]};
let current = null, recipeIndex = 0, category = "all", favoritesOnly = false, visible = 36, loading = 0;
let expansions = {}, owned = {}, lastPlan = null, navigation = [], favoritePending = false;
const cache = new Map();
const status = (message, kind = "info") => { $("#status").textContent = message; if (message && kind === "error") notice(message, kind); };
async function api(path, options = {}) {
  const response = await fetch(`/api/craft/${path}`, { credentials:"same-origin", ...options });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message || "자료를 불러오지 못했습니다.");
  return data;
}
function picture(src, alt = "") {
  const image = el("img"); image.src = src || "/craft/assets/item.svg"; image.alt = alt; image.loading = "lazy";
  image.addEventListener("error", () => { image.src = "/craft/assets/item.svg"; }, {once:true});
  return image;
}
function button(text, handler, cls) { const node = el("button", cls, text); node.type = "button"; node.addEventListener("click", handler); return node; }
function renderList() {
  const term = $("#search").value.replace(/\s+/g, "").toLocaleLowerCase();
  const filtered = items.filter(item => (category === "all" || item.categories.includes(category))
    && (!favoritesOnly || preferences.favorites.includes(item.id)) && item.name.replace(/\s+/g, "").toLocaleLowerCase().includes(term));
  $("#result-count").textContent = `${fmt(filtered.length)}개 품목`;
  const list = $("#items"); list.replaceChildren();
  for (const item of filtered.slice(visible - 36, visible)) {
    const row = button("", () => void selectItem(item.id), "item-row"); row.setAttribute("aria-current", String(current?.id === item.id));
    row.dataset.itemId = item.id;
    const text = el("span"); text.append(el("strong", "", item.name), el("small", "", item.categories.map(key => categories[key]).join(" · ")));
    row.append(picture(item.icon), text); list.append(row);
  }
  if (!filtered.length) list.append(el("p", "calculation-hint", "검색 결과가 없습니다. 다른 이름이나 분류를 선택하세요."));
  $("#more").hidden = filtered.length <= visible;
  $("#previous").disabled = visible <= 36;
}
async function getItem(id) {
  if (cache.has(id)) return cache.get(id);
  const value = await api(`items/${encodeURIComponent(id)}`);
  cache.set(id, value);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return value;
}
async function selectItem(id, backward = false) {
  const request = ++loading; status("제작 정보를 불러오는 중입니다…");
  try {
    const item = await getItem(id);
    if (request !== loading) return;
    if (current && !backward && current.id !== id) navigation = [...navigation.slice(-19), current.id];
    current = item; recipeIndex = 0; expansions = {}; owned = {};
    $("#count").value = "1"; $("#use-stock").checked = false; $("#expansion").hidden = true;
    const url = new URL(location.href); url.searchParams.set("item", id); history.replaceState(null, "", url);
    $("#welcome").hidden = true; $("#detail").hidden = false;
    $("#item-name").textContent = item.name;
    $("#hero-icon").replaceChildren(picture(item.icon));
    $("#item-category").textContent = items.find(entry => entry.id === id)?.categories.map(key => categories[key]).join(" / ") || "제작 재료";
    $("#description").textContent = item.description;
    $("#source").href = item.source;
    $("#data-date").textContent = `자료 확인 ${String(item.sourceFetchedAt || item.fetchedAt).slice(0,10)}`;
    $("#recipe-count").textContent = item.recipes.length ? `${item.recipes.length}가지 제작 방법` : "획득 방법 확인";
    $("#recipe-area").hidden = false; $("#recipe-area").classList.toggle("without-recipe", !item.recipes.length); $("#no-recipe").hidden = !!item.recipes.length;
    $("#back").disabled = !navigation.length;
    renderRecipes(); renderFavorite(); renderList(); renderCalculation(); renderRelated(); status("");
  } catch (error) { if (request === loading) status(error.message, "error"); }
}
function renderRecipes() {
  const list = $("#recipes"); list.replaceChildren();
  if (current.recipes.length > 6) {
    const select=el("select", "recipe-select"); select.setAttribute("aria-label", "제작 방법 선택");
    current.recipes.forEach((recipe,index)=>{const option=el("option","",recipeLabel(recipe,index));option.value=index;select.append(option);});
    select.value=recipeIndex;
    select.addEventListener("change",()=>{recipeIndex=Number(select.value);expansions={};$("#expansion").hidden=true;renderCalculation();});
    list.append(select); return;
  }
  current.recipes.forEach((recipe, index) => {
    const same = current.recipes.filter(other => other.method === recipe.method).length;
    const node = button(`${recipe.method}${same > 1 ? ` · 경로 ${index+1}` : ""}`, () => {
      recipeIndex = index; expansions = {}; $("#expansion").hidden = true; renderRecipes(); renderCalculation();
    });
    node.setAttribute("aria-pressed", String(index === recipeIndex)); list.append(node);
  });
}
function recipeLabel(recipe,index) {
  return `${recipe.method} · ${recipe.inputs.slice(0,2).map(input=>`${input.name} ×${fmt(input.quantity)}`).join(" + ")}${recipe.inputs.length>2 ? ` 외 ${recipe.inputs.length-2}종`:""} (${index+1})`;
}
function renderFavorite() {
  const active = preferences.favorites.includes(current.id);
  $("#favorite").textContent = active ? "★" : "☆";
  $("#favorite").setAttribute("aria-pressed", String(active));
  $("#favorite").setAttribute("aria-label", active ? "즐겨찾기 해제" : "즐겨찾기 추가");
}
function renderRelated() {
  const related = [...new Map(current.related.map(item => [item.id,item])).values()];
  $("#related-area").hidden = !related.length;
  let page = 0;
  function render() {
    const host = $("#related"); host.replaceChildren();
    for (const item of related.slice(page*12,page*12+12)) host.append(button(item.name,()=>void selectItem(item.id)));
    if (related.length > 12) {
      const controls = el("div", "related-pages");
      const previous = button("← 이전",()=>{page--;render();}), next = button("다음 →",()=>{page++;render();});
      previous.disabled = page===0; next.disabled = (page+1)*12>=related.length;
      controls.append(previous,el("span","",`${page*12+1}–${Math.min((page+1)*12,related.length)} / ${related.length}개`),next);host.append(controls);
    }
  }
  render();
}
function stockFor(id) { return Object.hasOwn(owned,id) ? owned[id] : inventory[id] ?? null; }
function renderCalculation() {
  const countValue = Number($("#count").value);
  for (const preset of document.querySelectorAll("[data-count]")) {
    preset.setAttribute("aria-pressed", String(Number.isSafeInteger(countValue) && countValue > 0 && Number(preset.dataset.count) === countValue));
  }
  const recipe = current?.recipes[recipeIndex]; if (!recipe) return;
  let plan;
  try { plan = calculate(recipe, Number($("#count").value), expansions, $("#use-stock").checked ? {...inventory, ...owned} : {}); }
  catch (error) {
    lastPlan = null; $("#copy").disabled = true;
    $("#materials").replaceChildren(el("p", "calculation-hint", "유효한 제작 횟수를 입력하면 재료를 계산합니다."));
    $("#shopping-list").replaceChildren(); $("#material-count").textContent = "—";
    status(error.message, "error"); return;
  }
  lastPlan = plan; $("#copy").disabled = false; status("");
  $("#material-count").textContent = `${plan.rows.length}종`;
  const materials = $("#materials"); materials.replaceChildren();
  for (const row of plan.rows) {
    const card = el("section", "material"), top = el("div", "material-top"), text = el("div");
    text.append(button(row.name, () => void selectItem(row.id), "item-link"), el("span", "unit", row.expanded ? `하위 제작 ${fmt(row.batches)}회` : `필요 총량 ${fmt(row.total)}개`));
    const amount = el("span", "amount", fmt(row.need)); if (row.need !== null) amount.append(el("small", "", "개"));
    top.append(picture(row.icon), text, amount);
    const bottom = el("div", "material-bottom"), stock = el("label", "", "보유 ");
    const input = el("input", "owned-input"); input.type = "number"; input.min = "0"; input.step = "1";
    input.placeholder = Object.hasOwn(inventory, row.id) ? "미확인" : "미등록"; input.value = stockFor(row.id) ?? "";
    input.setAttribute("aria-label", `${row.name} 계산용 보유량`);
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!input.value.trim()) delete owned[row.id];
      else if (!Number.isSafeInteger(value) || value < 0) { status("보유량은 0 이상의 정수로 입력하세요."); return; }
      else owned[row.id] = value;
      $("#use-stock").checked = true; renderCalculation();
    });
    stock.append(input);
    const action = button(row.expanded ? "하위 제작 접기 −" : "하위 제작 펼치기 +", () => {
      if (row.expanded) { delete expansions[row.id]; $("#expansion").hidden = true; renderCalculation(); }
      else void openExpansion(row);
    }, "expand-button");
    bottom.append(stock, action); card.append(top, bottom); materials.append(card);
  }
  const shopping = $("#shopping-list"); shopping.replaceChildren();
  for (const row of plan.leaves) {
    const node = el("div", "shopping-row");
    node.append(el("span", "", row.name));
    if ($("#use-stock").checked && row.owned === null) node.append(el("small", "", "보유 미확인 · 필요 총량"));
    node.append(el("span", "quantity", row.need === null ? "수량 확인 필요" : `${fmt(row.need)}개`)); shopping.append(node);
  }
}
async function openExpansion(row) {
  const selected = current.id; status(`${row.name}의 제작 정보를 불러오는 중입니다…`);
  try {
    const item = await getItem(row.id); if (current.id !== selected) return;
    const host = $("#expansion"); host.replaceChildren(); host.hidden = false;
    host.append(el("h4", "", `${row.name} · 하위 제작`));
    if (!item.recipes.length) { host.append(el("p", "", "수량이 있는 하위 제작식이 없습니다. 이 재료는 직접 준비해 주세요.")); status(""); return; }
    const select = el("select"); select.setAttribute("aria-label", "하위 제작 방법");
    item.recipes.forEach((recipe,index) => { const option=el("option", "", recipeLabel(recipe,index)); option.value=index; select.append(option); });
    const label = el("label", "", "1회 산출 기준 "), input = el("input"); input.type="number"; input.min="0.01"; input.step="0.01"; input.placeholder="입력"; input.setAttribute("aria-label", "하위 제작 1회 산출 기준"); label.append(input);
    const apply = button("계산에 반영", () => {
      const value = Number(input.value);
      const candidate = {...expansions, [row.id]:{recipe:item.recipes[Number(select.value)], yield:value}};
      try { calculate(current.recipes[recipeIndex], Number($("#count").value), candidate, $("#use-stock").checked ? {...inventory,...owned}:{}); }
      catch (error) { status(error.message, "error"); return; }
      expansions=candidate; host.hidden=true; renderCalculation();
    }, "primary");
    host.append(select,label,apply,el("p", "", "원본에 1회 산출량이 없어 직접 입력합니다. 요리·연금·가공의 실제 산출량은 달라질 수 있습니다. 원재료 보유분은 전체 계산에서 한 번만 반영합니다.")); status("");
  } catch (error) { status(error.message, "error"); }
}
$("#search").addEventListener("input", () => { visible=36; renderList(); });
$("#more").addEventListener("click", () => { visible+=36; renderList(); $("#items").scrollTop=0; });
$("#previous").addEventListener("click", () => { visible=Math.max(36,visible-36); renderList(); $("#items").scrollTop=0; });
$("#favorites-only").addEventListener("click", event => { favoritesOnly=!favoritesOnly; event.currentTarget.setAttribute("aria-pressed",String(favoritesOnly)); visible=36; renderList(); });
$("#back").addEventListener("click", () => { const id=navigation.pop(); if(id) void selectItem(id,true); });
$("#count").addEventListener("input", renderCalculation);
$("#minus").addEventListener("click", () => { $("#count").value=Math.max(1,Number($("#count").value)-1); renderCalculation(); });
$("#plus").addEventListener("click", () => { $("#count").value=Math.min(1_000_000,Number($("#count").value)+1); renderCalculation(); });
$("#use-stock").addEventListener("change", renderCalculation);
for (const node of document.querySelectorAll("[data-count]")) node.addEventListener("click", () => { $("#count").value=node.dataset.count; renderCalculation(); });
for (const node of document.querySelectorAll("[data-start]")) node.addEventListener("click", () => void selectItem(node.dataset.start));
$("#refresh-stock").addEventListener("click", async () => {
  try { const data=await api("bootstrap"); inventory=data.inventory; preferences=data.preferences; renderCalculation(); if(current) renderFavorite(); renderList(); status("공유 재고를 다시 불러왔습니다."); }
  catch(error) { status(error.message, "error"); }
});
$("#favorite").addEventListener("click", async () => {
  if(favoritePending || !current) return; favoritePending=true; $("#favorite").disabled=true;
  try {
    const id=current.id, favorites=preferences.favorites.includes(id) ? preferences.favorites.filter(key=>key!==id) : [...preferences.favorites,id];
    preferences=await api("preferences",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:preferences.revision,favorites})});
    renderFavorite(); renderList(); status("즐겨찾기를 저장했습니다.");
  } catch(error) { status(error.message, "error"); }
  finally { favoritePending=false; $("#favorite").disabled=false; }
});
$("#copy").addEventListener("click", async () => {
  if(!lastPlan) return;
  const text=[`${current.name} · ${fmt(Number($("#count").value))}회 제작`,...lastPlan.leaves.map(row=>`${row.name}\t${row.need===null ? '수량 확인 필요':row.need}`)].join("\n");
  try { await navigator.clipboard.writeText(text); status("준비할 재료 목록을 복사했습니다."); } catch { status("복사 권한을 확인해 주세요."); }
});
document.addEventListener("keydown", event => { if(event.key==="/" && !event.target.closest("input,textarea,select")) { event.preventDefault(); $("#search").focus(); } });
try {
  const [catalog, data]=await Promise.all([api("catalog"),api("bootstrap")]); items=catalog.items; categories=catalog.categories; inventory=data.inventory; preferences=data.preferences;
  for (const [id,name] of [["all","전체"],...Object.entries(categories)]) {
    const node=button(name,()=>{category=id;visible=36;for(const child of $("#categories").children) child.setAttribute("aria-pressed",String(child===node));renderList();}); node.setAttribute("aria-pressed",String(id==="all")); $("#categories").append(node);
  }
  renderList();
  const initial=new URL(location.href).searchParams.get("item"); if(initial && /^\d{1,10}$/.test(initial)) void selectItem(initial);
} catch(error) { status(error.message, "error"); }
