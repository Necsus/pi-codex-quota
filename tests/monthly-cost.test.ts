import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test file runs in its own process; never read real Pi session histories.
const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-quota-cost-"));
after(() => rm(agentDir, { recursive: true, force: true }));
const host = `data:text/javascript,${encodeURIComponent(`
	export function getAgentDir() { return ${JSON.stringify(agentDir)}; }
`)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: host, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { MonthlyCostReader } = await import("../src/codex-quota-support/monthly-cost.ts");

async function fixture(t: TestContext) {
	const sessionDir = join(agentDir, "sessions");
	await mkdir(sessionDir);
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	return {
		reader: new MonthlyCostReader(),
		sessionDir,
		write: (contents: string) => writeFile(join(sessionDir, "session.jsonl"), contents, "utf8"),
	};
}

function paidEntry(id: string, total: number, text = "test") {
	return {
		type: "message", id, timestamp: new Date().toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total } } },
	};
}

for (const ending of ["\n", "\r\n"]) {
	test(`reads ${ending === "\n" ? "LF" : "CRLF"} records, blank lines and a final record without a newline`, async (t) => {
		const app = await fixture(t);
		await app.write([
			JSON.stringify(paidEntry("first", 1.25)),
			"",
			JSON.stringify(paidEntry("second", 2.5, "escaped newline\nand carriage return\r")),
		].join(ending));
		const result = await app.reader.read(app.sessionDir);
		assert.equal(result.total, 3.75);
		assert.equal(result.incomplete, false);
	});
}

for (const separator of ["\u2028", "\u2029"]) {
	const name = `U+${separator.charCodeAt(0).toString(16).toUpperCase()}`;
	test(`preserves ${name} inside custom records and paid messages, including cached reads`, async (t) => {
		const app = await fixture(t);
		await app.write([
			JSON.stringify({
				type: "custom", customType: "web-search-results", timestamp: new Date().toISOString(),
				data: { text: `before${separator}after` },
			}),
			JSON.stringify(paidEntry("unicode", 1.25, `before${separator}after`)),
			JSON.stringify(paidEntry("plain", 2.5)),
		].join("\n") + "\n");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await app.reader.read(app.sessionDir);
			assert.equal(result.total, 3.75);
			assert.equal(result.incomplete, false);
		}
	});
}

test("preserves a Unicode separator spanning UTF-8 stream chunks in a large record", async (t) => {
	const app = await fixture(t);
	const entry = paidEntry("large", 4, "MARKER");
	const json = JSON.stringify(entry);
	const marker = json.indexOf("MARKER");
	const prefixBytes = Buffer.byteLength(json.slice(0, marker));
	const text = "x".repeat(64 * 1024 - prefixBytes - 1) + "\u2028\u2029" + "y".repeat(128 * 1024);
	await app.write(JSON.stringify(paidEntry("large", 4, text)) + "\n" + JSON.stringify(paidEntry("next", 2)));
	const result = await app.reader.read(app.sessionDir);
	assert.equal(result.total, 6);
	assert.equal(result.incomplete, false);
});

test("still marks malformed JSON as incomplete and retains readable costs", async (t) => {
	const app = await fixture(t);
	await app.write([
		JSON.stringify(paidEntry("first", 1.25)),
		'{"type":',
		JSON.stringify(paidEntry("second", 2.5)),
	].join("\n"));
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await app.reader.read(app.sessionDir);
		assert.equal(result.total, 3.75);
		assert.equal(result.incomplete, true);
	}
});

test("does not treat a bare carriage return as a JSONL record boundary", async (t) => {
	const app = await fixture(t);
	await app.write(JSON.stringify(paidEntry("first", 1)) + "\r" + JSON.stringify(paidEntry("second", 2)));
	const result = await app.reader.read(app.sessionDir);
	assert.equal(result.total, 0);
	assert.equal(result.incomplete, true);
});

test("clears the cached incomplete flag when a malformed file is corrected", async (t) => {
	const app = await fixture(t);
	await app.write('{"type":');
	assert.equal((await app.reader.read(app.sessionDir)).incomplete, true);
	await app.write(JSON.stringify(paidEntry("corrected", 2.5, "valid\u2028record")));
	const result = await app.reader.read(app.sessionDir);
	assert.equal(result.total, 2.5);
	assert.equal(result.incomplete, false);
});
