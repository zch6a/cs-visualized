// The site: a list of topics and a hash router (#/paging). Each topic builds its own page.

import { bplustree } from "./topics/bplustree.ts";
import { congestion } from "./topics/congestion.ts";
import { hashing } from "./topics/hashing.ts";
import { isolation } from "./topics/isolation.ts";
import { paging } from "./topics/paging.ts";
import { raft } from "./topics/raft.ts";
import { scheduling } from "./topics/scheduling.ts";
import { transport } from "./topics/transport.ts";
import { AREAS, type Topic } from "./topics/topic.ts";
import { h, prose, replace } from "./ui/dom.ts";

const TOPICS: Topic[] = [paging, scheduling, congestion, transport, bplustree, isolation, hashing, raft];

const nav = document.getElementById("nav")!;
const main = document.getElementById("main")!;
let cleanup: (() => void) | undefined;

function renderNav(active: string): void {
  replace(nav, ...AREAS.filter((area) => TOPICS.some((t) => t.area === area)).map((area) =>
    h("section", {}, h("h2", {}, area), h("ul", {}, ...TOPICS.filter((t) => t.area === area).map((t) =>
      h("li", {}, h("a", { href: `#/${t.id}`, "aria-current": t.id === active ? "page" : null }, t.title)))))));
  // On a phone the list is one sideways-scrolling row: bring the current topic into view.
  const current = nav.querySelector<HTMLElement>("[aria-current]");
  if (current) nav.scrollLeft = current.offsetLeft - nav.clientWidth / 2 + current.offsetWidth / 2;
}

function renderHome(): void {
  replace(main,
    h("h1", {}, "Computer science you can step through"),
    prose("Each page is a small, tested simulation of something every engineer is taught and few have watched happen: step forward and back, change the input, and see exactly where the textbook answer comes from."),
    h("div", { class: "howto" },
      h("h2", {}, "How to use a page"),
      h("ol", {},
        h("li", {}, prose("Pick a *preset* — each one is set up to show one thing (an anomaly, a failure, a textbook example).")),
        h("li", {}, prose("Step through it with the player: `←` `→` step; with the player focused, `Home` `End` jump and `space` plays — or use the buttons and the slider. Every step says what happened and why.")),
        h("li", {}, prose("Change the input and watch the outcome move. The table at the bottom of each page compares every policy or level on the same input.")),
        h("li", {}, prose("*Things to try* at the end are questions with answers you can find on the page.")))),
    ...AREAS.filter((area) => TOPICS.some((t) => t.area === area)).map((area) =>
      h("section", { class: "cards" }, h("h2", {}, area), ...TOPICS.filter((t) => t.area === area).map((t) =>
        h("a", { class: "card", href: `#/${t.id}` }, h("h3", {}, t.title), h("p", {}, t.blurb))))),
  );
}

function route(): void {
  cleanup?.();
  cleanup = undefined;
  const id = location.hash.replace(/^#\/?/, "");
  const topic = TOPICS.find((t) => t.id === id);
  renderNav(topic?.id ?? "");
  if (topic) {
    document.title = `${topic.title} · CS, visualized`;
    cleanup = topic.mount(main);
  } else {
    document.title = "CS, visualized";
    renderHome();
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// "Skip to content" must not go through the hash router (#main would leave the current topic).
document.querySelector<HTMLAnchorElement>(".skip")?.addEventListener("click", (e) => {
  e.preventDefault();
  main.focus();
});

window.addEventListener("hashchange", route);
route();
