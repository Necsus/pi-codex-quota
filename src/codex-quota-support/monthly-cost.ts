import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type CostEntry = { key: string; cost: number };
type CachedFile = { signature: string; entries: CostEntry[]; incomplete: boolean };
export type MonthlyCost = { month: string; label: string; total: number; incomplete: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

export class MonthlyCostReader {
	private cache = new Map<string, CachedFile>();

	async read(currentSessionDir: string): Promise<MonthlyCost> {
		const now = new Date();
		const year = now.getFullYear();
		const monthIndex = now.getMonth();
		const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
		const start = new Date(year, monthIndex, 1).getTime();
		const end = new Date(year, monthIndex + 1, 1).getTime();
		const result: MonthlyCost = {
			month,
			label: now.toLocaleDateString("fr-FR", { month: "short", year: "numeric" }),
			total: 0,
			incomplete: false,
		};
		const root = resolve(getAgentDir(), "sessions");
		const extra = resolve(currentSessionDir);
		const roots = [root];
		const rel = relative(root, extra);
		if (rel.startsWith("..") || resolve(root, rel) !== extra) roots.push(extra);
		const files = new Set<string>();
		async function discover(directory: string) {
			try {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) await discover(path);
					else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(path);
				}
			} catch {
				result.incomplete = true;
			}
		}
		for (const directory of roots) await discover(directory);
		const seen = new Set<string>();
		for (const file of files) {
			try {
				const info = await stat(file);
				const signature = `${month}:${info.size}:${info.mtimeMs}`;
				let cached = this.cache.get(file);
				if (cached?.signature !== signature) {
					cached = { signature, entries: [], incomplete: false };
					const stream = createReadStream(file, { encoding: "utf8" });
					const lines = createInterface({ input: stream, crlfDelay: Infinity });
					try {
						for await (const line of lines) {
							if (!line.trim()) continue;
							try {
								const entry = record(JSON.parse(line));
								if (!entry || typeof entry.timestamp !== "string") continue;
								const timestamp = Date.parse(entry.timestamp);
								if (!(timestamp >= start && timestamp < end)) continue;
								const message = record(entry.message);
								// Pi also records paid nested tools, compactions and summaries outside assistant messages.
								const usage = record(entry.usage) ?? record(message?.usage);
								const cost = record(usage?.cost)?.total;
								if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue;
								const key = typeof entry.id === "string"
									? JSON.stringify([entry.id, entry.timestamp, entry.type, message?.role, message?.provider, message?.model, message?.responseId])
									: `${file}:${cached.entries.length}`;
								cached.entries.push({ key, cost });
							} catch {
								cached.incomplete = true;
							}
						}
					} finally {
						lines.close();
						stream.destroy();
					}
					// Cache only metadata and costs; never retain prompts, responses or credentials.
					this.cache.set(file, cached);
				}
				result.incomplete ||= cached.incomplete;
				for (const entry of cached.entries) {
					if (seen.has(entry.key)) continue;
					seen.add(entry.key);
					result.total += entry.cost;
				}
			} catch {
				result.incomplete = true;
			}
		}
		for (const file of this.cache.keys()) if (!files.has(file)) this.cache.delete(file);
		return result;
	}
}
