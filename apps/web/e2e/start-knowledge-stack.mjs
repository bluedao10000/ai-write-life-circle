import { startKnowledgeFixture } from "../../../scripts/lib/knowledge-fixture.mjs";
import { spawn } from "node:child_process";
const fixture = await startKnowledgeFixture({ apiPort: 8796 });
const vite = spawn(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", "5186"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_WRITER_AGENT_MODE: "api",
      VITE_WRITER_AGENT_AUTH: "",
      VITE_STORY2U_PUBLIC_SITE: "true",
      VITE_WRITER_AGENT_PROJECT_ID: "synthetic-memory",
      WRITER_AGENT_API_TARGET: fixture.api,
    },
  },
);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  vite.kill("SIGTERM");
  await fixture.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void close());
vite.once("exit", () => void close());
