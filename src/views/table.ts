// The table view: one row per value with a column per (flattened) field,
// like the results table in zui.  Rows and columns are both virtualized:
// only the cells in view are rendered, and only their values are decoded,
// so a table can have any number of rows and thousands of columns.

import type { Type, Value } from "@superdb/super-ts"
import { cellText, isNumeric, kindClass } from "./cells.ts"
import { CellLookup, buildColumns, type TableColumn } from "./columns.ts"
import { arraySource, type ValueSource } from "./tree.ts"
import { VirtualList } from "./virtual.ts"

const ROW_HEIGHT = 26
const INDEX_WIDTH = 56
const MIN_WIDTH = 48
const MAX_WIDTH = 420
// Values sampled to size the columns.
const SAMPLE = 50
// Columns rendered beyond each side of the view.
const COLUMN_OVERSCAN = 3

export class TableView {
  readonly el: HTMLElement
  /** Called when the selected row changes. */
  onSelect: ((v: Value | undefined, index: number) => void) | undefined

  private list: VirtualList
  private header: HTMLElement
  private values: ValueSource = arraySource([])
  private columns: TableColumn[] = []
  private lookup = new CellLookup([])
  private widths = new Map<string, number>()
  // The left edge of each column (after the index column), and the total
  // width at the end.
  private lefts: number[] = [0]
  // The columns in view (from first up to last).
  private firstCol = 0
  private lastCol = 0
  private selected = -1
  private charWidth = 0

