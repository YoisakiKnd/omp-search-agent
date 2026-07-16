import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { assertHealthyHeartbeat } from "./health.ts";

const config = loadConfig();
try {
  const heartbeat: unknown = JSON.parse(await readFile(join(config.DATA_DIR,"heartbeat.json"), "utf8"));
  assertHealthyHeartbeat(heartbeat, Date.now(), config.HEALTH_STALE_MS);
  process.exit(0);
} catch (error) {
  console.error(error); process.exit(1);
}
