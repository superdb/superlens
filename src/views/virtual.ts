// A virtualized list of fixed-height rows.  Only the rows in view (plus a
// margin) are in the DOM, so a list can have millions of rows.

export interface VirtualListOptions {
  rowHeight: number
  /** Renders row i.  Called only for rows in view. */
  render: (i: number) => HTMLElement
  /** An element kept at the top of the scroll area (e.g., a table header). */
  header?: HTMLElement
  /**
   * Called with the range of rows about to be rendered.  It may change the
   * rows (calling resize and scrolling as needed) and returns true if it
   * did, so the range is computed again.
   */
  prepare?: (first: number, last: number) => boolean
  className?: string
}

const OVERSCAN = 8

export class VirtualList {
  readonly el: HTMLElement
  private body: HTMLElement
  private rows: HTMLElement
  private opts: VirtualListOptions
  private count = 0
  private frame = 0
  private first = -1
  private last = -1

  constructor(opts: VirtualListOptions) {
    this.opts = opts
    this.el = document.createElement("div")
    this.el.className = "vlist" + (opts.className ? ` ${opts.className}` : "")
    if (opts.header) this.el.append(opts.header)
    this.body = document.createElement("div")
    this.body.className = "vlist-body"
    this.rows = document.createElement("div")
    this.rows.className = "vlist-rows"
    this.body.append(this.rows)
    this.el.append(this.body)
    this.el.addEventListener("scroll", () => this.schedule())
    new ResizeObserver(() => this.schedule()).observe(this.el)
  }

  get length(): number {
    return this.count
  }

  /** Sets the number of rows and re-renders. */
  setCount(n: number) {
    this.count = n
    this.body.style.height = `${n * this.opts.rowHeight}px`
    this.refresh()
  }

  /**
   * Sets the number of rows without rendering, for prepare.  (setCount
   * renders.)
   */
  resize(n: number) {
    this.count = n
    this.body.style.height = `${n * this.opts.rowHeight}px`
  }

  /** The height of a row. */
  get rowHeight(): number {
    return this.opts.rowHeight
  }

  /** The element that scrolls. */
  get scroller(): HTMLElement {
    return this.el
  }

  /** Re-renders the rows in view (e.g., after their content changed). */
  refresh() {
    this.first = this.last = -1
    this.update()
  }

  /** Sets the width of the scrolled content (for horizontal scrolling). */
  setWidth(px: number | null) {
    this.body.style.width = px === null ? "" : `${px}px`
  }

  scrollToTop() {
    this.el.scrollTop = 0
    this.el.scrollLeft = 0
  }

  /** Scrolls so row i is in view. */
  scrollIntoView(i: number) {
    const h = this.opts.rowHeight
    const headerH = this.opts.header?.offsetHeight ?? 0
    const top = i * h
    const view = this.el.clientHeight - headerH
    if (top < this.el.scrollTop) this.el.scrollTop = top
    else if (top + h > this.el.scrollTop + view) this.el.scrollTop = top + h - view
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }

  private update() {
    const h = this.opts.rowHeight
    const headerH = this.opts.header?.offsetHeight ?? 0
    let first = 0
    let last = 0
    for (let pass = 0; ; pass++) {
      const top = Math.max(0, this.el.scrollTop)
      const view = Math.max(this.el.clientHeight - headerH, h)
      first = Math.max(0, Math.floor(top / h) - OVERSCAN)
      last = Math.min(this.count, Math.ceil((top + view) / h) + OVERSCAN)
      if (pass >= 4 || !this.opts.prepare?.(first, last)) break
      this.first = this.last = -1
    }
    if (first === this.first && last === this.last) return
    this.first = first
    this.last = last
    const frag = document.createDocumentFragment()
    for (let i = first; i < last; i++) {
      const row = this.opts.render(i)
      row.style.height = `${h}px`
      frag.append(row)
    }
    this.rows.style.transform = `translateY(${first * h}px)`
    this.rows.replaceChildren(frag)
  }
}
