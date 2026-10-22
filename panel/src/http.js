// POST JSON. On the panel this goes through the native bridge (no CORS: the
// WebView page and the Music Assistant server are different origins); in a
// browser it falls back to fetch().

export function httpPostJson(url, body) {
  const N = window.ARNative;
  if (N && typeof N.httpPost === "function") {
    return new Promise((resolve, reject) => {
      const id = "h" + Math.random().toString(16).slice(2);
      window.__arHttp = window.__arHttp || {};
      window.__arHttp[id] = (status, text) => {
        delete window.__arHttp[id];
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          /* not json */
        }
        if (status < 0) reject(new Error(text || "network error"));
        else resolve({ status, json });
      };
      N.httpPost(id, url, JSON.stringify(body));
    });
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) =>
    r
      .json()
      .catch(() => null)
      .then((json) => ({ status: r.status, json })),
  );
}
