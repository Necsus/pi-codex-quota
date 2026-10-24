import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MonthlyCostReader, type MonthlyCost } from "./codex-quota-support/monthly-cost.ts";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-quota";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const POLL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;

type QuotaWindow = { seconds: number; remaining: number; resetAt?: number };
type Snapshot = { windows: QuotaWindow[]; capturedAt: number };

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseWindows(payload: unknown): QuotaWindow[] {
	const limits = object(object(payload)?.rate_limit);
	const windows: QuotaWindow[] = [];
	for (const raw of [limits?.primary_window, limits?.secondary_window]) {
		const window = object(raw);
		if (!window || !finite(window.used_percent) || !finite(window.limit_window_seconds)) continue;
		// Identify windows by their actual duration, not their position in the response.
		if (window.limit_window_seconds !== 18_000 && window.limit_window_seconds !== 604_800) continue;
		windows.push({
			seconds: window.limit_window_seconds,
			remaining: Math.max(0, Math.min(100, 100 - window.used_percent)),
			resetAt: finite(window.reset_at) && window.reset_at > 0 ? window.reset_at * 1000 : undefined,
		});
	}
	if (windows.length === 0) throw new Error("format de quota non reconnu");
	return windows;
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
		const accountId = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function countdown(milliseconds: number): string {
	const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
	if (minutes >= 1440) return `${Math.floor(minutes / 1440)}j${Math.floor((minutes % 1440) / 60)}h`;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
	return `${minutes}min`;
}

export default function (pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let snapshot: Snapshot | undefined;
	let failure: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let controller: AbortController | undefined;
	let pending: Promise<void> | undefined;
	let lastAttempt = 0;
	let generation = 0;
	let monthlyCost: MonthlyCost | undefined;
	let costReader = new MonthlyCostReader();
	let costPending: Promise<void> | undefined;
	let costFailed = false;

	function render() {
		if (!context || context.mode !== "tui") return;
		const now = Date.now();
		const monthDate = new Date(now);
		const month = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
		const currentCost = monthlyCost?.month === month ? monthlyCost : undefined;
		const label = monthDate.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
		const amount = currentCost ? `≈${currentCost.total.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $` : costFailed ? "indisponible" : "calcul…";
		const left = `Pi · ${label} · ${amount}${currentCost?.incomplete || costFailed ? " · incomplet" : ""}`;
		let right = "";
		if (context.model?.provider === PROVIDER && !snapshot) {
			right = `Codex · quotas ${failure ? `indisponibles (${failure})` : "en cours…"}`;
		} else if (context.model?.provider === PROVIDER && snapshot) {
			const parts = [18_000, 604_800].map((seconds) => {
				const label = seconds === 18_000 ? "5h" : "hebdo";
				const window = snapshot!.windows.find((item) => item.seconds === seconds);
				if (!window) return `${label} : non communiqué`;
				if (window.resetAt !== undefined && window.resetAt <= now) return `${label} : à actualiser`;
				const reset = window.resetAt === undefined ? "" : ` ↻ ${countdown(window.resetAt - now)}`;
				return `${label} : ${Math.floor(window.remaining)}%${reset}`;
			});
			const stale = failure !== undefined || now - snapshot.capturedAt >= POLL_MS + MIN_REFRESH_MS;
			right = `Codex restant · ${parts.join(" · ")}${stale ? " · données périmées" : ""}`;
		}
		const width = Math.max(1, process.stdout.columns || 80);
		const leftText = truncateToWidth(left, width, "…");
		const rightWidth = width - visibleWidth(leftText) - 2;
		const rightText = rightWidth > 0 ? truncateToWidth(right, rightWidth, "…") : "";
		// Pi collapses ordinary spaces in statuses; non-breaking spaces preserve alignment.
		const padding = rightText ? "\u00a0".repeat(Math.max(2, width - visibleWidth(leftText) - visibleWidth(rightText))) : "";
		context.ui.setStatus(STATUS_KEY, context.ui.theme.fg("dim", leftText + padding + rightText));
	}

	function refreshCost(): Promise<void> {
		if (!context || context.mode !== "tui") return Promise.resolve();
		if (costPending) return costPending;
		const currentGeneration = generation;
		costPending = costReader.read(context.sessionManager.getSessionDir()).then((result) => {
			if (currentGeneration !== generation) return;
			monthlyCost = result;
			costFailed = false;
		}).catch(() => {
			if (currentGeneration === generation) costFailed = true;
		}).finally(() => {
			if (currentGeneration !== generation) return;
			costPending = undefined;
			render();
		});
		return costPending;
	}

	function refresh(force = false): Promise<void> {
		const ctx = context;
		if (!ctx || ctx.mode !== "tui" || ctx.model?.provider !== PROVIDER) return Promise.resolve();
		if (pending) return pending;
		if (!force && Date.now() - lastAttempt < MIN_REFRESH_MS) return Promise.resolve();
		lastAttempt = Date.now();
		const currentGeneration = generation;
		const request = new AbortController();
		controller = request;
		const timeout = setTimeout(() => request.abort(), 15_000);
		pending = Promise.resolve().then(async () => {
			try {
				// Let Pi resolve/refresh OAuth normally; never read or write auth.json ourselves.
				if (!ctx.model || !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
					snapshot = undefined;
					failure = "connexion OAuth Codex requise";
					return;
				}
				const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER);
				if (currentGeneration !== generation) return;
				if (request.signal.aborted) throw new Error("quota request timed out");
				const token = resolved?.auth.apiKey;
				const accountId = token ? accountIdFromToken(token) : undefined;
				if (!token || !accountId) {
					snapshot = undefined;
					failure = "connexion OAuth Codex requise";
					return;
				}
				const response = await fetch(USAGE_URL, {
					method: "GET",
					redirect: "error",
					headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId },
					signal: request.signal,
				});
				if (currentGeneration !== generation) return;
				if (!response.ok) {
					// Do not retain a possibly different account's quota after an auth failure.
					if (response.status === 401 || response.status === 403) snapshot = undefined;
					failure = `HTTP ${response.status}`;
					await response.body?.cancel();
					return;
				}
				const windows = parseWindows(await response.json());
				if (currentGeneration !== generation) return;
				snapshot = { windows, capturedAt: Date.now() };
				failure = undefined;
			} catch {
				// Never expose response bodies, credentials, or raw network errors in the UI.
				if (currentGeneration === generation) failure = "réseau, délai ou format de réponse";
			} finally {
				clearTimeout(timeout);
				if (currentGeneration === generation) {
					pending = undefined;
					controller = undefined;
					render();
				}
			}
		});
		return pending;
	}

	function stop() {
		generation++;
		if (timer) clearInterval(timer);
		timer = undefined;
		process.stdout.off("resize", render);
		costPending = undefined;
		monthlyCost = undefined;
		costFailed = false;
		costReader = new MonthlyCostReader();
		controller?.abort();
		controller = undefined;
		pending = undefined;
		context?.ui.setStatus(STATUS_KEY, undefined);
		context = undefined;
		snapshot = undefined;
		failure = undefined;
		lastAttempt = 0;
	}

	function start(ctx: ExtensionContext) {
		stop();
		if (ctx.mode !== "tui") return;
		context = ctx;
		render();
		process.stdout.on("resize", render);
		void refresh();
		void refreshCost();
		// Only repaint countdowns here; disk and network refreshes wait until the task settles.
		timer = setInterval(render, MIN_REFRESH_MS);
		timer.unref();
	}

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("model_select", (_event, ctx) => start(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx.mode === "tui" ? ctx : undefined;
		void refresh(true);
		void refreshCost();
	});
	pi.on("session_shutdown", () => stop());
	pi.registerCommand("quota", {
		description: "Actualiser les quotas Codex restants (5 h / semaine)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || ctx.model?.provider !== PROVIDER) {
				ctx.ui.notify("Les quotas nécessitent le mode interactif et le fournisseur openai-codex.", "warning");
				return;
			}
			context = ctx;
			await Promise.all([refresh(true), refreshCost()]);
		},
	});
}
