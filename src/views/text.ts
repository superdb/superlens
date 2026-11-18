// The SUP view: each value as a line of SUP text.

import { sup, truncate } from "./cells.ts"
import { arraySource, type ValueSource } from "./tree.ts"
import { VirtualList } from "./virtual.ts"

const ROW_HEIGHT = 20
const MAX_LINE = 20_000

export class TextView {
  readonly el: HTMLElement
  private list: VirtualList
  private values: ValueSource = arraySource([])

  constructor() {
    this.list = new VirtualList({ rowHeight: ROW_HEIGHT, render: (i) => this.renderRow(i), className: "sup-text" })
    this.el = this.list.el
  }

  setValues(values: ValueSource) {
    this.values = values
    this.list.scrollToTop()
    this.list.setCount(values.length)
  }

  private renderRow(i: number): HTMLElement {
    const el = document.createElement("div")
    el.className = "tline"
    el.textContent = truncate(sup(this.values.get(i)), MAX_LINE)
    return el
  }
}
