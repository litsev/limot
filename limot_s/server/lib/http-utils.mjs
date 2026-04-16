import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

export async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error.message}`);
  }
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(body);
}

export function sendText(res, statusCode, text, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-length": Buffer.byteLength(text),
    "content-type": "text/plain; charset=utf-8",
    ...extraHeaders
  });
  res.end(text);
}

export async function serveStaticFile(res, rootDir, requestPath) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const normalizedPath = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(rootDir, `.${normalizedPath}`);

  if (!filePath.startsWith(resolve(rootDir))) {
    sendText(res, 403, "Forbidden");
    return false;
  }

  try {
    const fileStat = await stat(filePath);
    const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";

    res.writeHead(200, {
      "cache-control": "no-store",
      "content-length": fileStat.size,
      "content-type": type
    });

    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

export function parseTimeRange(searchParams, defaultHours = 24) {
  const to = searchParams.get("to")
    ? new Date(searchParams.get("to"))
    : new Date();
  const from = searchParams.get("from")
    ? new Date(searchParams.get("from"))
    : new Date(to.getTime() - defaultHours * 60 * 60 * 1000);
  const points = Number.parseInt(searchParams.get("points") ?? "480", 10);

  return {
    from: Number.isNaN(from.getTime()) ? new Date(Date.now() - defaultHours * 60 * 60 * 1000) : from,
    to: Number.isNaN(to.getTime()) ? new Date() : to,
    points: Number.isFinite(points) ? points : 480
  };
}

