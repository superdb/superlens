// The inspector: values as an expandable tree, like the inspector in zui.
// Type values expand too, into the fields and members of their types.

import { kindClass, sup, truncate } from "./cells.ts"
import { VirtualList } from "./virtual.ts"
import {
  TreeModel,
  holdsType,
  openText,
  typeText,
  typeTitle,
  valueTitle,
  type Row,
  type ValueSource,
} from "./tree.ts"

const ROW_HEIGHT = 22
const INDENT = 16
const MAX_PREVIEW = 400

/** Rows to show when results are first displayed. */
export const AUTO_EXPAND_BUDGET = 400

/**
 * After Expand all, each value is expanded when it scrolls into view, as
 * far as this many rows allow.
 */
const EXPAND_ALL_BUDGET = 20_000

export class InspectorView {
  readonly el: HTMLElement
  private list: VirtualList
  private model = new TreeModel([])
  /**
   * Whether new values open collapsed.  expandAll and collapseAll set it, so
   * the last one used carries over to the next values.
   */
  collapsed = false
  // After Expand all, values expand as they scroll into view.  (Expanding
  // them all up front would mean decoding them all.)
  private expandingAll = false

  constructor() {
    this.list = new VirtualList({
      rowHeight: ROW_HEIGHT,
      render: (i) => this.renderRow(i),
      prepare: (first, last) => this.prepare(first, last),
      className: "inspector",
    })
    this.el = this.list.el
    this.el.addEventListener("click", (ev) => this.onClick(ev))
  }

  /** Shows values, expanded as far as budget rows allow unless collapsed is set. */
  setValues(source: ValueSource, budget = AUTO_EXPAND_BUDGET) {
    this.model = new TreeModel(source)
    this.expandingAll = false
    if (!this.collapsed) this.model.expandWithin(budget)
    this.list.scrollToTop()
    this.update()
  }

  expandAll() {
    this.collapsed = false
    this.expandingAll = true
    this.model.forgetExpandOnce()
    this.list.refresh()
  }

  collapseAll() {
    this.collapsed = true
    this.expandingAll = false
    this.model.collapseAll()
    this.update()
  }

  private update() {
    this.list.setCount(this.model.rowCount)
  }

  // prepare expands the values about to be shown after Expand all.  The row
  // at the top of the view stays put, so values that expand, including the
  // one it's in, don't move what's being looked at.
  private prepare(first: number, last: number): boolean {
    if (!this.expandingAll || last <= first) return false
    const m = this.model
    const h = this.list.rowHeight
    const scroller = this.list.scroller
    const topRow = Math.floor(scroller.scrollTop / h)
    const anchor = topRow < m.rowCount ? { item: m.locate(topRow).item, path: m.row(topRow).path } : undefined
    const from = m.locate(first).item
    const to = m.locate(Math.min(last, m.rowCount) - 1).item
    if (!m.expandOnce(from, to, EXPAND_ALL_BUDGET)) return false
    this.list.resize(m.rowCount)
    if (anchor) {
      const row = m.rowOfPath(anchor.item, anchor.path) ?? m.rowOf(anchor.item)
      scroller.scrollTop = row * h + (scroller.scrollTop % h)
    }
    return true
  }

  private onClick(ev: MouseEvent) {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-row]")
    if (!target) return
    const index = Number(target.dataset.row)
    if (!(index < this.model.rowCount)) return
    const row = this.model.row(index)
    if ((row.kind === "value" || row.kind === "type") && row.expandable) {
      // Don't collapse when the user is selecting text.
      if (window.getSelection()?.toString()) return
      this.model.toggle(row.path)
      this.update()
    } else if (row.kind === "more") {
      this.model.showMore(row.parent)
      this.update()
    }
  }

  private renderRow(i: number): HTMLElement {
    const row: Row = this.model.row(i)
    const el = document.createElement("div")
    el.className = "irow"
    el.dataset.row = String(i)
    el.style.paddingLeft = `${8 + row.depth * INDENT}px`
    switch (row.kind) {
      case "value":
      case "type": {
        const toggle = document.createElement("span")
        toggle.className = "toggle"
        toggle.textContent = row.expandable ? (row.expanded ? "▾" : "▸") : ""
        el.append(toggle)
        if (row.expandable) el.classList.add("expandable")
        if (row.key !== undefined) {
          const key = document.createElement("span")
          key.className = "key"
          key.textContent = row.key
          el.append(key, ": ")
        }
        const val = document.createElement("span")
        if (row.kind === "type") {
          // Every part of a type, brackets included, is in the type color.
          val.className = "k-type"
          val.textContent = truncate(row.expanded ? openText(row) : typeText(row), MAX_PREVIEW)
          el.title = row.expandable ? "" : truncate(typeTitle(row), 2000)
        } else {
          const ofType = holdsType(row.value)
          if (row.expanded) {
            val.className = ofType ? "k-type" : "punct"
            val.textContent = truncate(openText(row), MAX_PREVIEW)
          } else {
            val.className = row.expandable && !ofType ? "k-container" : kindClass(row.value)
            val.textContent = truncate(sup(row.value), MAX_PREVIEW)
          }
          el.title = row.expandable ? "" : truncate(valueTitle(row.value), 2000)
        }
        el.append(val)
        break
      }
      case "close": {
        const toggle = document.createElement("span")
        toggle.className = "toggle"
        const t = document.createElement("span")
        t.className = row.ofType ? "k-type" : "punct"
        t.textContent = truncate(row.text, MAX_PREVIEW)
        el.append(toggle, t)
        break
      }
      case "more": {
        const btn = document.createElement("button")
        btn.className = "more"
        const n = Math.min(row.total - row.shown, 200)
        btn.textContent = `… show ${n.toLocaleString()} more (${row.shown.toLocaleString()} of ${row.total.toLocaleString()})`
        el.append(btn)
        break
      }
    }
    return el
  }
}
