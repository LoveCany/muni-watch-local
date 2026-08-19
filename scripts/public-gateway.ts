import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.MUNI_PUBLIC_GATEWAY_PORT ?? 4400);
const frontend = new URL(process.env.MUNI_FRONTEND_ORIGIN ?? "http://[::1]:3002");
const collector = new URL(process.env.MUNI_COLLECTOR_ORIGIN ?? "http://127.0.0.1:4317");
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "client");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

function isCollectorPath(url = ""): boolean {
  const pathname = new URL(url, "http://gateway.local").pathname;
  return new Set(["/api/state", "/api/history", "/api/pace"]).has(pathname);
}

async function serveBuiltAsset(request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://gateway.local").pathname);
  } catch {
    return false;
  }
  if (pathname === "/" || pathname.endsWith("/")) return false;

  const filePath = path.resolve(clientDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(`${clientDir}${path.sep}`)) return false;

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile()) return false;

  response.writeHead(200, {
    "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
  return true;
}

function proxy(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: URL,
  { normalizeOrigin = false }: { normalizeOrigin?: boolean } = {},
): void {
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
  delete headers["content-length"];
  if (normalizeOrigin && headers.origin) headers.origin = target.origin;

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    responseHeaders["x-content-type-options"] = "nosniff";
    responseHeaders["x-frame-options"] = "DENY";
    responseHeaders["referrer-policy"] = "no-referrer";
    responseHeaders["permissions-policy"] = "camera=(), microphone=(), geolocation=()";
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Upstream service is unavailable.");
  });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  const method = request.method ?? "GET";
  if (!new Set(["GET", "HEAD"]).has(method)) {
    response.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Public access is read-only" }));
    return;
  }

  const collectorRequest = isCollectorPath(request.url);
  if (!collectorRequest && await serveBuiltAsset(request, response)) return;
  proxy(request, response, collectorRequest ? collector : frontend, { normalizeOrigin: !collectorRequest });
});

server.listen(listenPort, listenHost, () => {
  console.log(`むに Watch public gateway: http://${listenHost}:${listenPort}`);
  console.log("Public gateway is read-only; MuMu controls remain local-only.");
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
