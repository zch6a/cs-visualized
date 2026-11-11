export type Area = "Operating systems" | "Networking" | "Databases" | "Distributed systems";

export const AREAS: readonly Area[] = ["Operating systems", "Networking", "Databases", "Distributed systems"];

export interface Topic {
  /** URL fragment: #/paging */
  id: string;
  title: string;
  area: Area;
  /** One line for the index. */
  blurb: string;
  /** Build the page inside `root`; return a cleanup function. */
  mount(root: HTMLElement): () => void;
}
