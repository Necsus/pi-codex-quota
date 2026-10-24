import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MonthlyCostReader, type MonthlyCost } from "./codex-quota-support/monthly-cost.ts";
import { getQuotaProvider, type QuotaWindow } from "./codex-quota-support/providers.ts";

const STATUS_KEY = "codex-quota";
const POLL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;

type Snapshot = { provider: string; windows: QuotaWindow[]; capturedAt: number };

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
		const provider = getQuotaProvider(context.model?.provider);
		const currentSnapshot = snapshot?.provider === provider?.id ? snapshot : undefined;
		let right = "";
		if (provider && !currentSnapshot) {
			right = `${provider.label} · quotas ${failure ? `indisponibles (${failure})` : "en cours…"}`;
		} else if (provider && currentSnapshot) {
			const parts = [18_000, 604_800].map((seconds) => {
				const label = seconds === 18_000 ? "5h" : "hebdo";
				const window = currentSnapshot.windows.find((item) => item.seconds === seconds);
				if (!window) return `${label} : non communiqué`;
				if (window.resetAt !== undefined && window.resetAt <= now) return `${label} : à actualiser`;
				const reset = window.resetAt === undefined ? "" : ` ↻ ${countdown(window.resetAt - now)}`;
				return `${label} : ${Math.floor(window.remaining)}%${reset}`;
			});
			const stale = failure !== undefined || now - currentSnapshot.capturedAt >= POLL_MS + MIN_REFRESH_MS;
			right = `${provider.label} restant${stale ? "*" : ""} · ${parts.join(" · ")}`;
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
		const provider = getQuotaProvider(ctx?.model?.provider);
		if (!ctx || ctx.mode !== "tui" || !provider) return Promise.resolve();
		if (pending) return pending;
		if (!force && Date.now() - lastAttempt < MIN_REFRESH_MS) return Promise.resolve();
		lastAttempt = Date.now();
		const currentGeneration = generation;
		const request = new AbortController();
		controller = request;
		const timeout = setTimeout(() => request.abort(), 15_000);
		pending = Promise.resolve().then(async () => {
			try {
				if (currentGeneration !== generation) return;
				// Let Pi resolve/refresh OAuth normally; never read or write auth.json ourselves.
				if (!ctx.model || !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
					snapshot = undefined;
					failure = provider.oauthRequired;
					return;
				}
				const resolved = await ctx.modelRegistry.getProviderAuth(provider.id);
				if (currentGeneration !== generation) return;
				if (request.signal.aborted) throw new Error("quota request timed out");
				const token = resolved?.auth.apiKey;
				const quotaRequest = token ? provider.createRequest(token) : undefined;
				if (!quotaRequest) {
					snapshot = undefined;
					failure = provider.oauthRequired;
					return;
				}
				const response = await fetch(quotaRequest.url, {
					method: "GET",
					redirect: "error",
					headers: quotaRequest.headers,
					signal: request.signal,
				});
				if (currentGeneration !== generation) {
					await response.body?.cancel();
					return;
				}
				if (!response.ok) {
					// Do not retain a possibly different account's quota after an auth failure.
					if (response.status === 401 || response.status === 403) snapshot = undefined;
					failure = `HTTP ${response.status}`;
					await response.body?.cancel();
					return;
				}
				const windows = provider.parseWindows(await response.json());
				if (currentGeneration !== generation) return;
				if (request.signal.aborted) throw new Error("quota request timed out");
				snapshot = { provider: provider.id, windows, capturedAt: Date.now() };
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
		description: "Actualiser les quotas restants du fournisseur actif (Codex / Anthropic)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !getQuotaProvider(ctx.model?.provider)) {
				ctx.ui.notify("Les quotas nécessitent le mode interactif et un fournisseur pris en charge (openai-codex ou anthropic).", "warning");
				return;
			}
			context = ctx;
			await Promise.all([refresh(true), refreshCost()]);
		},
	});
}
