// A static file server for dist/ (no dependencies), for development and
// for trying a build locally.
//
//   node scripts/serve.mjs [--port 8080] [--dir dist]
//
// It sends the same headers recommended for hosting (see public/_headers):
// a content security policy that keeps the page from connecting to other
// sites, and the WebAssembly content type.  super.wasm is gzipped once and
// cached in memory.

import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const k = args.indexOf(name)
  return k >= 0 ? args[k + 1] : dflt
}
const root = resolve(fileURLToPath(new URL("..", import.meta.url)), opt("--dir", "dist"))
const port = Number(opt("--port", process.env.PORT ?? 8080))

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ts": "text/plain; charset=utf-8",
}

const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const gzCache = new Map()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost")
    let path = normalize(decodeURIComponent(url.pathname))
    if (path.endsWith("/")) path += "index.html"
    const file = join(root, path)
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    const info = await stat(file).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found")
      return
    }
    const headers = {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    }
    let body = await readFile(file)
    if (extname(file) === ".wasm" && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      let entry = gzCache.get(file)
      if (!entry || entry.mtime !== info.mtimeMs) {
        entry = { mtime: info.mtimeMs, data: gzipSync(body, { level: 6 }) }
        gzCache.set(file, entry)
      }
      headers["Content-Encoding"] = "gzip"
      headers["X-Uncompressed-Length"] = String(body.length)
      body = entry.data
    }
    headers["Content-Length"] = String(body.length)
    res.writeHead(200, headers)
    res.end(req.method === "HEAD" ? undefined : body)
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e))
  }
})

server.listen(port, () => {
  console.log(`SuperLens at http://localhost:${port}/ (serving ${root})`)
})
