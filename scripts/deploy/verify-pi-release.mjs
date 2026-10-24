import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const target = resolve(process.argv[2] ?? "/opt/writer-agent-pi/current"),
  m = JSON.parse(await readFile(join(target, "release.json"), "utf8"));
const [major, minor] = process.versions.node.split(".").map(Number);
if (
  major < 22 ||
  (major === 22 && minor < 19) ||
  m.protocol !== "thinking-v1" ||
  !/^[a-f0-9]{40}$/.test(m.revision) ||
  createHash("sha256")
    .update(await readFile(join(target, "dist/main.js")))
    .digest("hex") !== m.mainSHA256
)
  throw Error("Pi release verification failed");
console.log(JSON.stringify({ protocol: m.protocol, revision: m.revision }));

for (const [name, hash] of Object.entries(m.files ?? {})) {
  if (
    !/^(dist|skills)\/[A-Za-z0-9_./-]+$/.test(name) &&
    name !== "package.json"
  )
    throw Error("Invalid release manifest");
  if (
    name.split("/").includes("..") ||
    createHash("sha256")
      .update(await readFile(join(target, name)))
      .digest("hex") !== hash
  )
    throw Error("Pi release content mismatch");
}

if(process.argv.includes('--worker')&&(m.taskProtocol!=='agent-tasks-v1'||!m.files?.['dist/worker/main.js']))throw Error('Compatible background Worker release required');
