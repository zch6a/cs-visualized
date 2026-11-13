// The step player every topic uses: a simulation produces a list of frames, the player shows one at a
// time — back, forward, play, scrub — and the topic draws it.

import { h } from "./dom.ts";

export interface Player {
  /** Load a new run with `count` frames and start at `at` (default 0). */
  load(count: number, at?: number): void;
  readonly index: number;
  element: HTMLElement;
  destroy(): void;
}

// With several players on one page, the keyboard drives the one used last (the first one until then).
let active: object | null = null;

export function createPlayer(render: (index: number) => void, options: { label?: string } = {}): Player {
  let count = 0;
  let index = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let speed = 2; // steps per second

  const first = button("⏮", "First step (Home)", () => go(0));
  const prev = button("‹", "Previous step (←)", () => go(index - 1));
  const play = button("▶", "Play / pause (space)", () => (timer ? stop() : start()));
  const next = button("›", "Next step (→)", () => go(index + 1));
  const last = button("⏭", "Last step (End)", () => go(count - 1));
  const slider = h("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "Step", oninput: () => go(Number(slider.value)) });
  const position = h("span", { class: "player-position", "aria-live": "polite" });
  const speedSelect = h("select", { "aria-label": "Speed", onchange: () => {
    speed = Number(speedSelect.value);
    if (timer) start();
  } }, ...[0.5, 1, 2, 4, 8].map((v) => h("option", { value: v, selected: v === speed }, `${v}×`)));

  const element = h("div", { class: "player", role: "group", "aria-label": options.label ?? "Step through the simulation" },
    first, prev, play, next, last, slider, position, speedSelect);

  function button(text: string, title: string, onclick: () => void): HTMLButtonElement {
    return h("button", { type: "button", title, "aria-label": title, onclick }, text);
  }

  function go(i: number): void {
    if (count === 0) return;
    index = Math.max(0, Math.min(count - 1, i));
    if (index === count - 1) stop();
    slider.value = String(index);
    position.textContent = `step ${index + 1} of ${count}`;
    slider.setAttribute("aria-valuetext", position.textContent); // the value is 0-based; say "step 1", not "0"
    // aria-disabled rather than disabled: a disabled button would drop keyboard focus at the first/last step.
    for (const b of [first, prev]) b.setAttribute("aria-disabled", String(index === 0));
    for (const b of [next, last]) b.setAttribute("aria-disabled", String(index === count - 1));
    render(index);
  }

  function start(): void {
    clearInterval(timer);
    if (index === count - 1) go(0);
    timer = setInterval(() => go(index + 1), 1000 / speed);
    play.textContent = "❚❚";
    // While playing, stop announcing every step to screen readers (at 8× it never stops talking): the
    // position, and the page's own live notes, which describe each step.
    position.setAttribute("aria-live", "off");
    for (const el of document.querySelectorAll("[aria-live=polite]")) {
      el.setAttribute("aria-live", "off");
      el.setAttribute("data-quiet", "");
    }
  }

  function stop(): void {
    clearInterval(timer);
    timer = undefined;
    play.textContent = "▶";
    position.setAttribute("aria-live", "polite");
    for (const el of document.querySelectorAll("[data-quiet]")) {
      el.setAttribute("aria-live", "polite");
      el.removeAttribute("data-quiet");
    }
  }

  const self = {};
  active ??= self;
  element.addEventListener("pointerdown", () => (active = self));
  element.addEventListener("focusin", () => (active = self));

  // Keyboard: ← and → step from anywhere on the page (unless typing in a field). Home, End and space
  // only when focus is inside the player — on the page they scroll, and must keep doing so.
  function onKey(e: KeyboardEvent): void {
    if (active !== self || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) && target !== slider) return;
    const inside = !!target && element.contains(target);
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (inside && e.key === "Home") go(0);
    else if (inside && e.key === "End") go(count - 1);
    else if (inside && e.key === " " && target?.tagName !== "BUTTON") (timer ? stop : start)();
    else return;
    e.preventDefault();
  }
  document.addEventListener("keydown", onKey);

  return {
    element,
    get index() {
      return index;
    },
    load(n: number, at = 0) {
      stop();
      count = n;
      slider.max = String(Math.max(0, n - 1));
      go(at);
    },
    destroy() {
      stop();
      document.removeEventListener("keydown", onKey);
      if (active === self) active = null;
    },
  };
}
