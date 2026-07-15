import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const config = loadConfig();
try {
  const info = await stat(join(config.DATA_DIR,"heartbeat.json"));
  if (Date.now()-info.mtimeMs > 60_000) throw new Error("heartbeat is stale");
  process.exit(0);
} catch (error) {
  console.error(error); process.exit(1);
}
