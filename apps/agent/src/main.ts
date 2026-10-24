import { loadConfig } from "./config.js";
import { Store } from "./sessions/store.js";
import { PiHost } from "./runtime/pi-host.js";
import { server } from "./server/http.js";
async function main() {
  if (process.argv.includes("--version")) {
    console.log("thinking-v1");
    return;
  }
  const config = loadConfig();
  if (process.argv.includes("--check-config")) {
    console.log(
      JSON.stringify({
        protocol: "thinking-v1",
        version: config.version,
        model: config.model,
      }),
    );
    return;
  }
  if (process.argv.includes("--healthcheck")) {
    const r = await fetch(
      `http://127.0.0.1:${config.port}/internal/v1/health`,
      {
        headers: { Authorization: "Bearer " + config.token },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!r.ok) throw Error("HEALTHCHECK_FAILED");
    return;
  }
  const host = new PiHost(config, new Store(config.state)),
    http = server(host);
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, "127.0.0.1", resolve);
  });
  console.log(
    JSON.stringify({
      event: "agent_started",
      protocol: "thinking-v1",
      version: config.version,
      port: config.port,
    }),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    http.close();
    await host.close();
    http.closeAllConnections();
  };
  process.on("SIGTERM", () => {
    void close();
  });
  process.on("SIGINT", () => {
    void close();
  });
}
main().catch(() => {
  console.error(
    JSON.stringify({ event: "agent_stopped", code: "STARTUP_FAILED" }),
  );
  process.exitCode = 1;
});
