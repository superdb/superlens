// The inspector: values as an expandable tree, like the inspector in zui.

import type { Value } from "@superdb/super-ts"
import { kindClass, sup, truncate } from "./cells.ts"
import { VirtualList } from "./virtual.ts"
import { TreeModel, openText, type Row } from "./tree.ts"

const ROW_HEIGHT = 22
const INDENT = 16
const MAX_PREVIEW = 400

/** Rows to show when results are first displayed. */
export const AUTO_EXPAND_BUDGET = 400

export class InspectorView {
  readonly el: HTMLElement
  private list: VirtualList
  private model = new TreeModel([])
  private rows: Row[] = []

  constructor() {
    this.list = new VirtualList({ rowHeight: ROW_HEIGHT, render: (i) => this.renderRow(i), className: "inspector" })
    this.el = this.list.el
    this.el.addEventListener("click", (ev) => this.onClick(ev))
  }

  setValues(values: readonly Value[], budget = AUTO_EXPAND_BUDGET) {
    this.model = new TreeModel(values)
    this.model.expandWithin(budget)
    this.list.scrollToTop()
    this.update()
  }

  expandAll() {
    this.model.expandWithin(100_000, 64)
    this.update()
  }

  collapseAll() {
    this.model.collapseAll()
    this.update()
  }

  private update() {
    this.rows = this.model.rows()
    this.list.setCount(this.rows.length)
  }

  private onClick(ev: MouseEvent) {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-row]")
    if (!target) return
    const row = this.rows[Number(target.dataset.row)]
    if (!row) return
    if (row.kind === "value" && row.expandable) {
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
    const row = this.rows[i]
    const el = document.createElement("div")
    el.className = "irow"
    el.dataset.row = String(i)
    el.style.paddingLeft = `${8 + row.depth * INDENT}px`
    switch (row.kind) {
      case "value": {
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
        if (row.expanded) {
          val.className = "punct"
          val.textContent = openText(row.value)
        } else {
          val.className = row.expandable ? "k-container" : kindClass(row.value)
          val.textContent = truncate(sup(row.value), MAX_PREVIEW)
        }
        el.append(val)
        el.title = row.expandable ? "" : truncate(sup(row.value), 2000)
        break
      }
      case "close": {
        const toggle = document.createElement("span")
        toggle.className = "toggle"
        const t = document.createElement("span")
        t.className = "punct"
        t.textContent = row.text
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
