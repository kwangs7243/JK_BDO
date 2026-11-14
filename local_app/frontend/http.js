export async function requestJSON(path, options = {}) {
  const mutation = !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());
  const failure = (message, status, code, uncertain = mutation) => {
    const error = new Error(message);
    error.status = status; error.code = code; error.uncertain = uncertain;
    return error;
  };
  const controller = new AbortController();
  // Recognition workers can run for 300 seconds; allow their own timeout to respond first.
  const timeoutMs = options.timeoutMs ?? (/scan|recognition|batch/.test(path) ? 330000 : mutation ? 30000 : 20000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    let response;
    try { response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options, signal}); }
    catch {
      if (controller.signal.aborted) throw failure('응답 대기 시간이 지났습니다. 저장 요청은 결과를 확인하세요.', undefined, 'request_timeout');
      throw failure('로컬 서버에 연결하지 못했습니다. 저장 요청이었다면 결과를 재확인하세요.', undefined, 'connection_failed');
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw failure('서버 응답을 해석하지 못했습니다. 결과를 재확인하세요.', response.status, 'invalid_response'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw failure('서버 응답 형식이 올바르지 않습니다. 결과를 재확인하세요.', response.status, 'invalid_response');
    if (!response.ok) throw failure(payload.error?.message || `요청에 실패했습니다 (${response.status}).`, response.status, payload.error?.code, mutation && response.status === 500);
    return payload;
  } finally { clearTimeout(timer); }
}
