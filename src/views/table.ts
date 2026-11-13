// The table view: one row per value with a column per (flattened) field,
// like the results table in zui.

import type { Value } from "@superdb/super-ts"
import { cellText, isNumeric, kindClass } from "./cells.ts"
import { CellLookup, buildColumns, shapeCounts, type TableColumn } from "./columns.ts"
import { VirtualList } from "./virtual.ts"

const ROW_HEIGHT = 24
const INDEX_WIDTH = 56
const MIN_WIDTH = 48
const MAX_WIDTH = 420
const SAMPLE = 200

export class TableView {
  readonly el: HTMLElement
  /** Called when the selected row changes. */
  onSelect: ((v: Value | undefined, index: number) => void) | undefined

  private list: VirtualList
  private header: HTMLElement
  private values: readonly Value[] = []
  private columns: TableColumn[] = []
  private lookup = new CellLookup([])
  private widths = new Map<string, number>()
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
  }

  setValues(values: readonly Value[]) {
    this.values = values
    this.columns = buildColumns([...shapeCounts(values).keys()])
    this.lookup = new CellLookup(this.columns)
    this.selected = -1
    this.sizeColumns()
    this.renderHeader()
    this.list.scrollToTop()
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
    this.onSelect?.(this.values[i], i)
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
      const ctx = document.createElement("canvas").getContext("2d")
      const font = getComputedStyle(this.el).getPropertyValue("--mono-font") || "monospace"
      if (ctx) {
        ctx.font = `12px ${font}`
        this.charWidth = ctx.measureText("0123456789").width / 10 || 7.2
      } else {
        this.charWidth = 7.2
      }
    }
    return this.charWidth
  }

  // sizeColumns picks each new column's width from its header and a sample
  // of its values.  Widths the user set by dragging are kept.
  private sizeColumns() {
    const cw = this.measureChar()
    const sample = this.values.slice(0, SAMPLE)
    this.columns.forEach((col, k) => {
      if (this.widths.has(col.id)) return
      let chars = col.label.length + 2
      for (const v of sample) {
        const cell = this.lookup.cell(v, k)
        if (cell) chars = Math.max(chars, Math.min(cellText(cell).length, 80))
      }
      this.widths.set(col.id, Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, chars * cw + 18))))
    })
    const total = INDEX_WIDTH + this.columns.reduce((n, c) => n + this.widths.get(c.id)!, 0)
    this.list.setWidth(total)
  }

  private width(col: TableColumn): number {
    return this.widths.get(col.id) ?? 120
  }

  private renderHeader() {
    const cells: HTMLElement[] = []
    const idx = document.createElement("div")
    idx.className = "th index"
    idx.style.width = `${INDEX_WIDTH}px`
    cells.push(idx)
    for (const col of this.columns) {
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
      this.list.refresh()
    }
    const up = () => {
      grip.removeEventListener("pointermove", move)
      grip.removeEventListener("pointerup", up)
      const total = INDEX_WIDTH + this.columns.reduce((n, c) => n + this.width(c), 0)
      this.list.setWidth(total)
    }
    grip.addEventListener("pointermove", move)
    grip.addEventListener("pointerup", up)
  }

  private renderRow(i: number): HTMLElement {
    const v = this.values[i]
    const row = document.createElement("div")
    row.className = i === this.selected ? "trow selected" : "trow"
    row.dataset.row = String(i)
    const idx = document.createElement("div")
    idx.className = "td index"
    idx.style.width = `${INDEX_WIDTH}px`
    idx.textContent = String(i + 1)
    row.append(idx)
    this.columns.forEach((col, k) => {
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
    })
    return row
  }
}
