import http from "node:http";

export async function postJson(urlString, body, options = {}) {
  const url = new URL(urlString);
  if (url.protocol !== "http:") {
    throw new Error("Only plain HTTP is supported");
  }

  const payload = JSON.stringify(body);

  const requestOptions = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || 80,
    path: `${url.pathname}${url.search}`,
    timeout: options.timeoutMs ?? 10_000,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    }
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolvePromise({});
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            rejectPromise(new Error(parsed.error ?? `HTTP ${res.statusCode}`));
            return;
          }
          resolvePromise(parsed);
        } catch (error) {
          rejectPromise(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", rejectPromise);
    req.end(payload);
  });
}
