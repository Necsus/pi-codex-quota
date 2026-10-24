import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Minimal host UI stubs keep tests independent of a Pi install and real session histories.
const host = `data:text/javascript,${encodeURIComponent(`
	export function getAgentDir() { throw new Error("Tests must not read real sessions"); }
	export function visibleWidth(text) { return Array.from(text).length; }
	export function truncateToWidth(text, width, ellipsis = "") {
		if (visibleWidth(text) <= width) return text;
		return Array.from(text).slice(0, Math.max(0, width - visibleWidth(ellipsis))).join("") + ellipsis;
	}
`)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"].includes(specifier)) {
			return { url: host, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { default: extension } = await import("../src/codex-quota.ts");
const { MonthlyCostReader } = await import("../src/codex-quota-support/monthly-cost.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;

const accessToken = `header.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const codexUsage = { rate_limit: {
	primary_window: { limit_window_seconds: 18_000, used_percent: 18 },
	secondary_window: { limit_window_seconds: 604_800, used_percent: 36 },
} };
const anthropicUsage = { five_hour: { utilization: 25 }, seven_day: { utilization: 50 } };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function harness(t: TestContext, provider = "openai-codex", mode = "tui") {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const statuses: (string | undefined)[] = [];
	const notifications: string[] = [];
	const authProviders: string[] = [];
	const date = new Date();
	const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
	const costMock = t.mock.method(MonthlyCostReader.prototype, "read", async () => ({
		month, label: "test", total: 12.34, incomplete: false,
	}));
	const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { value: 240, configurable: true, writable: true });
	let context = {
		mode,
		model: { provider, id: "test-model" },
		modelRegistry: {
			isUsingOAuth: (_model: unknown) => true,
			getProviderAuth: async (id: string) => {
				authProviders.push(id);
				return { auth: { apiKey: accessToken } };
			},
		},
		sessionManager: { getSessionDir: () => "unused-test-sessions" },
		ui: {
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
			theme: { fg: (_color: string, text: string) => text },
			notify: (text: string) => { notifications.push(text); },
		},
	};
	extension({
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: Command }) => { commands.set(name, command.handler); },
	} as unknown as ExtensionAPI);
	function emit(name: string) {
		return handlers.get(name)!({}, context as unknown as ExtensionContext);
	}
	t.after(() => {
		emit("session_shutdown");
		if (columns) Object.defineProperty(process.stdout, "columns", columns);
		else Reflect.deleteProperty(process.stdout, "columns");
	});
	return {
		get context() { return context; },
		statuses, notifications, authProviders, costMock,
		text: () => (statuses.at(-1) ?? "").replaceAll("\u00a0", " "),
		start: () => emit("session_start"),
		stop: () => emit("session_shutdown"),
		settle: () => emit("agent_settled"),
		select(id: string) {
			context = { ...context, model: { provider: id, id: "next-model" } };
			return emit("model_select");
		},
		quota: () => commands.get("quota")!("", context as unknown as ExtensionContext),
	};
}

for (const [provider, payload, label, percent, endpoint] of [
	["openai-codex", codexUsage, "Codex", 82, "https://chatgpt.com/backend-api/wham/usage"],
	["anthropic", anthropicUsage, "Anthropic", 75, "https://api.anthropic.com/api/oauth/usage"],
] as const) {
	test(`${provider}: displays remaining quotas, uses its own auth and supports /quota`, async (t) => {
		const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(payload));
		const app = harness(t, provider);
		app.start();
		await flush();
		assert.match(app.text(), new RegExp(`${label} restant · 5h : ${percent}%`));
		assert.match(app.text(), /hebdo : /);
		assert.match(app.text(), /≈12,34 \$/);
		assert.deepEqual(app.authProviders, [provider]);
		const [url, options] = fetchMock.mock.calls[0].arguments;
		assert.equal(url, endpoint);
		assert.equal(options?.redirect, "error");
		assert.equal(options?.method, "GET");
		assert.ok(options?.signal instanceof AbortSignal);
		await app.quota();
		assert.equal(fetchMock.mock.callCount(), 2);
		assert.deepEqual(app.authProviders, [provider, provider]);
		app.settle();
		await flush();
		assert.equal(fetchMock.mock.callCount(), 3);
	});

	test(`${provider}: API key authentication cannot request subscription quotas`, async (t) => {
		const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
		const app = harness(t, provider);
		app.context.modelRegistry.isUsingOAuth = () => false;
		app.start();
		await flush();
		assert.match(app.text(), new RegExp(`connexion OAuth ${label} requise`));
		assert.equal(fetchMock.mock.callCount(), 0);
		assert.deepEqual(app.authProviders, []);
	});
}