  constructor() {
    this.header = document.createElement("div")
    this.header.className = "thead"
    this.list = new VirtualList({
      rowHeight: ROW_HEIGHT,
      render: (i) => this.renderRow(i),
      header: this.header,
      className: "table",
    })
    this.el = this.list.el
    this.el.tabIndex = 0
    this.el.addEventListener("click", (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-row]")
      if (row) this.select(Number(row.dataset.row))
    })
    this.el.addEventListener("keydown", (ev) => this.onKey(ev))
    this.el.addEventListener("scroll", () => this.onScroll())
    new ResizeObserver(() => this.onScroll()).observe(this.el)
  }

  /**
   * Shows values.  types are the types of the values (or a supertype of
   * them, such as their fused type), from which the columns come.
   */
  setValues(values: ValueSource, types: readonly Type[]) {
    this.values = values
    this.columns = buildColumns(types)
    this.lookup = new CellLookup(this.columns)
    this.selected = -1
    this.sizeColumns()
    this.list.scrollToTop()
    this.firstCol = this.lastCol = -1
    this.updateColumns()
    this.list.setCount(values.length)
  }

  get columnCount(): number {
    return this.columns.length
  }

  private select(i: number) {
    if (i < 0 || i >= this.values.length) return
    this.selected = i
    this.list.scrollIntoView(i)
    this.list.refresh()
    this.onSelect?.(this.values.get(i), i)
  }

  clearSelection() {
    this.selected = -1
    this.list.refresh()
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.key === "ArrowDown") {
      this.select(Math.min(this.values.length - 1, this.selected + 1))
      ev.preventDefault()
    } else if (ev.key === "ArrowUp") {
      this.select(Math.max(0, this.selected - 1))
      ev.preventDefault()
    } else if (ev.key === "Escape") {
      this.clearSelection()
      this.onSelect?.(undefined, -1)
    }
  }

  private measureChar(): number {
    if (!this.charWidth) {
      // Measure in the page, not on a canvas, so the cell font's variation
      // settings apply.
      const probe = document.createElement("span")
      probe.className = "td"
      probe.style.cssText = "position:absolute;visibility:hidden;padding:0;border:0"
      probe.textContent = "0123456789abcdefghij"
      this.el.append(probe)
      const w = probe.getBoundingClientRect().width / 20 || 7.8
      probe.remove()
      // Until the web font has loaded, this measures a fallback font, so
      // measure again next time.
      const style = getComputedStyle(this.el)
      const first = style.getPropertyValue("--mono-font").trim().split(",")[0] || "monospace"
      if (fontLoaded(`${style.fontSize} ${first}`)) this.charWidth = w
      return w
    }
    return this.charWidth
  }

  // sizeColumns picks each new column's width from its header and a sample
  // of its values.  Widths the user set by dragging are kept.
  private sizeColumns() {
    const cw = this.measureChar()
    const sample: Value[] = []
    for (let i = 0; i < Math.min(SAMPLE, this.values.length); i++) sample.push(this.values.get(i))
    this.columns.forEach((col, k) => {
      if (this.widths.has(col.id)) return
      let chars = col.label.length + 2
      for (const v of sample) {
        const cell = this.lookup.cell(v, k)
        if (cell) chars = Math.max(chars, Math.min(cellText(cell).length, 80))
      }
      this.widths.set(col.id, Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, chars * cw + 22))))
    })
    this.layout()
  }

  // layout computes where the columns are.
  private layout() {
    this.lefts = [0]
    for (const c of this.columns) this.lefts.push(this.lefts[this.lefts.length - 1] + this.width(c))
    this.list.setWidth(INDEX_WIDTH + this.lefts[this.lefts.length - 1])
  }

  private width(col: TableColumn): number {
    return this.widths.get(col.id) ?? 120
  }

  private onScroll() {
    if (this.updateColumns()) this.list.refresh()
  }

  // updateColumns finds the columns in view and renders their headers.  It
  // returns true if they changed.
  private updateColumns(): boolean {
    const n = this.columns.length
    const left = Math.max(0, this.el.scrollLeft - INDEX_WIDTH)
    const right = left + Math.max(this.el.clientWidth, 1)
    // Find the first column ending after left and the first starting after right.
    let first = 0
    while (first < n && this.lefts[first + 1] <= left) first++
    let last = first
    while (last < n && this.lefts[last] < right) last++
    first = Math.max(0, first - COLUMN_OVERSCAN)
    last = Math.min(n, last + COLUMN_OVERSCAN)
    if (first === this.firstCol && last === this.lastCol) return false
    this.firstCol = first
    this.lastCol = last
    this.renderHeader()
    return true
  }

  private spacer(width: number, className: string): HTMLElement {
    const el = document.createElement("div")
    el.className = className
    el.style.width = `${width}px`
    return el
  }

  private renderHeader() {
    const cells: HTMLElement[] = [this.spacer(INDEX_WIDTH, "th index"), this.spacer(this.lefts[this.firstCol], "th-spacer")]
    for (let k = this.firstCol; k < this.lastCol; k++) {
      const col = this.columns[k]
      const th = document.createElement("div")
      th.className = "th"
      th.style.width = `${this.width(col)}px`
      th.title = col.label
      const label = document.createElement("span")
      label.textContent = col.label
      const grip = document.createElement("span")
      grip.className = "grip"
      grip.addEventListener("pointerdown", (ev) => this.startResize(ev, col, th))
      th.append(label, grip)
      cells.push(th)
    }
    this.header.replaceChildren(...cells)
  }

  private startResize(ev: PointerEvent, col: TableColumn, th: HTMLElement) {
    ev.preventDefault()
    ev.stopPropagation()
    const startX = ev.clientX
    const startW = this.width(col)
    const grip = ev.target as HTMLElement
    grip.setPointerCapture(ev.pointerId)
    const move = (e: PointerEvent) => {
      const w = Math.max(MIN_WIDTH, Math.round(startW + e.clientX - startX))
      this.widths.set(col.id, w)
      th.style.width = `${w}px`
      this.layout()
      this.list.refresh()
    }
    const up = () => {
      grip.removeEventListener("pointermove", move)
      grip.removeEventListener("pointerup", up)
      this.firstCol = this.lastCol = -1
      this.onScroll()
    }
    grip.addEventListener("pointermove", move)
    grip.addEventListener("pointerup", up)
  }

  private renderRow(i: number): HTMLElement {
    const v = this.values.get(i)
    const row = document.createElement("div")
    row.className = i === this.selected ? "trow selected" : "trow"
    row.dataset.row = String(i)
    const idx = document.createElement("div")
    idx.className = "td index"
    idx.style.width = `${INDEX_WIDTH}px`
    idx.textContent = String(i + 1)
    row.append(idx, this.spacer(this.lefts[this.firstCol], "td-spacer"))
    for (let k = this.firstCol; k < this.lastCol; k++) {
      const col = this.columns[k]
      const td = document.createElement("div")
      td.style.width = `${this.width(col)}px`
      const cell = this.lookup.cell(v, k)
      if (cell === undefined) {
        td.className = "td absent"
      } else {
        const text = cellText(cell)
        td.className = `td ${kindClass(cell)}${isNumeric(cell) ? " num" : ""}`
        td.textContent = text
        if (text.length > 20) td.title = text
      }
      row.append(td)
    }
    return row
  }
}

// fontLoaded reports whether font is loaded or isn't a web font.
function fontLoaded(font: string): boolean {
  try {
    return document.fonts.check(font)
  } catch {
    return true
  }
}
