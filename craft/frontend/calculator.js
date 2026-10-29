const MAX = Number.MAX_SAFE_INTEGER;
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function calculate(recipe, count, expansions = {}, owned = {}) {
  if (!integer(count) || count < 1 || count > 1_000_000) throw Error("제작 횟수는 1~1,000,000 사이의 정수로 입력하세요.");
  const graph = new Map(), visited = new Set(), visiting = new Set(), order = [], metadata = new Map();
  function visit(id, depth = 0) {
    if (visiting.has(id)) throw Error("같은 재료로 되돌아오는 제작 경로입니다. 하위 제작 선택을 변경하세요.");
    if (depth > 16 || visited.size > 250) throw Error("하위 제작은 16단계, 250개 품목까지 펼칠 수 있습니다.");
    if (visited.has(id)) return;
    visiting.add(id);
    const expansion = expansions[id];
    if (expansion) {
      if (!Number.isFinite(expansion.yield) || expansion.yield <= 0 || expansion.yield > 1_000_000) throw Error("하위 제작의 1회 산출 기준을 입력하세요.");
      graph.set(id, expansion);
      for (const child of expansion.recipe.inputs) { metadata.set(child.id, child); visit(child.id, depth + 1); }
    }
    visiting.delete(id); visited.add(id); order.push(id);
  }
  for (const child of recipe.inputs) { metadata.set(child.id, child); visit(child.id); }
  const demands = new Map(), unknown = new Set();
  function add(input, batches) {
    if (batches === 0) return;
    if (!integer(input.quantity) || input.quantity < 1) { unknown.add(input.id); return; }
    const total = (demands.get(input.id) || 0) + input.quantity * batches;
    if (!integer(total) || total > MAX) throw Error("계산 가능한 수량 범위를 초과했습니다.");
    demands.set(input.id, total);
  }
  recipe.inputs.forEach(input => add(input, count));
  const rows = [];
  for (const id of order.reverse()) {
    const total = unknown.has(id) ? null : demands.get(id) || 0;
    const stock = Object.hasOwn(owned, id) && integer(owned[id]) ? owned[id] : null;
    const need = total === null ? null : Math.max(0, total - (stock ?? 0));
    const expansion = graph.get(id);
    let batches = null;
    if (expansion && need !== null) {
      batches = Math.ceil(need / expansion.yield);
      expansion.recipe.inputs.forEach(input => add(input, batches));
    } else if (expansion) {
      expansion.recipe.inputs.forEach(input => unknown.add(input.id));
    }
    rows.push({ ...metadata.get(id), total, owned: stock, need, batches, expanded: !!expansion });
  }
  return { rows, leaves: rows.filter(row => !row.expanded), unknown: rows.filter(row => row.need === null) };
}
