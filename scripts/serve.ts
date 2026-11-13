// A small static server for dist/. With --watch, rebuilds when src/ or public/ changes.
//
//   npm run serve            # http://localhost:5173
//   PORT=8080 npm run serve
import { createReadStream, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const port = Number(process.env.PORT ?? 5173);
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

createServer((req, res) => {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400).end(); // a malformed URL must not take the server down
    return;
  }
  let file = normalize(join(dist, path));
  // ":" would reach Windows' alternate data streams (style.css::$DATA); no file of the site has one.
  if ((!file.startsWith(dist + sep) && file !== dist) || path.includes(":")) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
  // This computer only: a preview server has no business answering the rest of the network.
}).listen(port, "127.0.0.1", () => console.log(`serving dist/ on http://localhost:${port}`));

if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    try {
      console.log(build() ? "rebuilt" : "build failed — fix the error and save again");
    } catch (e) {
      console.error(`build crashed: ${(e as Error).message}`); // keep serving the last good build
    }
  };
  for (const dir of ["src", "public"]) {
    watch(join(root, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 150);
    });
  }
  console.log("watching src/ and public/");
}
