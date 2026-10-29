const stylePath = '/portal-assets/feedback.css';
if (!document.querySelector('link[data-suite-feedback]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = stylePath; link.dataset.suiteFeedback = '';
  document.head.append(link);
}

let questions = Promise.resolve();
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

function question(message, options, inputValue) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = node('dialog', 'suite-feedback');
    dialog.dataset.kind = options.danger ? 'danger' : 'question';
    const form = node('form', 'suite-feedback-form');
    form.method = 'dialog';
    const emblem = node('span', 'suite-feedback-emblem', options.danger ? '!' : '✧');
    emblem.setAttribute('aria-hidden', 'true');
    const heading = node('h2', '', options.title || (inputValue === undefined ? '확인' : '입력'));
    heading.id = 'suite-feedback-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const copy = node('p', 'suite-feedback-message', String(message));
    copy.id = 'suite-feedback-message';
    dialog.setAttribute('aria-describedby', copy.id);
    form.append(emblem, heading, copy);
    let input;
    if (inputValue !== undefined) {
      const label = node('label', 'suite-feedback-field', options.label || '입력값');
      input = node(options.multiline ? 'textarea' : 'input');
      if (!options.multiline) input.type = 'text';
      input.value = String(inputValue ?? '');
      input.autocomplete = 'off';
      if (options.multiline) input.rows = 4;
      label.append(input); form.append(label);
    }
    const actions = node('div', 'suite-feedback-actions');
    const cancel = node('button', 'suite-feedback-cancel', options.cancelLabel || '취소');
    cancel.type = 'button';
    const accept = node('button', 'suite-feedback-accept', options.acceptLabel || '확인');
    accept.type = 'submit';
    actions.append(cancel, accept); form.append(actions); dialog.append(form);
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      const value = input ? (accepted ? input.value : null) : accepted;
      dialog.close();
      const parent = [...document.querySelectorAll('dialog:modal')].at(-1) || document.body;
      for (const host of dialog.querySelectorAll(':scope > .suite-toasts, :scope > .app-notices')) {
        host.hidePopover(); parent.append(host);
        if (host.childElementCount) host.showPopover();
      }
      dialog.remove();
      if (previous?.isConnected) previous.focus({preventScroll:true});
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    form.addEventListener('submit', event => { event.preventDefault(); finish(true); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => { if (!settled) finish(false); });
    document.body.append(dialog);
    dialog.showModal();
    // Destructive choices default to Cancel; text entry retains normal Enter-to-submit.
    if (input) { input.focus(); input.select(); } else cancel.focus();
  });
}

function enqueue(message, options, inputValue) {
  const result = questions.then(() => question(message, options, inputValue));
  questions = result.catch(() => {});
  return result;
}

export const confirmAction = (message, options = {}) => enqueue(message, options);
export const requestText = (message, value = '', options = {}) => enqueue(message, options, value);

let toastHost;
function alignToastHost() {
  if (!toastHost?.isConnected || !toastHost.childElementCount) return;
  const parent = [...document.querySelectorAll('dialog:modal')].at(-1) || document.body;
  if (toastHost.parentElement !== parent) { toastHost.hidePopover(); parent.append(toastHost); }
  if (!toastHost.matches(':popover-open')) toastHost.showPopover();
}
new MutationObserver(alignToastHost).observe(document.documentElement, {subtree:true, attributes:true, attributeFilter:['open']});
const labels = {info:'안내', success:'완료', warning:'확인 필요', error:'처리하지 못했습니다'};
export function notice(message, kind = 'info') {
  if (window.BDONotifications) return window.BDONotifications.notice(message, kind);
  if (!toastHost?.isConnected) {
    toastHost = node('section', 'suite-toasts');
    toastHost.setAttribute('popover', 'manual');
    toastHost.setAttribute('aria-label', '작업 알림');
    document.body.append(toastHost);
  }
  const parent = [...document.querySelectorAll('dialog:modal')].at(-1) || document.body;
  if (toastHost.parentElement !== parent) { toastHost.hidePopover(); parent.append(toastHost); }
  const toast = node('article', 'suite-toast'); toast.dataset.kind = kind;
  toast.setAttribute('role', kind === 'error' || kind === 'warning' ? 'alert' : 'status');
  const symbol = node('span', 'suite-toast-symbol', kind === 'success' ? '✓' : kind === 'info' ? 'i' : '!');
  symbol.setAttribute('aria-hidden', 'true');
  const text = node('div'); text.append(node('strong', '', labels[kind] || labels.info), node('p', '', String(message)));
  const close = node('button', 'suite-toast-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '알림 닫기');
  let timer;
  const dismiss = () => { clearTimeout(timer); toast.remove(); if (!toastHost.childElementCount) toastHost.hidePopover(); };
  close.addEventListener('click', dismiss); toast.append(symbol, text, close);
  while (toastHost.childElementCount >= 4) toastHost.firstElementChild.querySelector('button').click();
  toastHost.append(toast); alignToastHost();
  if (kind === 'success' || kind === 'info') timer = setTimeout(dismiss, 5500);
  return dismiss;
}
