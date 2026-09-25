import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "watch-targets.yml");

export const WATCH_TARGETS = load(readFileSync(CONFIG_PATH, "utf8"));
