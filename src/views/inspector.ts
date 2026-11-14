// The inspector: values as an expandable tree, like the inspector in zui.
// Type values expand too, into the fields and members of their types.

import type { Value } from "@superdb/super-ts"
import { kindClass, sup, truncate } from "./cells.ts"
import { VirtualList } from "./virtual.ts"
import { TreeModel, holdsType, openText, typeText, typeTitle, valueTitle, type Row } from "./tree.ts"

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
    const row = this.rows[i]
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
