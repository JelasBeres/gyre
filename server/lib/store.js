// Owner settings (set from /studio) and small per-user state, persisted as JSON files in data/.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export class Store {
  constructor(dir, name, defaults) { this.file = path.join(dir, name); this.dir = dir; this.defaults = defaults; this.data = structuredClone(defaults); this.saving = Promise.resolve(); }
  async load() { try { const d = JSON.parse(await readFile(this.file, "utf8")); this.data = { ...structuredClone(this.defaults), ...d }; } catch {} return this.data; }
  save() { this.saving = this.saving.then(async () => { await mkdir(this.dir, { recursive: true }); await writeFile(this.file + ".tmp", JSON.stringify(this.data, null, 1), { mode: 0o600 }); await rename(this.file + ".tmp", this.file); }).catch((e) => console.error("store save", e.message)); return this.saving; }
}

export const SETTINGS_DEFAULT = {
  token: "",                       // $NUCLEO contract address, set from the studio; empty = not launched yet
  tiers: { holderBps: 10, plusBps: 50 }, // 0.1% and 0.5% of supply
  modules: { scan: true, rug: true, radar: true, guard: true, smart: true, ask: true, dev: true, brief: true, pnl: true, snipe: true, launch: true, creator: true, cli: true, fees: true, market: true },
  banner: { text: "", link: "", on: false },
  agent: { briefTime: "07:00", lang: "en" },
  quotas: { freePerDay: 25, holderPerDay: 300, plusPerDay: 1000 },
};
