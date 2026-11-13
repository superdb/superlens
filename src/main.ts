import { App } from "./app.ts"
import { Engine } from "./engine/engine.ts"

// Engine files are served next to index.html.
const base = new URL(".", document.baseURI)

let app: App | undefined
const engine = new Engine({
  wasmURL: new URL("super.wasm", base).href,
  execURL: new URL("wasm_exec.js", base).href,
  workerURL: new URL("./engine/worker.js", import.meta.url),
  onProgress: (loaded, total) => app?.onProgress(loaded, total),
})
app = new App(engine)
