import assert from "node:assert/strict";
import { test } from "node:test";
import { getQuotaProvider } from "../src/codex-quota-support/providers.ts";

const codex = getQuotaProvider("openai-codex")!;
const anthropic = getQuotaProvider("anthropic")!;

function token(payload: unknown): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("only the exact supported provider IDs enable quotas", () => {
	assert.equal(codex.label, "Codex");
	assert.equal(anthropic.label, "Anthropic");
	for (const provider of [undefined, "", "openai", "openrouter", "amazon-bedrock", "claude", "toString", "__proto__"]) {
		assert.equal(getQuotaProvider(provider), undefined);
	}
});

test("Codex identifies windows by duration and converts used percent to remaining", () => {
	assert.deepEqual(codex.parseWindows({ rate_limit: {
		primary_window: { limit_window_seconds: 604_800, used_percent: 36, reset_at: 2_000_000_000 },
		secondary_window: { limit_window_seconds: 18_000, used_percent: 18.5, reset_at: 1_999_999_000 },
	} }), [
		{ seconds: 604_800, remaining: 64, resetAt: 2_000_000_000_000 },
		{ seconds: 18_000, remaining: 81.5, resetAt: 1_999_999_000_000 },
	]);
});

test("Codex accepts partial windows, clamps percentages and ignores invalid reset dates", () => {
	assert.deepEqual(codex.parseWindows({ rate_limit: {
		primary_window: { limit_window_seconds: 18_000, used_percent: 120, reset_at: -1 },
		secondary_window: { limit_window_seconds: 3600, used_percent: 5 },
	} }), [{ seconds: 18_000, remaining: 0, resetAt: undefined }]);
	assert.deepEqual(codex.parseWindows({ rate_limit: {
		primary_window: { limit_window_seconds: 604_800, used_percent: -10, reset_at: Number.MAX_VALUE },
	} }), [{ seconds: 604_800, remaining: 100, resetAt: undefined }]);
});

test("Anthropic converts five_hour and seven_day utilization and ISO reset timestamps", () => {
	const resetsAt = "2030-01-02T03:04:05+01:00";
	assert.deepEqual(anthropic.parseWindows({
		five_hour: { utilization: 12.5, resets_at: resetsAt },
		seven_day: { utilization: 40, resets_at: null },
		seven_day_sonnet: { utilization: 90, resets_at: resetsAt },
	}), [
		{ seconds: 18_000, remaining: 87.5, resetAt: Date.parse(resetsAt) },
		{ seconds: 604_800, remaining: 60, resetAt: undefined },
	]);
});

test("Anthropic accepts partial windows, clamps percentages and ignores invalid reset dates", () => {
	assert.deepEqual(anthropic.parseWindows({
		five_hour: null,
		seven_day: { utilization: 130, resets_at: "not a date" },
	}), [{ seconds: 604_800, remaining: 0, resetAt: undefined }]);
	assert.deepEqual(anthropic.parseWindows({
		five_hour: { utilization: -1, resets_at: "1970-01-01T00:00:00Z" },
	}), [{ seconds: 18_000, remaining: 100, resetAt: undefined }]);
});

test("both providers reject unrecognized data rather than inventing a quota", () => {
	for (const payload of [null, [], {}, "invalid", { rate_limit: [] }, {
		rate_limit: {
			primary_window: { used_percent: "20", limit_window_seconds: 18_000 },
			secondary_window: { used_percent: Number.NaN, limit_window_seconds: 604_800 },
		},
	}, { five_hour: { utilization: "10" }, seven_day: { utilization: Number.POSITIVE_INFINITY } }]) {
		assert.throws(() => codex.parseWindows(payload), /format de quota non reconnu/);
		assert.throws(() => anthropic.parseWindows(payload), /format de quota non reconnu/);
	}
});

test("Codex requests only its fixed endpoint with the account ID from the OAuth token", () => {
	const accessToken = token({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } });
	assert.deepEqual(codex.createRequest(accessToken), {
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: { Authorization: `Bearer ${accessToken}`, "chatgpt-account-id": "test-account" },
	});
	for (const value of ["", "invalid", token({}), token({ "https://api.openai.com/auth": { chatgpt_account_id: "" } })]) {
		assert.equal(codex.createRequest(value), undefined);
	}
});

test("Anthropic requests only its fixed endpoint with OAuth beta headers, without Codex headers", () => {
	assert.deepEqual(anthropic.createRequest("test-oauth-token"), {
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: {
			Authorization: "Bearer test-oauth-token",
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
	});
	assert.equal(anthropic.createRequest(""), undefined);
});
