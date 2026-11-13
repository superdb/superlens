// The SUP view: each value as a line of SUP text.

import type { Value } from "@superdb/super-ts"
import { sup, truncate } from "./cells.ts"
import { VirtualList } from "./virtual.ts"

const ROW_HEIGHT = 20
const MAX_LINE = 20_000

export class TextView {
  readonly el: HTMLElement
  private list: VirtualList
  private values: readonly Value[] = []

  constructor() {
    this.list = new VirtualList({ rowHeight: ROW_HEIGHT, render: (i) => this.renderRow(i), className: "sup-text" })
    this.el = this.list.el
  }

  setValues(values: readonly Value[]) {
    this.values = values
    this.list.scrollToTop()
    this.list.setCount(values.length)
  }

  /** All of the values as SUP text, one per line. */
  text(): string {
    return this.values.map((v) => sup(v)).join("\n")
  }

  private renderRow(i: number): HTMLElement {
    const el = document.createElement("div")
    el.className = "tline"
    el.textContent = truncate(sup(this.values[i]), MAX_LINE)
    return el
  }
}
