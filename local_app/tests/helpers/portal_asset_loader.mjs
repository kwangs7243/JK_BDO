const shared = new URL('../../frontend/http.js', import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === '/portal-assets/http.js' ? shared : specifier, context);
}
