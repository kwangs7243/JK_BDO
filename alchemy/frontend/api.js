import { requestJSON } from '/portal-assets/http.js';

export const api = (path, body) => requestJSON(`/api/alchemy${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: body === undefined ? {} : {'Content-Type': 'application/json'},
  body: body === undefined ? undefined : JSON.stringify(body),
});
