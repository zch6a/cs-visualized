import { describe, LEVELS, parseSchedule, run, SCENARIOS, type Level, type Outcome, type Schedule } from "../sim/isolation.ts";
import { h, prose, replace } from "../ui/dom.ts";
import { createPlayer } from "../ui/player.ts";
import type { Topic } from "./topic.ts";

const EXPLAIN: Record<Level, string> = {
  "Read Uncommitted": "*Read Uncommitted*: a read returns the newest value, even one another transaction has not committed — and might still roll back.",
  "Read Committed": "*Read Committed*: a read returns the newest *committed* value at that moment. The default in PostgreSQL, Oracle and SQL Server. Two reads of the same row can disagree.",
  Snapshot: "*Snapshot isolation*: a transaction reads the database as it was when the transaction began, and of two transactions writing the same row, the second to commit is aborted. PostgreSQL's REPEATABLE READ (and Oracle's SERIALIZABLE) is this.",
  Serializable: "*Serializable*: snapshot reads, plus a check at commit — if anything this transaction read or wrote was changed by a transaction that committed since it began, it is aborted. Every outcome equals running the committed transactions one at a time, in some order.",
};

export const isolation: Topic = {
  id: "isolation",
  title: "Transaction isolation",
  area: "Databases",
  blurb: "Dirty reads, lost updates and write skew — run the same interleaving at four isolation levels and see which anomalies each one lets through.",
  mount(root) {
    let level: Level = "Read Committed";
    let scenario: keyof typeof SCENARIOS = "lostUpdate";
    let schedule: Schedule;
    let outcome: Outcome;

    const input = h("textarea", { rows: 9, class: "procs", spellcheck: "false", "aria-label": "Schedule" }, SCENARIOS.lostUpdate.schedule);
    const about = h("div", { class: "explain" });
    const levelButtons = LEVELS.map((l) => h("button", { type: "button", class: "segment", "aria-pressed": String(l === level), onclick: () => {
      level = l;
      rerun(player.index);
    } }, l));
    const levelText = h("div", { class: "explain" });
    const error = h("p", { class: "error", role: "alert" });
    const table = h("div", { class: "grid-scroll" });
    const state = h("div", { class: "db-state" });
    const note = h("p", { class: "note", "aria-live": "polite" });
    const verdict = h("div", { class: "verdict" });
    const compare = h("div", { class: "compare" });
    const player = createPlayer(draw, { label: "Step through the schedule" });
    input.addEventListener("change", () => {
      scenario = undefined as unknown as keyof typeof SCENARIOS;
      rerun();
    });

    replace(root,
      h("h1", {}, "Transaction isolation"),
      prose("A database runs many transactions at once, and their reads and writes interleave. Each transaction wants to behave as if it were alone. *Isolation levels* are the trade-off: the stronger the level, the fewer surprises a transaction can see — and the more transactions the database has to abort or make wait. Pick a classic anomaly, then switch between levels."),
      h("div", { class: "presets" }, "Anomaly: ", ...Object.entries(SCENARIOS).map(([key, sc]) => h("button", { type: "button", class: "link", onclick: () => {
        scenario = key as keyof typeof SCENARIOS;
        input.value = sc.schedule;
        rerun();
      } }, sc.name))),
      about,
      h("div", { class: "controls" }, h("div", { class: "segments", role: "group", "aria-label": "Isolation level" }, ...levelButtons)),
      levelText,
      h("details", {}, h("summary", {}, "Edit the schedule"),
        prose("One operation per line: `T1 read x`, `T1 write x = x + 1` (from the value this transaction read), `T1 write x = 5`, `T1 commit`, `T1 abort`; and `init x=10 y=0` for starting values."),
        input),
      error,
      player.element,
      h("div", { class: "split" }, table, state),
      note,
      verdict,
      h("h2", {}, "The same schedule at every level"),
      compare,
      h("h2", {}, "Things to try"),
      h("ul", {},
        h("li", {}, prose("*Lost update* at Read Committed ends with x = 11: one increment vanished, and no error was raised. This is the bug behind many double-booking and inventory-count incidents. Which levels catch it, and how?")),
        h("li", {}, prose("*Write skew* gets through snapshot isolation: the two transactions wrote *different* rows, so first-committer-wins sees no conflict — yet the rule is broken. Only Serializable stops it.")),
        h("li", {}, prose("Under Serializable, an abort is not a failure — the application retries the transaction. Edit a schedule so that both transactions survive at Serializable.")),
      ),
    );

    rerun();
    return () => player.destroy();

    function rerun(at = 0): void {
      try {
        schedule = parseSchedule(input.value);
        outcome = run(schedule, level);
        error.textContent = "";
      } catch (e) {
        error.textContent = (e as Error).message;
        return;
      }
      levelButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(LEVELS[i] === level)));
      replace(levelText, prose(EXPLAIN[level]));
      replace(about, scenario ? prose(`*${SCENARIOS[scenario].name}.* ${SCENARIOS[scenario].about}`) : prose("Your own schedule."));
      player.load(outcome.steps.length, Math.min(at, outcome.steps.length - 1));
      drawCompare();
    }

    function draw(index: number): void {
      const txNames = [...new Set(schedule.ops.map((o) => o.tx))];
      const step = outcome.steps[index]!;
      replace(table, h("table", { class: "interleave" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...txNames.map((t) => h("th", { scope: "col" }, t)))),
        h("tbody", {}, ...outcome.steps.map((st, i) => h("tr", { class: i === index ? "now" : i > index ? "future" : "" },
          h("th", { scope: "row" }, String(i + 1)),
          ...txNames.map((t) => {
            if (st.op.tx !== t) return h("td", {});
            const done = i <= index;
            const result = st.text.replace(new RegExp(`^${t} `), "");
            return h("td", { class: [st.skipped ? "skipped" : "", /aborted|aborts/.test(st.text) ? "abort" : "", /commits$/.test(st.text) ? "commit" : ""].join(" ") }, done ? result : describe(st.op));
          }))))));
      replace(state,
        h("h3", {}, "Committed in the database"),
        h("table", { class: "kv" }, ...Object.entries(step.committed).map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, String(v))))),
        ...Object.entries(step.txs).map(([name, tx]) => h("div", { class: `tx ${tx.status}` },
          h("h3", {}, `${name} — ${tx.status}`),
          Object.keys(tx.writes).length && tx.status === "active" ? h("p", {}, "private writes: ", Object.entries(tx.writes).map(([k, v]) => `${k} = ${v}`).join(", ")) : null,
          tx.abortReason && tx.status === "aborted" ? h("p", { class: "reason" }, tx.abortReason) : null)));
      replace(note, prose(step.note));
      if (index === outcome.steps.length - 1) drawVerdict();
      else replace(verdict);
    }

    function drawVerdict(): void {
      const committed = Object.keys(outcome.txs).filter((t) => outcome.txs[t]!.status === "committed");
      const aborted = Object.keys(outcome.txs).filter((t) => outcome.txs[t]!.status === "aborted");
      const final = Object.entries(outcome.final).map(([k, v]) => `${k} = ${v}`).join(", ");
      const order = outcome.serialOrder;
      replace(verdict,
        h("h2", {}, "Outcome"),
        prose(`Final state: \`${final}\`. Committed: ${committed.join(", ") || "none"}${aborted.length ? `; aborted: ${aborted.join(", ")}` : ""}.`),
        order
          ? h("p", { class: "ok" }, `✓ Serializable: the same reads and final state as running ${order.length ? order.join(" then ") : "nothing"} one after the other.`)
          : h("p", { class: "bad" }, "✗ Not serializable: no order of running the committed transactions one at a time gives these reads and this final state. That is an anomaly."));
    }

    function drawCompare(): void {
      replace(compare, h("table", { class: "compare-table" },
        h("thead", {}, h("tr", {}, ...["level", "final state", "aborted", "serializable?"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, ...LEVELS.map((l) => {
          const o = run(schedule, l);
          const aborted = Object.keys(o.txs).filter((t) => o.txs[t]!.status === "aborted");
          return h("tr", { class: l === level ? "chosen" : "" }, h("th", { scope: "row" }, l),
            h("td", { class: "mono" }, Object.entries(o.final).map(([k, v]) => `${k}=${v}`).join(" ")),
            h("td", {}, aborted.join(", ") || "—"),
            h("td", { class: o.serialOrder ? "best" : "anomaly" }, o.serialOrder ? `yes (${o.serialOrder.join(" → ") || "none"})` : "no"));
        }))));
    }
  },
};
