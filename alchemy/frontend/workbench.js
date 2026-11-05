let mountVersion = 0;
let disposePrevious = () => {};
let selected = null, quantity = 100, basis = 'calls', recent = [], search = '', browseAll = false;
try {
  const stored = JSON.parse(localStorage.getItem('alchemy-recent') || '[]');
  if (Array.isArray(stored)) recent = stored.filter(id => typeof id === 'string').slice(0, 12);
} catch {}

export async function workbench(host, ctx, initial) {
  disposePrevious();
  const mount = ++mountVersion;
  const {api, esc, fmt, jobs, report, inventory = {}} = ctx;
  const icon = (id, large = false) => ctx.icon(id, large).replace('class="item-icon', 'class="ico item-icon');
  const catalog = await api('/catalog?full=1');
  if (mount !== mountVersion || !host.isConnected) return;
  const craftable = new Set(catalog.recipes.map(r => r.output_item_id));
  const items = catalog.items.filter(i => craftable.has(i.item_id));
  const names = new Map(catalog.items.map(i => [i.item_id, i.name]));
  const name = id => names.get(id) ?? id;
  const defaults = new Map();
  for (const recipe of catalog.recipes) if (!defaults.has(recipe.output_item_id)) defaults.set(recipe.output_item_id, recipe);
  selected = initial || selected || recent.find(id => craftable.has(id)) || items[0]?.item_id;
  if (!craftable.has(selected)) selected = items[0]?.item_id;
  if (!selected) { host.textContent = '등록된 제작식이 없습니다.'; return; }

  host.innerHTML = `<div class="workshop-layout"><aside class="library"><div class="library-heading"><span>제작할 품목</span><span>${items.length}종</span></div><label class="searchbox"><span class="sr-only">제작할 품목 검색</span><input id="work-search" type="search" placeholder="오일·혈액·비약 검색" aria-label="제작할 품목 검색"></label><div class="library-caption">최근 사용</div><div id="work-items" class="catalog-rows"></div><button type="button" class="alchemy-catalog-toggle" aria-controls="work-items">전체 품목</button><div class="library-bottom"><span class="small-sigil" aria-hidden="true">✧</span><p>연금 작업대<small>제작하기 · 창고 · 기록</small></p></div></aside><section id="work-recipe" class="workshop"></section></div>`;
  const panel = host.querySelector('#work-recipe');
  let generation = 0, branchVersion = 0, cleanupDiagram = () => {}, current = null;
  const list = () => {
    const expanded = !!search || browseAll;
    host.querySelector('.library').classList.toggle('is-searching', expanded);
    const toggle = host.querySelector('.alchemy-catalog-toggle');
    toggle.textContent = browseAll ? '접기' : '전체 품목';
    toggle.setAttribute('aria-expanded', String(expanded));
    host.querySelector('#work-items').innerHTML = [...items].sort((a, b) => {
      const position = id => recent.includes(id) ? recent.indexOf(id) : 999;
      return position(a.item_id) - position(b.item_id);
    }).filter(i => [i.name, ...(i.aliases || [])].join(' ').replace(/\s/g, '').includes(search.replace(/\s/g, '')))
      .slice(0, expanded ? items.length : 4)
      .map(i => `<button type="button" data-work-item="${esc(i.item_id)}" aria-pressed="${i.item_id === selected}">${icon(i.item_id)}<span>${esc(i.name)}</span></button>`).join('');
  };
  host.querySelector('#work-search').value = search;
  host.querySelector('#work-search').oninput = e => { search = e.target.value; list(); };
  host.querySelector('.alchemy-catalog-toggle').onclick = () => { browseAll = !browseAll; list(); };

  let retired = false;
  const onPageHide = event => { if (!event.persisted) dispose(); };
  const dispose = () => {
    retired = true;
    cleanupDiagram();
    host.onclick = null;
    window.removeEventListener('pagehide', onPageHide);
  };
  disposePrevious = dispose;
  window.addEventListener('pagehide', onPageHide);

  async function branch(id) {
    const token = ++branchVersion, owner = generation;
    const detail = await api('/recipes/' + encodeURIComponent(id));
    if (retired || token !== branchVersion || owner !== generation || mount !== mountVersion || !panel.isConnected) return;
    const target = panel.querySelector('#work-branch');
    target.innerHTML = `<section class="recipe-detail"><div class="detail-heading"><h3>${esc(detail.item.name)} · 제작식</h3><button type="button" data-work-close>접기 ×</button></div>${detail.recipes.map(r => `<div class="branch-path"><p class="hint">${esc(r.method)} · ${r.output_quantity}개 단위</p><div class="detail-reagents">${r.inputs.map((i, index) => `${index ? '<i aria-hidden="true">+</i>' : ''}<span>${icon(i.item_id)}${esc(name(i.item_id))}<small>×${i.quantity}</small>${craftable.has(i.item_id) ? `<button type="button" class="branch-nested" data-work-prepare="${esc(i.item_id)}" aria-label="${esc(name(i.item_id))} 제작식 펼치기">↗</button>` : ''}</span>`).join('')}<i aria-hidden="true">→</i><span>${icon(id)}${esc(detail.item.name)}</span></div><div class="detail-actions"><span>1회 제작식 · 시작 창에서 횟수 확인</span><button type="button" data-start="${esc(id)}" data-recipe="${esc(r.recipe_id)}" ${r.verification !== 'verified' || r.update_conflict || detail.errors.some(v => v.recipe_id === r.recipe_id) ? 'disabled' : ''}>${esc(detail.item.name)} 제작 ↗</button></div></div>`).join('')}</section>`;
  }

  async function show(id) {
    const version = ++generation;
    const detail = await api('/recipes/' + encodeURIComponent(id));
    if (retired || version !== generation || mount !== mountVersion || !host.isConnected) return;
    cleanupDiagram(); branchVersion++;
    selected = id; recent = [id, ...recent.filter(v => v !== id)].slice(0, 12); list();
    try { localStorage.setItem('alchemy-recent', JSON.stringify(recent)); } catch {}
    panel.innerHTML = `<div class="workshop-heading"><div class="heading-item"><span class="title-icon">${icon(id, true)}</span><div><p class="eyebrow">이번 제작</p><h2 class="formula-title">${esc(detail.item.name)}</h2></div></div><div class="instrument-controls"><label class="field-label">수량 기준<select id="work-basis"><option value="calls">연금 횟수</option><option value="outputs">완성 수량</option></select></label><label class="field-label">제작 분량<span class="counter-instrument"><span class="ticks" aria-hidden="true"></span><button type="button" data-work-delta="-1" aria-label="제작 분량 줄이기">−</button><input id="work-quantity" type="number" min="1" max="1000000000" value="${quantity}" aria-label="이번 제작 분량"><button type="button" data-work-delta="1" aria-label="제작 분량 늘리기">+</button></span></label><label class="field-label">제작 경로<select id="work-path">${detail.recipes.map((r, index) => `<option value="${index}">${esc(r.method)} · ${r.output_quantity}개 단위</option>`).join('')}</select></label></div></div><nav id="work-recipe-path" class="recipe-path" aria-label="대표 준비 경로"></nav><p id="work-estimate" class="hint"></p><section class="formula" aria-labelledby="formula-title"><div class="formula-heading"><h3 id="formula-title">배합식</h3><span><i aria-hidden="true"></i>재료를 선택하면 준비량을 확인할 수 있습니다.</span></div><div class="formula-stage orbit-final"><svg class="connections" aria-hidden="true"><defs><linearGradient id="formula-metal"><stop offset="0" stop-color="#8e633a"/><stop offset="1" stop-color="#d7b471"/></linearGradient></defs><g class="link-paths"></g></svg><div id="work-materials" class="reagent-stations"></div><div class="result-station"><div class="result-orbit" aria-hidden="true"><span></span><i></i><b></b></div><div class="result-medallion">${icon(id, true)}</div><div class="result-copy"><span>완성품</span><strong>${esc(detail.item.name)}</strong><small class="result-count"></small></div></div><div id="work-start" class="start-group"></div></div><div class="focus-line" aria-live="polite"></div><div id="work-branch"></div></section><div class="workbench-actions"><details class="owned"><summary>이미 준비한 중간재 반영</summary><div id="work-owned-fields"></div><p class="hint">이번 준비량에만 반영합니다.</p></details></div>${jobs()}`;
    panel.querySelector('#work-basis').value = basis;
    const owned = new Map(), stage = panel.querySelector('.formula-stage');
    let focused = detail.recipes[0].inputs[0]?.item_id, calls = null, activeRecipe = detail.recipes[0], frame = 0, pulseTimer;
    let disposed = false;
    const requestDraw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const highlight = item => panel.querySelectorAll('.link-paths path').forEach(path => path.classList.toggle('active', path.dataset.input === item));
    function draw() {
      if (disposed || !stage.isConnected) return;
      const box = stage.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const group = panel.querySelector('.link-paths'); group.replaceChildren();
      stage.querySelector('svg').setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      const nodes = [...panel.querySelectorAll('button[data-work-input]')];
      if (box.width < 650) return;
      const angles = nodes.length === 1 ? [180] : nodes.length === 2 ? [180, 0] : nodes.length === 3 ? [-90, 30, 150] : nodes.length === 4 ? [-135, -45, 45, 135] : nodes.map((_, i) => -90 + i * 360 / nodes.length);
      const cx = box.width / 2, cy = 330;
      nodes.forEach((node, index) => {
        const a = angles[index] * Math.PI / 180, x = cx + Math.cos(a) * Math.min(box.width * .275, 385), y = cy + Math.sin(a) * 195;
        node.style.left = x + 'px'; node.style.top = y + 'px';
        node.classList.remove('orbit-left', 'orbit-right', 'orbit-top');
        node.classList.add(Math.abs(Math.cos(a)) < .1 ? 'orbit-top' : Math.cos(a) < 0 ? 'orbit-left' : 'orbit-right');
        const dx = x - cx, dy = y - cy, length = Math.hypot(dx, dy), ux = dx / length, uy = dy / length;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.dataset.input = node.dataset.workInput;
        path.setAttribute('d', `M${x - ux * 40},${y - uy * 40} L${cx + ux * 148},${cy + uy * 148}`);
        group.append(path);
      });
      highlight(focused);
    }
    const observer = new ResizeObserver(requestDraw);
    observer.observe(stage);
    cleanupDiagram = () => {
      disposed = true; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(pulseTimer);
      panel.oninput = null; panel.onpointerover = null; panel.onpointerleave = null; panel.onfocusin = null; panel.onfocusout = null;
    };
    panel.onpointerover = event => { const b = event.target.closest('[data-work-input]'); if (b) highlight(b.dataset.workInput); };
    panel.onpointerleave = () => highlight(focused);
    panel.onfocusin = event => { const b = event.target.closest('[data-work-input]'); if (b) highlight(b.dataset.workInput); };
    panel.onfocusout = () => highlight(focused);
    document.fonts.ready.then(() => { if (!disposed) requestDraw(); });

    function renderFocus() {
      const item = activeRecipe.inputs.find(i => i.item_id === focused); if (!item) return;
      const needed = calls === null ? null : item.quantity * calls, stock = inventory[focused] ?? null;
      const available = owned.has(focused) ? Number(owned.get(focused)) : stock;
      const extra = needed === null || available === null ? null : Math.max(0, needed - available);
      panel.querySelector('.focus-line').innerHTML = `<span class="focus-label">선택한 재료</span><span class="focus-name">${icon(focused)}${esc(name(focused))}</span><div class="focus-numbers"><span>필요<strong>${esc(fmt(needed))}</strong></span><span>보유<strong>${esc(fmt(stock))}</strong></span>${extra === null ? '' : `<span class="${extra ? 'short' : ''}">${owned.has(focused) ? '추가 준비' : '부족'}<strong>${fmt(extra)}</strong></span>`}</div>${craftable.has(focused) ? `<button type="button" data-work-prepare="${esc(focused)}">제작식 펼치기 ↗</button>` : ''}`;
      panel.querySelectorAll('button[data-work-input]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.workInput === focused)));
      highlight(focused);
    }
    function ownedFields() {
      panel.querySelector('#work-owned-fields').innerHTML = activeRecipe.inputs.filter(i => craftable.has(i.item_id)).map(i => `<label>${esc(name(i.item_id))}<input type="number" min="0" max="1000000000" data-work-owned="${esc(i.item_id)}" value="${esc(owned.get(i.item_id) ?? '')}" placeholder="수량"></label>`).join('');
      panel.querySelector('.owned').hidden = !activeRecipe.inputs.some(i => craftable.has(i.item_id));
    }
    function path() {
      const ids = [id], seen = new Set(ids); let recipe = activeRecipe;
      while (recipe) {
        const middle = recipe.inputs.find(i => craftable.has(i.item_id) && !seen.has(i.item_id));
        if (!middle) break;
        ids.unshift(middle.item_id); seen.add(middle.item_id); recipe = defaults.get(middle.item_id);
      }
      panel.querySelector('#work-recipe-path').innerHTML = ids.map((item, index) => `${index ? '<span aria-hidden="true">›</span>' : ''}<button type="button" data-work-prepare="${esc(item)}" class="${item === id ? 'active' : ''}">${icon(item)}${esc(name(item))}</button>`).join('');
    }
    function calculate() {
      quantity = Number(panel.querySelector('#work-quantity').value); basis = panel.querySelector('#work-basis').value;
      activeRecipe = detail.recipes[Number(panel.querySelector('#work-path').value)];
      const history = detail.yield_history?.[activeRecipe.recipe_id];
      const average = activeRecipe.yield_type === 'fixed' ? activeRecipe.output_quantity : history?.total_calls > 0 ? history.total_output / history.total_calls : null;
      const valid = Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 1e9;
      calls = valid ? basis === 'calls' ? quantity : average > 0 ? Math.ceil(quantity / average) : null : null;
      if (calls !== null && (!Number.isSafeInteger(calls) || calls > 1e9 || activeRecipe.inputs.some(i => !Number.isSafeInteger(i.quantity * calls)))) calls = null;
      panel.querySelector('#work-estimate').textContent = !valid ? '1~10억 사이 정수를 입력하세요.' : basis === 'outputs' && calls === null ? '이 제작식의 실측 수율이 없습니다. 연금 횟수로 입력하거나 제작 결과를 먼저 기록하세요.' : `${fmt(calls)}회 투입 재료${activeRecipe.yield_type === 'fixed' ? ` · 고정 산출 ${fmt(calls * average)}개` : average > 0 ? ` · 기록 평균 기준 예상 산출 ${fmt(calls * average)}개` : ' · 산출량은 제작 후 실제 수량으로 기록'}`;
      if (!activeRecipe.inputs.some(i => i.item_id === focused)) focused = activeRecipe.inputs[0]?.item_id;
      panel.querySelector('#work-materials').innerHTML = activeRecipe.inputs.map(i => `<button type="button" class="reagent-station" data-work-input="${esc(i.item_id)}" aria-pressed="${i.item_id === focused}" aria-label="${esc(name(i.item_id))} 준비량 보기"><span class="reagent-seal">${icon(i.item_id)}</span><span class="station-copy"><strong>${esc(name(i.item_id))}</strong><small>1회 ${i.quantity}개</small><span class="station-count">${calls === null ? '—' : fmt(i.quantity * calls)}<small>개</small></span></span></button>`).join('');
      panel.querySelector('.result-count').textContent = calls === null ? '횟수 확인 필요' : activeRecipe.yield_type === 'fixed' ? `고정 산출 ${fmt(calls * average)}개` : '실제 산출량은 완료 시 입력';
      panel.querySelector('#work-start').innerHTML = calls === null ? '' : `<span>${fmt(calls)}회 제작</span><button type="button" class="primary start-button" data-start="${esc(id)}" data-recipe="${esc(activeRecipe.recipe_id)}" data-calls="${calls}" ${activeRecipe.verification !== 'verified' || activeRecipe.update_conflict || detail.errors.some(v => v.recipe_id === activeRecipe.recipe_id) ? 'disabled' : ''}>제작 시작<span aria-hidden="true">→</span></button>`;
      renderFocus(); path(); requestDraw();
    }
    current = {focus(item) { focused = item; renderFocus(); }};
    panel.oninput = event => {
      if (event.target.dataset.workOwned) {
        if (!event.target.checkValidity()) return;
        if (event.target.value === '') owned.delete(event.target.dataset.workOwned);
        else owned.set(event.target.dataset.workOwned, event.target.value);
        renderFocus(); return;
      }
      if (event.target.id === 'work-path') {
        activeRecipe = detail.recipes[Number(event.target.value)]; ownedFields();
        branchVersion++; panel.querySelector('#work-branch').replaceChildren();
      }
      calculate();
      if (!matchMedia('(prefers-reduced-motion:reduce)').matches) {
        stage.classList.remove('pulse'); void stage.offsetWidth; stage.classList.add('pulse');
        clearTimeout(pulseTimer); pulseTimer = setTimeout(() => stage.classList.remove('pulse'), 650);
      }
    };
    ownedFields(); calculate();
  }

  host.onclick = async event => {
    try {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.workItem) {
        search = ''; browseAll = false; host.querySelector('#work-search').value = '';
        await show(button.dataset.workItem);
      }
      if (button.dataset.workDelta) {
        const input = panel.querySelector('#work-quantity'), value = Number(input.value);
        input.value = String(Math.max(1, Math.min(1e9, (Number.isSafeInteger(value) ? value : 1) + Number(button.dataset.workDelta))));
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
      if (button.dataset.workInput) current?.focus(button.dataset.workInput);
      if (button.dataset.workPrepare) await branch(button.dataset.workPrepare);
      if (button.hasAttribute('data-work-close')) { branchVersion++; panel.querySelector('#work-branch').replaceChildren(); }
    } catch (error) { report(error); }
  };
  await show(selected);
}