test("unsupported providers hide only quotas and never request quota auth or network", async (t) => {
	const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
	const app = harness(t, "openrouter");
	app.start();
	await flush();
	assert.match(app.text(), /Pi · .*≈12,34 \$/);
	assert.doesNotMatch(app.text(), /Codex|Anthropic|quota|restant/);
	await app.quota();
	assert.match(app.notifications[0], /fournisseur pris en charge/);
	app.settle();
	await flush();
	assert.equal(fetchMock.mock.callCount(), 0);
	assert.deepEqual(app.authProviders, []);
});

test("non-interactive sessions do not read costs or request quotas", async (t) => {
	const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
	const app = harness(t, "anthropic", "json");
	app.start();
	app.settle();
	await flush();
	assert.equal(app.text(), "");
	assert.equal(app.costMock.mock.callCount(), 0);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("switching providers replaces quota data immediately and hides it for unsupported providers", async (t) => {
	t.mock.method(globalThis, "fetch", async (url) => Response.json(String(url).includes("anthropic") ? anthropicUsage : codexUsage));
	const app = harness(t);
	app.start();
	await flush();
	assert.match(app.text(), /Codex restant/);
	app.select("anthropic");
	assert.match(app.text(), /Anthropic · quotas en cours/);
	assert.doesNotMatch(app.text(), /Codex|82%/);
	await flush();
	assert.match(app.text(), /Anthropic restant · 5h : 75%/);
	app.select("openai");
	await flush();
	assert.doesNotMatch(app.text(), /Codex|Anthropic|quota|restant/);
	assert.match(app.text(), /≈12,34 \$/);
	app.select("openai-codex");
	await flush();
	assert.match(app.text(), /Codex restant · 5h : 82%/);
});

test("late quota responses are cancelled and cannot overwrite a newly selected provider", async (t) => {
	const late = deferred<Response>();
	let oldSignal: AbortSignal | undefined;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		if (String(url).includes("chatgpt")) {
			oldSignal = options?.signal ?? undefined;
			return late.promise;
		}
		return Response.json(anthropicUsage);
	});
	const app = harness(t);
	app.start();
	await flush();
	app.select("anthropic");
	await flush();
	assert.equal(oldSignal?.aborted, true);
	const response = Response.json(codexUsage);
	late.resolve(response);
	await flush();
	assert.equal(response.bodyUsed, true);
	await assert.rejects(response.text(), /Body is unusable/);
	assert.match(app.text(), /Anthropic restant · 5h : 75%/);
	assert.doesNotMatch(app.text(), /Codex|82%/);
});

test("late OAuth resolution cannot initiate a request after the provider is hidden", async (t) => {
	const late = deferred<{ auth: { apiKey: string } }>();
	const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(codexUsage));
	const app = harness(t);
	app.context.modelRegistry.getProviderAuth = () => late.promise;
	app.start();
	await flush();
	app.select("openrouter");
	late.resolve({ auth: { apiKey: accessToken } });
	await flush();
	assert.equal(fetchMock.mock.callCount(), 0);
	assert.doesNotMatch(app.text(), /Codex|Anthropic|quota/);
});

