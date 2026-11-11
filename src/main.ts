// The site: a list of topics and a hash router (#/paging). Each topic builds its own page.

import { paging } from "./topics/paging.ts";
import { scheduling } from "./topics/scheduling.ts";
import { AREAS, type Topic } from "./topics/topic.ts";
import { h, prose, replace } from "./ui/dom.ts";

const TOPICS: Topic[] = [paging, scheduling];

const nav = document.getElementById("nav")!;
const main = document.getElementById("main")!;
let cleanup: (() => void) | undefined;

function renderNav(active: string): void {
  replace(nav, ...AREAS.filter((area) => TOPICS.some((t) => t.area === area)).map((area) =>
    h("section", {}, h("h2", {}, area), h("ul", {}, ...TOPICS.filter((t) => t.area === area).map((t) =>
      h("li", {}, h("a", { href: `#/${t.id}`, "aria-current": t.id === active ? "page" : null }, t.title)))))));
}

function renderHome(): void {
  replace(main,
    h("h1", {}, "Computer science you can step through"),
    prose("Each page is a small, tested simulation of something every engineer is taught and few have watched happen: step forward and back, change the input, and see exactly where the textbook answer comes from."),
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

window.addEventListener("hashchange", route);
route();
