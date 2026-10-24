export type QuotaWindow = { seconds: number; remaining: number; resetAt?: number };
type QuotaRequest = { url: string; headers: Record<string, string> };
export type QuotaProvider = {
	id: string;
	label: string;
	oauthRequired: string;
	createRequest(token: string): QuotaRequest | undefined;
	parseWindows(payload: unknown): QuotaWindow[];
};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function remaining(used: number): number {
	return Math.max(0, Math.min(100, 100 - used));
}

function requireWindows(windows: QuotaWindow[]): QuotaWindow[] {
	if (windows.length === 0) throw new Error("format de quota non reconnu");
	return windows;
}

function parseCodexWindows(payload: unknown): QuotaWindow[] {
	const limits = object(object(payload)?.rate_limit);
	const windows: QuotaWindow[] = [];
	for (const raw of [limits?.primary_window, limits?.secondary_window]) {
		const window = object(raw);
		if (!window || !finite(window.used_percent) || !finite(window.limit_window_seconds)) continue;
		// Identify windows by their actual duration, not their position in the response.
		if (window.limit_window_seconds !== 18_000 && window.limit_window_seconds !== 604_800) continue;
		const resetAt = finite(window.reset_at) ? window.reset_at * 1000 : undefined;
		windows.push({
			seconds: window.limit_window_seconds,
			remaining: remaining(window.used_percent),
			resetAt: finite(resetAt) && resetAt > 0 ? resetAt : undefined,
		});
	}
	return requireWindows(windows);
}

function parseAnthropicWindows(payload: unknown): QuotaWindow[] {
	const usage = object(payload);
	const windows: QuotaWindow[] = [];
	for (const [key, seconds] of [["five_hour", 18_000], ["seven_day", 604_800]] as const) {
		const window = object(usage?.[key]);
		if (!window || !finite(window.utilization)) continue;
		const resetAt = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : undefined;
		windows.push({
			seconds,
			remaining: remaining(window.utilization),
			resetAt: finite(resetAt) && resetAt > 0 ? resetAt : undefined,
		});
	}
	return requireWindows(windows);
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

const codex: QuotaProvider = {
	id: "openai-codex",
	label: "Codex",
	oauthRequired: "connexion OAuth Codex requise",
	createRequest(token) {
		const accountId = accountIdFromToken(token);
		if (!accountId) return undefined;
		return {
			url: "https://chatgpt.com/backend-api/wham/usage",
			headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId },
		};
	},
	parseWindows: parseCodexWindows,
};

const anthropic: QuotaProvider = {
	id: "anthropic",
	label: "Anthropic",
	oauthRequired: "connexion OAuth Anthropic requise",
	createRequest(token) {
		if (!token) return undefined;
		return {
			url: "https://api.anthropic.com/api/oauth/usage",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
			},
		};
	},
	parseWindows: parseAnthropicWindows,
};

export function getQuotaProvider(provider: string | undefined): QuotaProvider | undefined {
	switch (provider) {
		case "openai-codex": return codex;
		case "anthropic": return anthropic;
		default: return undefined;
	}
}