test("late JSON parsing cannot overwrite the newly selected provider's snapshot", async (t) => {
	const late = deferred<typeof codexUsage>();
	const response = Response.json(codexUsage);
	t.mock.method(response, "json", () => late.promise);
	t.mock.method(globalThis, "fetch", async (url) => String(url).includes("chatgpt")
		? response : Response.json(anthropicUsage));
	const app = harness(t);
	app.start();
	await flush();
	app.select("anthropic");
	await flush();
	late.resolve(codexUsage);
	await flush();
	assert.match(app.text(), /Anthropic restant · 5h : 75%/);
	assert.doesNotMatch(app.text(), /Codex|82%/);
});

test("a superseded refresh microtask cannot publish the old provider's OAuth failure", async (t) => {
	const late = deferred<{ auth: { apiKey: string } }>();
	const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(anthropicUsage));
	const app = harness(t);
	app.context.modelRegistry.isUsingOAuth = (model: unknown) => (model as { provider: string }).provider === "anthropic";
	app.context.modelRegistry.getProviderAuth = () => late.promise;
	app.start();
	app.select("anthropic");
	await flush();
	assert.match(app.text(), /Anthropic · quotas en cours/);
	assert.doesNotMatch(app.text(), /Codex|indisponibles/);
	late.resolve({ auth: { apiKey: accessToken } });
	await flush();
	assert.equal(fetchMock.mock.callCount(), 1);
	assert.match(app.text(), /Anthropic restant/);
});

test("transient errors keep the last known quota marked stale, while auth failures clear it", async (t) => {
	let status = 200;
	t.mock.method(globalThis, "fetch", async () => status === 200
		? Response.json(anthropicUsage)
		: new Response("private response body", { status }));
	const app = harness(t, "anthropic");
	app.start();
	await flush();
	status = 500;
	await app.quota();
	assert.match(app.text(), /Anthropic restant\* · 5h : 75%/);
	for (const code of [401, 403]) {
		status = code;
		await app.quota();
		assert.match(app.text(), new RegExp(`quotas indisponibles \\(HTTP ${code}\\)`));
		assert.doesNotMatch(app.text(), /75%|private response body/);
	}
	status = 200;
	await app.quota();
	assert.match(app.text(), /Anthropic restant · 5h : 75%/);
});

test("network and format errors show only a sanitized error, never credentials or response bodies", async (t) => {
	let invalidFormat = false;
	t.mock.method(globalThis, "fetch", async () => {
		if (invalidFormat) return Response.json({ secret: "private payload" });
		throw new Error(`private network details ${accessToken}`);
	});
	const app = harness(t, "anthropic");
	app.start();
	await flush();
	assert.match(app.text(), /réseau, délai ou format de réponse/);
	invalidFormat = true;
	await app.quota();
	assert.match(app.text(), /réseau, délai ou format de réponse/);
	assert.doesNotMatch(app.text(), /private|header\.|signature/);
});

test("partial and expired windows are explicit; stale countdown rendering never fetches", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({
		five_hour: { utilization: 20, resets_at: new Date(now + 60_000).toISOString() },
	}));
	const app = harness(t, "anthropic");
	app.start();
	await flush();
	assert.match(app.text(), /5h : 80% ↻ 1min · hebdo : non communiqué/);
	now += 6 * 60_000;
	process.stdout.emit("resize");
	assert.match(app.text(), /Anthropic restant\* · 5h : à actualiser/);
	assert.equal(fetchMock.mock.callCount(), 1);
	assert.equal(app.costMock.mock.callCount(), 1);
	process.stdout.columns = 32;
	process.stdout.emit("resize");
	assert.ok(Array.from(app.text()).length <= 32);
});

test("concurrent refreshes share one request and shutdown clears status and listeners", async (t) => {
	const late = deferred<Response>();
	const fetchMock = t.mock.method(globalThis, "fetch", () => late.promise);
	const listeners = process.stdout.listenerCount("resize");
	const app = harness(t, "anthropic");
	app.start();
	await flush();
	const command = app.quota();
	app.settle();
	assert.equal(fetchMock.mock.callCount(), 1);
	late.resolve(Response.json(anthropicUsage));
	await command;
	app.stop();
	assert.equal(app.statuses.at(-1), undefined);
	assert.equal(process.stdout.listenerCount("resize"), listeners);
});
