const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createTradeCaptureGallery({dialog, list, onRemove, signal}) {
  const gallery = element('section', 'trade-capture-gallery');
  gallery.hidden = true;
  gallery.setAttribute('aria-label', '캡처한 스크린샷');
  const caption = element('header', 'capture-gallery-caption');
  const notice = element('strong'), count = element('span');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  caption.append(notice, count); gallery.append(caption, list);
  dialog.querySelector('[data-role=capture-status]').after(gallery);
  const urls = new Map();
  let pending = false;
  list.addEventListener('click', event => {
    const remove = event.target.closest('[data-capture-remove]');
    if (remove && !pending) onRemove(remove.dataset.captureRemove);
  }, {signal});
  return {
    render(items, {recognizing=false, hasResult=false}={}) {
      if (signal.aborted) return;
      pending = recognizing;
      const scroll = list.scrollTop;
      const added = items.some(capture => !urls.has(capture.metadata.captureId));
      const present = new Set(items.map(capture => capture.metadata.captureId));
      for (const [id,url] of urls) if (!present.has(id)) {
        URL.revokeObjectURL(url); urls.delete(id);
      }
      for (const capture of items) if (!urls.has(capture.metadata.captureId)) {
        urls.set(capture.metadata.captureId, URL.createObjectURL(capture.blob));
      }
      dialog.dataset.captureStage = recognizing ? 'recognizing' : hasResult && !items.length ? 'review' : items.length ? 'ready' : 'empty';
      gallery.hidden = !items.length;
      gallery.classList.toggle('is-recognizing', recognizing);
      const latest = items.at(-1);
      notice.textContent = recognizing ? '인식 중' : latest?.metadata.sourceType === 'native-screen' ? 'F10 캡처 완료' : '준비된 스크린샷';
      count.textContent = `총 ${items.length}장`;
      list.replaceChildren();
      items.forEach((capture,index) => {
        const id = capture.metadata.captureId, row = element('li', 'capture-draft-item');
        row.dataset.captureId = id; row.dataset.status = 'TRADE_DRAFT'; row.dataset.batchId = capture.metadata.batchId ?? '';
        if (capture.regionEvidence) row.dataset.regionEvidence = JSON.stringify(capture.regionEvidence);
        row.classList.toggle('is-latest', index === items.length - 1);
        const preview = element('div', 'capture-draft-preview'), image = element('img', 'capture-draft-image');
        image.src = urls.get(id); image.alt = `${index+1}번째 물교 캡처 화면`; image.decoding = 'async'; preview.append(image);
        const footer = element('div', 'capture-draft-footer'), details = element('div', 'capture-draft-details');
        const source = capture.regionEvidence ? '선택 영역' : ({'native-screen':'게임 캡처',file:'파일',clipboard:'붙여넣기','browser-stream':'화면'}[capture.metadata.sourceType] ?? '이미지');
        details.append(element('strong', '', `${index+1}번째 캡처`), element('span', '', `${source} · ${capture.metadata.frame.width}×${capture.metadata.frame.height}`));
        const remove = element('button', '', '삭제');
        remove.type = 'button'; remove.dataset.captureRemove = id; remove.disabled = pending; remove.setAttribute('aria-label', '물교 캡처 이미지 제거');
        footer.append(details, remove); row.append(preview, footer); list.append(row);
      });
      list.scrollTop = added ? list.scrollHeight : scroll;
    },
    clear() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear(); list.replaceChildren(); gallery.hidden = true;
    },
    dispose() { this.clear(); gallery.remove(); },
  };
}
