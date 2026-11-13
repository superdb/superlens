// The engine worker runs SuperDB (compiled to WebAssembly) off the main
// thread so a long query doesn't freeze the page.  Files are read here, in
// the browser, and copied into the engine's memory; nothing is sent over the
// network.  The only fetches are for the engine itself (super.wasm and
// wasm_exec.js), from the same site as the app.

import type { FromWorker, ToWorker } from "./protocol.ts"

interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

interface Input {
  name: string
  data: Uint8Array
}

interface SuperLensWasm {
  setInputs(inputs: Input[]): number
  run(args: {
    program: string
    useLoaded: boolean
    inputFormat: string
    outputFormat: string
    limit: number
  }): Promise<Uint8Array | string>
  version(): string
}

type GoGlobal = typeof globalThis & {
  Go?: new () => GoRuntime
  __go_wasm__?: Record<string, unknown>
}

const g = globalThis as GoGlobal
let api: SuperLensWasm | undefined

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function fetchWithProgress(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`can't load ${url}: ${res.status} ${res.statusText}`)
  // When the response is compressed, Content-Length is the compressed size,
  // so use the uncompressed size if the server says what it is (as
  // scripts/serve.mjs does) and otherwise show indeterminate progress.
  const encoded = res.headers.get("Content-Encoding")
  const total = Number(
    res.headers.get("X-Uncompressed-Length") ?? (encoded ? 0 : (res.headers.get("Content-Length") ?? 0)),
  )
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let last = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    const now = Date.now()
    if (now - last > 50) {
      post({ type: "progress", loaded, total })
      last = now
    }
  }
  post({ type: "progress", loaded, total: Math.max(total, loaded) })
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// Go's wasm_exec.js stubs out the process object in browsers, and its stub
// has no working directory, so a query's relative file names (from
// 'data.json') can't be resolved.  This stub is the same except that the
// working directory is the root, where the inputs are registered.
function stubProcess() {
  const enosys = () => Object.assign(new Error("not implemented"), { code: "ENOSYS" })
  ;(globalThis as Record<string, unknown>).process ??= {
    getuid: () => -1,
    getgid: () => -1,
    geteuid: () => -1,
    getegid: () => -1,
    getgroups: () => {
      throw enosys()
    },
    pid: -1,
    ppid: -1,
    umask: () => {
      throw enosys()
    },
    cwd: () => "/",
    chdir: () => {
      throw enosys()
    },
  }
}

async function load(req: Extract<ToWorker, { type: "load" }>) {
  stubProcess()
  await import(req.execURL)
  if (!g.Go) throw new Error("wasm_exec.js did not define Go")
  // golang-wasm (used by the engine's main) publishes its functions on
  // __go_wasm__ and calls __wrapper__ to adapt them.
  g.__go_wasm__ = {
    __wrapper__:
      (fn: (...args: unknown[]) => { error?: unknown; result?: unknown }) =>
      (...args: unknown[]) => {
        const r = fn(...args)
        if (r.error instanceof Error) throw r.error
        return r.result
      },
  }
  const module = req.module ?? (await WebAssembly.compile(await fetchWithProgress(req.wasmURL)))
  const go = new g.Go()
  const instance = await WebAssembly.instantiate(module, go.importObject)
  void go.run(instance)
  const exports = g.__go_wasm__ as Record<string, unknown>
  for (let k = 0; typeof exports.run !== "function"; k++) {
    if (k > 1000) throw new Error("the engine did not start")
    await new Promise((r) => setTimeout(r, 5))
  }
  api = exports as unknown as SuperLensWasm
  // Hand the compiled module back so a replacement worker (after a query is
  // stopped) can start without compiling it again.
  try {
    post({ type: "ready", version: api.version(), module })
  } catch {
    post({ type: "ready", version: api.version() })
  }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const req = ev.data
  switch (req.type) {
    case "load":
      try {
        await load(req)
      } catch (e) {
        post({ type: "load-error", message: errorMessage(e) })
      }
      return
    case "inputs":
      try {
        const inputs = await Promise.all(
          req.files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
        )
        api!.setInputs(inputs)
        post({ type: "inputs-done", id: req.id })
      } catch (e) {
        post({ type: "error", id: req.id, message: errorMessage(e) })
      }
      return
    case "run":
      try {
        const start = performance.now()
        const out = await api!.run({
          program: req.program,
          useLoaded: true,
          inputFormat: req.format,
          outputFormat: "bsup",
          limit: req.limit,
        })
        if (typeof out === "string") throw new Error("engine returned text instead of BSUP")
        post({ type: "result", id: req.id, bsup: out, elapsedMs: performance.now() - start }, [out.buffer])
      } catch (e) {
        post({ type: "error", id: req.id, message: errorMessage(e) })
      }
      return
  }
}
