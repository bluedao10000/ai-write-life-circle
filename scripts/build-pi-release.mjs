// Local packaging only. Does not connect to or modify any server.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const run = (args) => {
  const r = spawnSync("pnpm", args, { stdio: "inherit" });
  if (r.status !== 0) throw Error("Pi packaging failed");
};
if (
  spawnSync("git", ["diff", "--quiet"]).status !== 0 ||
  spawnSync("git", ["diff", "--cached", "--quiet"]).status !== 0 ||
  spawnSync("git", ["ls-files", "--error-unmatch", "apps/agent/src/main.ts"], {
    stdio: "ignore",
  }).status !== 0
)
  throw Error("Commit Agent source and tracked changes before packaging");
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const target = resolve(process.argv.slice(2).find(arg=>arg!=="--") ?? `.local/pi-releases/${revision}`);
if (await stat(target).catch(() => null))
  throw Error(
    "Choose a new release directory; existing release is never overwritten",
  );
run(["build:agent"]);
run([
  "--filter",
  "@writer-agent/agent",
  "deploy",
  "--prod",
  "--legacy",
  target,
]);
const hash = createHash("sha256")
  .update(await readFile(join(target, "dist/main.js")))
  .digest("hex");
const files = {};
for (const dir of ["dist", "skills"])
  for (const file of (
    await readdir(join(target, dir), { recursive: true })
  ).sort()) {
    const name = dir + "/" + file;
    if ((await stat(join(target, name))).isFile())
      files[name] = createHash("sha256")
        .update(await readFile(join(target, name)))
        .digest("hex");
  }
files["package.json"] = createHash("sha256")
  .update(await readFile(join(target, "package.json")))
  .digest("hex");
await writeFile(
  join(target, "release.json"),
  JSON.stringify(
    {
      protocol: "thinking-v1",
      taskProtocol: "agent-tasks-v1",
      revision,
      node: ">=22.19.0",
      mainSHA256: hash,
      files,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
const probe = spawnSync(
  process.execPath,
  [join(target, "dist/main.js"), "--version"],
  { encoding: "utf8" },
);
if (probe.status !== 0 || probe.stdout.trim() !== "thinking-v1")
  throw Error("Packaged protocol probe failed");
console.log(`Prepared private Pi release: ${target}`);

const workerProbe=spawnSync(process.execPath,[join(target,"dist/worker/main.js"),"--version"],{encoding:"utf8"});
if(workerProbe.status!==0||workerProbe.stdout.trim()!=="agent-tasks-v1")throw Error("Packaged background protocol probe failed");
