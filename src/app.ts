// SuperLens: open files, query them with SuperSQL, and look at the results.

import type { Value } from "@superdb/super-ts"
import { Cancelled, Engine, type QueryOutcome } from "./engine/engine.ts"
import { sup, toJSON } from "./views/cells.ts"
import { bestView, type ViewName } from "./views/choose.ts"
import { InspectorView } from "./views/inspector.ts"
import { TableView } from "./views/table.ts"
import { TextView } from "./views/text.ts"

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

// Preferences kept in this browser only.  Storage can be unavailable (e.g.,
// in some private modes), so failures are ignored.
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`superlens.${key}`)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`superlens.${key}`, value)
    } catch {
      // Ignore.
    }
  },
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB"]
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`
}

export class App {
  private engine: Engine
  private files: readonly File[] = []
  private outcome: QueryOutcome | undefined
  private view: ViewName = "inspector"
  private userView: ViewName | undefined
  private runSeq = 0
  private table = new TableView()
  private inspector = new InspectorView()
  private text = new TextView()
  private detail = new InspectorView()
  private detailValue: Value | undefined

  private query = $<HTMLTextAreaElement>("query")
  private formatSelect = $<HTMLSelectElement>("format-select")
  private limitSelect = $<HTMLSelectElement>("limit-select")
  private fileInput = $<HTMLInputElement>("file-input")

  constructor(engine: Engine) {
    this.engine = engine
    this.restorePrefs()
    this.wire()
    this.renderFiles()
    this.showView()
    document.body.classList.add("no-results")
    void this.startEngine()
  }

  private restorePrefs() {
    this.query.value = prefs.get("query") ?? ""
    this.formatSelect.value = prefs.get("format") ?? "auto"
    const limit = prefs.get("limit")
    if (limit !== null && [...this.limitSelect.options].some((o) => o.value === limit)) this.limitSelect.value = limit
    const view = prefs.get("view")
    if (view === "table" || view === "inspector" || view === "text") this.userView = view
    this.autosize()
  }

  private wire() {
    $("open-button").addEventListener("click", () => this.fileInput.click())
    $("empty-open-button").addEventListener("click", () => this.fileInput.click())
    this.fileInput.addEventListener("change", () => {
      if (this.fileInput.files) this.addFiles([...this.fileInput.files])
      this.fileInput.value = ""
    })
    $("clear-button").addEventListener("click", () => this.setFiles([]))
    $("sample-button").addEventListener("click", () => void this.loadSample())

    this.query.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault()
        void this.run()
      }
    })
    this.query.addEventListener("input", () => {
      this.autosize()
      prefs.set("query", this.query.value)
    })
    $("run-button").addEventListener("click", () => void this.run())
    $("stop-button").addEventListener("click", () => this.engine.stop())
    this.formatSelect.addEventListener("change", () => {
      prefs.set("format", this.formatSelect.value)
      void this.run()
    })
    this.limitSelect.addEventListener("change", () => {
      prefs.set("limit", this.limitSelect.value)
      void this.run()
    })

    for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs [data-view]")) {
      tab.addEventListener("click", () => {
        this.userView = tab.dataset.view as ViewName
        prefs.set("view", this.userView)
        this.showView()
      })
    }
    $("expand-button").addEventListener("click", () => this.inspector.expandAll())
    $("collapse-button").addEventListener("click", () => this.inspector.collapseAll())
    $("copy-button").addEventListener("click", () => void this.copy(this.text.text(), "copy-button"))
    $("download-button").addEventListener("click", () => this.download())

    this.table.onSelect = (v, i) => this.showDetail(v, i)
    $("detail-close").addEventListener("click", () => {
      this.showDetail(undefined, -1)
      this.table.clearSelection()
    })
    $("detail-copy-sup").addEventListener("click", () => {
      if (this.detailValue) void this.copy(sup(this.detailValue), "detail-copy-sup")
    })
    $("detail-copy-json").addEventListener("click", () => {
      if (this.detailValue) void this.copy(toJSON(this.detailValue), "detail-copy-json")
    })
    $("detail-body").append(this.detail.el)

    const dialog = $<HTMLDialogElement>("privacy-dialog")
    $("privacy-button").addEventListener("click", () => dialog.showModal())
    $("privacy-close").addEventListener("click", () => dialog.close())

    this.wireDrop()
  }

  // Files can be dropped anywhere on the page.
  private wireDrop() {
    const overlay = $("drop-overlay")
    let depth = 0
    const hasFiles = (ev: DragEvent) => ev.dataTransfer?.types.includes("Files") ?? false
    window.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev)) return
      ev.preventDefault()
      depth++
      overlay.hidden = false
    })
    window.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev)) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy"
    })
    window.addEventListener("dragleave", (ev) => {
      if (!hasFiles(ev)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) overlay.hidden = true
    })
    window.addEventListener("drop", (ev) => {
      if (!hasFiles(ev)) return
      ev.preventDefault()
      depth = 0
      overlay.hidden = true
      const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type !== "")
      if (files.length > 0) this.addFiles(files)
    })
  }

  private async startEngine() {
    const status = $("engine-status")
    const progress = $<HTMLProgressElement>("engine-progress")
    try {
      await this.engine.start()
      status.textContent = `SuperDB ${this.engine.version} ready`
      progress.hidden = true
    } catch (e) {
      status.textContent = `The query engine failed to load: ${e instanceof Error ? e.message : e}`
      status.classList.add("error")
      progress.hidden = true
    }
  }

  /** Engine download progress (called by the engine). */
  onProgress(loaded: number, total: number) {
    const status = $("engine-status")
    const progress = $<HTMLProgressElement>("engine-progress")
    if (total > 0) {
      progress.value = Math.min(1, loaded / total)
      status.textContent = `Loading the query engine… ${formatBytes(loaded)} of ${formatBytes(total)}`
    } else {
      progress.removeAttribute("value")
      status.textContent = `Loading the query engine… ${formatBytes(loaded)}`
    }
  }

  private autosize() {
    this.query.style.height = "auto"
    this.query.style.height = `${Math.min(this.query.scrollHeight, 200)}px`
  }

  private addFiles(files: File[]) {
    // Replace a file with the same name rather than adding it twice.
    const names = new Set(files.map((f) => f.name))
    this.setFiles([...this.files.filter((f) => !names.has(f.name)), ...files])
  }

  private setFiles(files: readonly File[]) {
    this.files = files
    this.renderFiles()
    void this.run()
  }

  private renderFiles() {
    const chips = $("file-chips")
    chips.replaceChildren(
      ...this.files.map((f) => {
        const li = document.createElement("li")
        li.className = "chip"
        const name = document.createElement("span")
        name.textContent = f.name
        name.title = `${f.name} (${formatBytes(f.size)})`
        const size = document.createElement("span")
        size.className = "size"
        size.textContent = formatBytes(f.size)
        const remove = document.createElement("button")
        remove.className = "icon"
        remove.type = "button"
        remove.textContent = "×"
        remove.setAttribute("aria-label", `Remove ${f.name}`)
        remove.addEventListener("click", () => this.setFiles(this.files.filter((x) => x !== f)))
        li.append(name, size, remove)
        return li
      }),
    )
    $("clear-button").hidden = this.files.length < 2
  }

  private async loadSample() {
    try {
      const res = await fetch("sample/github-events.json")
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const blob = await res.blob()
      this.addFiles([new File([blob], "github-events.json", { type: "application/json" })])
      if (!this.query.value.trim()) {
        this.query.value = "count() by type | sort count desc"
        this.autosize()
        prefs.set("query", this.query.value)
        void this.run()
      }
    } catch (e) {
      this.showMessages([], `Couldn't load the sample: ${e instanceof Error ? e.message : e}`)
    }
  }

  private hasWork(): boolean {
    return this.files.length > 0 || this.query.value.trim() !== ""
  }

  async run() {
    const seq = ++this.runSeq
    $("empty").hidden = this.hasWork()
    if (!this.hasWork()) {
      this.outcome = undefined
      this.showMessages([], undefined)
      $("status").textContent = ""
      this.showResults()
      return
    }
    if (this.engine.busy) this.engine.stop()
    this.setRunning(true)
    $("status").textContent = this.engine.version ? "Running…" : "Waiting for the query engine…"
    try {
      const outcome = await this.engine.run(this.query.value, this.files, {
        format: this.formatSelect.value,
        limit: Number(this.limitSelect.value),
      })
      if (seq !== this.runSeq) return
      this.outcome = outcome
      this.showMessages(outcome.warnings, undefined)
      this.showResults()
    } catch (e) {
      if (seq !== this.runSeq) return
      // Keep the last results visible but dimmed, so a typo while editing a
      // query doesn't wipe them out.
      document.body.classList.toggle("stale", this.outcome !== undefined)
      if (e instanceof Cancelled) {
        $("status").textContent = "Stopped"
      } else {
        $("status").textContent = this.outcome ? "Showing the previous results" : ""
        this.showMessages([], e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === this.runSeq) this.setRunning(false)
    }
  }

  private setRunning(running: boolean) {
    $("run-button").hidden = running
    $("stop-button").hidden = !running
    document.body.classList.toggle("running", running)
  }

  private showMessages(warnings: string[], error: string | undefined) {
    const box = $("messages")
    const items: HTMLElement[] = []
    if (error) {
      const pre = document.createElement("pre")
      pre.className = "message error"
      pre.textContent = error
      items.push(pre)
    }
    for (const w of warnings) {
      const div = document.createElement("div")
      div.className = "message warning"
      div.textContent = w
      items.push(div)
    }
    box.replaceChildren(...items)
  }

  private showResults() {
    const values = this.outcome?.values ?? []
    document.body.classList.remove("stale")
    document.body.classList.toggle("no-results", this.outcome === undefined)
    this.showDetail(undefined, -1)
    if (this.outcome) {
      const o = this.outcome
      const parts = [plural(values.length, "value")]
      if (o.shapes.length > 1) parts.push(plural(o.shapes.length, "shape"))
      parts.push(`${formatMs(o.elapsedMs + o.decodeMs)}`)
      $("status").textContent = parts.join(" · ")
      $("status").title = `query ${formatMs(o.elapsedMs)}, decode ${formatMs(o.decodeMs)}, ${formatBytes(o.bytes)} of BSUP`
    }
    this.view = this.userView ?? bestView(values, this.outcome?.shapes.length ?? 0)
    this.table.setValues(values)
    this.inspector.setValues(values)
    this.text.setValues(values)
    this.showView()
  }

  private showView() {
    const view = this.userView ?? this.view
    this.view = view
    for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs [data-view]")) {
      const on = tab.dataset.view === view
      tab.classList.toggle("active", on)
      tab.setAttribute("aria-selected", String(on))
    }
    for (const el of document.querySelectorAll<HTMLElement>(".actions [data-for]")) {
      el.hidden = el.dataset.for !== view
    }
    const el = view === "table" ? this.table.el : view === "inspector" ? this.inspector.el : this.text.el
    const container = $("view")
    if (container.firstChild !== el) container.replaceChildren(el)
    if (view !== "table") this.showDetail(undefined, -1)
  }

  private showDetail(v: Value | undefined, index: number) {
    this.detailValue = v
    const aside = $("detail")
    aside.hidden = v === undefined
    if (v) {
      $("detail-title").textContent = `Row ${(index + 1).toLocaleString()}`
      this.detail.setValues([v], 5000)
    }
  }

  private async copy(text: string, buttonID: string) {
    const button = $(buttonID)
    const label = button.textContent
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = "Copied"
    } catch {
      button.textContent = "Copy failed"
    }
    setTimeout(() => (button.textContent = label), 1200)
  }

  // download saves the results as SUP.  The file is made in the browser.
  private download() {
    const blob = new Blob([this.text.text() + "\n"], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "results.sup"
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
