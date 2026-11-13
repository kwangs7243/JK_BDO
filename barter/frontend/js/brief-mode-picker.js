export function initBriefModePicker(select) {
  const button = document.createElement('button'); button.type = 'button'; button.id = 'brief-mode-trigger'; button.className = 'brief-mode-button';
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'brief-mode-options'); button.setAttribute('aria-label', '교역 모드');
  const popup = document.createElement('div'); popup.id = 'brief-mode-options'; popup.className = 'brief-mode-options'; popup.setAttribute('popover', 'auto'); popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', '교역 모드 선택');
  select.hidden = true; select.after(button); document.body.append(popup);
  const opened = () => popup.matches(':popover-open');
  function sync() {
    button.textContent = select.selectedOptions[0]?.textContent ?? '교역 모드 선택'; button.disabled = select.disabled;
    for (const option of popup.children) option.setAttribute('aria-selected', String(option.dataset.mode === select.value));
    if (button.disabled && opened()) popup.hidePopover();
  }
  function close(focus = false) { if (opened()) popup.hidePopover(); button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
  function open() {
    if (select.disabled || opened()) return;
    popup.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement('button'); item.type = 'button'; item.tabIndex = -1; item.setAttribute('role', 'option'); item.dataset.mode = option.value; item.textContent = option.textContent; item.disabled = option.disabled;
      item.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', {bubbles:true})); sync(); close(true); }); popup.append(item);
    }
    sync(); const rect = button.getBoundingClientRect(), scale = Number(getComputedStyle(document.body).zoom) || 1;
    const width = Math.min(Math.max(rect.width, 265), innerWidth - 24), below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const height = Math.min(select.options.length * 38 + 16, Math.max(below, above), 380), up = below < height && above > below;
    popup.style.width = `${width / scale}px`; popup.style.maxHeight = `${height / scale}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12)) / scale}px`;
    popup.style.top = `${(up ? rect.top - height - 6 : rect.bottom + 6) / scale}px`;
    popup.showPopover(); button.setAttribute('aria-expanded', 'true');
    (popup.querySelector('[aria-selected=true]') ?? popup.firstElementChild)?.focus({preventScroll:true});
  }
  button.addEventListener('click', () => opened() ? close() : open());
  button.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault();open();} });
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') {event.preventDefault();close(true);return;}
    if (event.key === 'Tab') {
      event.preventDefault(); close();
      const controls = [...document.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(n => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length && !popup.contains(n));
      (controls[controls.indexOf(button) + (event.shiftKey ? -1 : 1)] ?? button).focus(); return;
    }
    const items = [...popup.children].filter(item => !item.disabled), index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined && items.length) {event.preventDefault();items[next].focus();}
  });
  popup.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
  addEventListener('resize', () => close());
  select.addEventListener('change', sync); sync(); return {sync};
}
