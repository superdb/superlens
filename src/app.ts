// SuperLens: open files, query them with SuperSQL, and look at the results.

import type { Value } from "@superdb/super-ts"
import { Cancelled, Engine, EngineCrashed, EngineProblem, type QueryOutcome } from "./engine/engine.ts"
import { sup, toJSON } from "./views/cells.ts"
import { EXPORT_FORMATS, exportFormat, exportQuery } from "./export.ts"
import { addSuperfuse } from "./superfuse.ts"
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

// paragraph makes a paragraph of text, with any SuperSQL in it (in
// `backticks`) as code.
function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p")
  text.split("`").forEach((part, i) => {
    if (i % 2 === 0) {
      p.append(part)
      return
    }
    const code = document.createElement("code")
    code.textContent = part
    p.append(code)
  })
  return p
}

// What a query ran with, for a bug report.
interface Ran {
  program: string
  /** The name of the input format, as the Format menu shows it. */
  format: string
}

const newIssueURL = "https://github.com/superdb/super/issues/new"

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`
}

// ClipboardFailed means the clipboard refused text, e.g., because the page
// lost focus while the text was being made.
class ClipboardFailed extends Error {}

// writeClipboard copies text that's still being made.  Safari and Firefox
// let a page write to the clipboard only while it handles a click, so where
// it can, the clipboard gets a promise of the text right away.
function writeClipboard(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined") {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }))
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })])
  }
  return text.then((t) => navigator.clipboard.writeText(t))
}

// saveFile downloads data as a file named name.  The file is made in the
// browser.
function saveFile(name: string, data: string | Uint8Array<ArrayBuffer>, binary: boolean) {
  const blob = new Blob([data], { type: binary ? "application/octet-stream" : "text/plain" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export class App {
  private engine: Engine
  private files: readonly File[] = []
  private outcome: QueryOutcome | undefined
  // What made the results: Copy and Download run it again.
  private shown: (Ran & { inputFormat: string; files: readonly File[]; limit: number }) | undefined
  private view: ViewName = "inspector"
  private userView: ViewName | undefined
  // A view for the current results only, e.g., the inspector for Superfuse.
  private resultView: ViewName | undefined
  private runSeq = 0
  // Whether a query, Copy, or Download is running.
  private running = false
  private table = new TableView()
  private inspector = new InspectorView()
  private text = new TextView()
  private detail = new InspectorView()
  private detailValue: Value | undefined

  private query = $<HTMLTextAreaElement>("query")
  private formatSelect = $<HTMLSelectElement>("format-select")
  private limitSelect = $<HTMLSelectElement>("limit-select")
  private fileInput = $<HTMLInputElement>("file-input")
  private superfuseButton = $<HTMLButtonElement>("superfuse-button")
  private copyButton = $<HTMLButtonElement>("copy-button")
  private downloadButton = $<HTMLButtonElement>("download-button")
  private exportSelect = $<HTMLSelectElement>("export-select")
  private exportControls = $("export-controls")

  constructor(engine: Engine) {
    this.engine = engine
    this.restorePrefs()
    this.wire()
    this.renderFiles()
    this.showView()
    this.updateExport(false)
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
    // Expand all or Collapse all, whichever was used last, carries over.
    this.inspector.collapsed = prefs.get("expand") === "collapsed"
    for (const f of EXPORT_FORMATS) this.exportSelect.add(new Option(f.label, f.name))
    this.exportSelect.value = exportFormat(prefs.get("export")).name
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
      this.updateSuperfuse()
    })
    $("run-button").addEventListener("click", () => void this.run())
    this.superfuseButton.addEventListener("click", () => this.superfuse())
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
        this.resultView = undefined
        prefs.set("view", this.userView)
        this.showView()
      })
    }
    $("expand-button").addEventListener("click", () => this.setExpand(true))
    $("collapse-button").addEventListener("click", () => this.setExpand(false))
    this.copyButton.addEventListener("click", () => this.exportResults(true))
    this.downloadButton.addEventListener("click", () => this.exportResults(false))
    this.exportSelect.addEventListener("change", () => {
      prefs.set("export", this.exportSelect.value)
      this.updateExport(this.running)
    })

    this.table.onSelect = (v, i) => this.showDetail(v, i)
    $("detail-close").addEventListener("click", () => {
      this.showDetail(undefined, -1)
      this.table.clearSelection()
    })
    $("detail-copy-sup").addEventListener("click", () => {
      if (this.detailValue) void this.copy(sup(this.detailValue), $("detail-copy-sup"))
    })
    $("detail-copy-json").addEventListener("click", () => {
      if (this.detailValue) void this.copy(toJSON(this.detailValue), $("detail-copy-json"))
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
    this.updateSuperfuse()
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

  /** Runs the query.  view, if given, shows its results without changing the user's choice. */
  async run(view?: ViewName) {
    const seq = ++this.runSeq
    this.resultView = view
    $("empty").hidden = this.hasWork()
    if (!this.hasWork()) {
      this.outcome = undefined
      this.shown = undefined
      this.showMessages([], undefined)
      $("status").textContent = ""
      this.showResults()
      return
    }
    if (this.engine.busy) this.engine.stop()
    this.setRunning(true)
    $("status").textContent = this.engine.version ? "Running…" : "Waiting for the query engine…"
    // The query box and Format menu may change while the query runs, so
    // keep what ran.
    const program = this.query.value
    const format = this.formatSelect.value
    const ran = { program, format: this.formatSelect.selectedOptions[0]?.text ?? format }
    const files = this.files
    const limit = Number(this.limitSelect.value)
    try {
      const outcome = await this.engine.run(program, files, { format, limit })
      if (seq !== this.runSeq) return
      this.outcome = outcome
      this.shown = { ...ran, inputFormat: format, files, limit }
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
        this.showMessages([], e instanceof EngineProblem ? e : e instanceof Error ? e.message : String(e), ran)
      }
    } finally {
      if (seq === this.runSeq) this.setRunning(false)
    }
  }

  // superfuse adds "aggregate superfuse(this)" to the query and runs it, so
  // the fused type of the results opens in the inspector.  The query box
  // shows what ran, so the button also teaches the syntax.
  private superfuse() {
    if (!this.hasWork()) return
    const text = addSuperfuse(this.query.value)
    // Replace the text as typing would, so Undo brings back the old query.
    // insertText fires an input event, which resizes and saves the query.
    this.query.focus()
    this.query.select()
    if (!document.execCommand("insertText", false, text)) {
      this.query.value = text
      this.query.dispatchEvent(new Event("input"))
    }
    void this.run("inspector")
  }

  /** The Superfuse button needs files or a query to work on. */
  private updateSuperfuse() {
    this.superfuseButton.disabled = !this.hasWork()
  }

  private setRunning(running: boolean) {
    $("run-button").hidden = running
    this.superfuseButton.hidden = running
    $("stop-button").hidden = !running
    document.body.classList.toggle("running", running)
    this.running = running
    this.updateExport(running)
  }

  // updateExport enables Copy and Download, except while something runs,
  // and says what they'll do.  A binary format can't be copied.
  private updateExport(running: boolean) {
    const f = exportFormat(this.exportSelect.value)
    this.copyButton.disabled = running || f.binary
    this.downloadButton.disabled = running
    const fuse = f.tabular ? ", with “| fuse” added to the query so they share one set of columns" : ""
    this.copyButton.title = f.binary ? "" : `Copy all of the results as ${f.label}${fuse}`
    this.downloadButton.title = `Download all of the results as results.${f.ext}${fuse}`
    // A disabled button gets no hover text, so this shows over it instead.
    this.exportControls.title = f.binary ? `${f.label} is a binary format, so it can be downloaded but not copied` : ""
  }

  // exportResults copies or downloads the results in the format chosen next
  // to the buttons.  Like zui, it runs the query that made them again, with
  // no limit, so the output has all of the results, not just the ones shown,
  // and comes straight from SuperDB (e.g., SUP with its type definitions).
  // A tabular format gets "| fuse", and a note says so when the results
  // have more than one shape.  Running a query stops it, as does Stop.
  private exportResults(copy: boolean) {
    const shown = this.shown
    if (!shown || this.engine.busy) return
    const f = exportFormat(this.exportSelect.value)
    if (copy && f.binary) return
    const { query, fused } = exportQuery(shown.program, f)
    const name = `results.${f.ext}`
    const shapes = this.outcome?.shapes.length ?? 0
    // If Show cut off the results, the rest may have other shapes.
    const cutOff = shown.limit > 0 && (this.outcome?.values.length ?? 0) >= shown.limit
    const seq = ++this.runSeq
    const status = $("status")
    const before = { text: status.textContent, title: status.title }
    status.textContent = copy ? `Copying the results as ${f.label}…` : `Preparing ${name}…`
    status.title = ""
    this.clearExportNotes()
    this.setRunning(true)
    const output = this.engine.export(query, shown.files, { format: shown.inputFormat, outputFormat: f.name })
    const done = copy
      ? writeClipboard(output.then((out) => (typeof out === "string" ? out : new TextDecoder().decode(out))))
          // If the clipboard failed because the query did, say why the query
          // did.  Otherwise, it's the clipboard's fault.
          .catch(async (e) => {
            await output
            throw new ClipboardFailed(e instanceof Error ? e.message : String(e))
          })
      : output.then((out) => saveFile(name, out, f.binary))
    done
      .then(
        () => {
          if (seq !== this.runSeq) return
          this.flash(copy ? this.copyButton : this.downloadButton, copy ? "Copied" : "Downloaded")
          if (fused && (shapes > 1 || cutOff)) {
            const which = cutOff ? "the shapes in all of the results" : `the ${plural(shapes, "shape")} in the results`
            const div = document.createElement("div")
            div.className = "message warning prose"
            div.append(
              paragraph(
                `${f.label} needs one set of columns for every value, so \`fuse\` was added to the query to merge ${which}.`,
              ),
            )
            this.addExportNote(div)
          }
        },
        (e) => {
          if (seq !== this.runSeq || e instanceof Cancelled) return
          const what = copy ? `Couldn't copy the results as ${f.label}` : `Couldn't make \`${name}\``
          this.addExportNote(this.exportError(e, what, fused, { ...shown, program: query }))
        },
      )
      .finally(() => {
        if (seq !== this.runSeq) return
        status.textContent = before.text
        status.title = before.title
        this.setRunning(false)
      })
  }

  // exportError describes why Copy or Download failed.  what says what
  // failed, fused says whether fuse was added to the query, and ran is what
  // the query ran with, for a bug report.
  private exportError(e: unknown, what: string, fused: boolean, ran: Ran): HTMLElement {
    if (e instanceof EngineProblem) {
      const div = this.problemMessage(e, ran)
      div.prepend(paragraph(`${what}.`))
      if (e instanceof EngineCrashed && e.outOfMemory) {
        div.append(paragraph("Copy and Download include all of the results, not just the ones shown, so they can need more memory than showing them."))
      }
      return div
    }
    const div = document.createElement("div")
    div.className = "message error prose"
    const pre = document.createElement("pre")
    pre.textContent = e instanceof Error ? e.message : String(e)
    if (e instanceof ClipboardFailed) {
      div.append(paragraph(`${what}: the clipboard refused it.`), pre)
    } else {
      // SuperDB's error may suggest fuse, which was already added.
      div.append(paragraph(fused ? `${what}, even with \`fuse\` added to the query:` : `${what}:`), pre)
    }
    return div
  }

  // Notes about Copy and Download go after the results' warnings and
  // replace earlier ones.
  private addExportNote(el: HTMLElement) {
    this.clearExportNotes()
    el.classList.add("export-note")
    $("messages").append(el)
  }

  private clearExportNotes() {
    for (const el of $("messages").querySelectorAll(".export-note")) el.remove()
  }

  // showMessages shows an error and warnings above the results.  Errors from
  // the engine are in a fixed-width font, since they can point at a column of
  // the query.  An engine crash or panic is described in the app's own words
  // instead.  ran is what the query that got the error ran with.
  private showMessages(warnings: string[], error: string | EngineProblem | undefined, ran?: Ran) {
    const box = $("messages")
    const items: HTMLElement[] = []
    if (error instanceof EngineProblem) {
      items.push(this.problemMessage(error, ran))
    } else if (error) {
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

  // problemMessage describes an engine crash or panic.  Except for running
  // out of memory, these are bugs in SuperDB, so it asks for a report and
  // shows what Go printed, collapsed to its first line.  The link to GitHub
  // doesn't fill in the issue, which would send the query to GitHub as soon
  // as it's clicked.  "Copy details" lets the user choose what to paste.
  private problemMessage(e: EngineProblem, ran?: Ran): HTMLElement {
    const div = document.createElement("div")
    div.className = "message error prose"
    div.append(paragraph(e.message))
    if (e instanceof EngineCrashed && e.outOfMemory) return div

    const link = document.createElement("a")
    link.href = newIssueURL
    link.target = "_blank"
    link.rel = "noopener"
    link.textContent = "new issue on GitHub"
    const copy = document.createElement("button")
    copy.className = "copy-details"
    copy.type = "button"
    copy.textContent = "Copy details"
    copy.addEventListener("click", () => void this.copy(this.bugDetails(e.output, ran), copy))
    const report = paragraph("Please report it in a ")
    report.append(link, ", including your query, the SuperDB version, and the error below. ", copy)
    div.append(report)

    if (e.output) {
      const details = document.createElement("details")
      // Go may print diagnostics ("runtime: ...") before saying what failed.
      const summary = document.createElement("summary")
      summary.textContent = e.output.match(/^(panic|fatal error): .*$/m)?.[0] ?? e.output.split("\n", 1)[0]
      const pre = document.createElement("pre")
      pre.textContent = e.output
      details.append(summary, pre)
      div.append(details)
    }
    return div
  }

  // bugDetails is the text "Copy details" copies for a bug report, in
  // Markdown so it reads well when pasted into a GitHub issue.
  private bugDetails(output: string, ran?: Ran): string {
    const fence = "```"
    return [
      `SuperDB ${this.engine.version} in SuperLens (input format: ${ran?.format ?? "unknown"})`,
      "",
      "Query:",
      "",
      fence,
      ran?.program.trim() || "(none: showing everything in the files)",
      fence,
      "",
      "Error:",
      "",
      fence,
      output,
      fence,
    ].join("\n")
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

  // setExpand expands or collapses everything in the inspector, which keeps
  // that choice for later results, and remembers it in this browser.
  private setExpand(expand: boolean) {
    prefs.set("expand", expand ? "expanded" : "collapsed")
    if (expand) this.inspector.expandAll()
    else this.inspector.collapseAll()
  }

  private showView() {
    const view = this.resultView ?? this.userView ?? this.view
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

  private async copy(text: string, button: HTMLElement) {
    try {
      await writeClipboard(Promise.resolve(text))
      this.flash(button, "Copied")
    } catch {
      this.flash(button, "Copy failed")
    }
  }

  // flash shows text on a button for a moment.
  private flash(button: HTMLElement, text: string) {
    const label = button.dataset.label ?? button.textContent ?? ""
    button.dataset.label = label
    button.textContent = text
    setTimeout(() => {
      button.textContent = label
      delete button.dataset.label
    }, 1200)
  }
}
