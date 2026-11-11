// Tiny DOM helpers: no framework, just functions that build elements.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/** h("button", { class: "x", onclick: fn }, "Label") */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** s("rect", { x: 0, y: 0, width: 10, height: 10 }) — the same for SVG. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, ""), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Replace all children of `el`. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** A paragraph with minimal inline markup: *emphasis* and `code`. */
export function prose(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  for (const part of text.split(/(`[^`]+`|\*[^*]+\*)/)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) p.append(h("code", {}, part.slice(1, -1)));
    else if (part.startsWith("*") && part.endsWith("*") && part.length > 1) p.append(h("em", {}, part.slice(1, -1)));
    else if (part) p.append(part);
  }
  return p;
}

/** Scroll the nearest horizontally scrolling box around `cell` so the cell is visible — sideways only.
 *  (scrollIntoView would also scroll the page up or down, away from what the reader is looking at.) */
export function keepInView(within: Element, cell: Element | null): void {
  if (!cell) return;
  let box: Element | null = cell.parentElement;
  while (box && box !== within.parentElement && !(box.scrollWidth > box.clientWidth && /auto|scroll/.test(getComputedStyle(box).overflowX))) box = box.parentElement;
  if (!box || box === within.parentElement) return;
  const b = box.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  if (c.left < b.left) box.scrollLeft -= b.left - c.left + 8;
  else if (c.right > b.right) box.scrollLeft += c.right - b.right + 8;
}
