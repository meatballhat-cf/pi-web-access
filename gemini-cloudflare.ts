/**
 * Cloudflare AI Gateway support for Gemini API routing.
 *
 * When `geminiBaseUrl` (or `GOOGLE_GEMINI_BASE_URL`) points at a Cloudflare AI
 * Gateway endpoint, requests are authenticated via either:
 *   - A static API key (`CLOUDFLARE_API_KEY` / `cloudflareApiKey` in config)
 *   - A short-lived CF Access JWT acquired via `cloudflared access token`
 *
 * Recognised gateway hosts are configured via `CLOUDFLARE_AI_GATEWAY_GOOGLE_GEMINI_HOSTS`
 * (comma-separated, defaults to `gateway.ai.cloudflare.com`).
 *
 * The CF Access app URL for `cloudflared` is configured via
 * `CLOUDFLARE_AI_GATEWAY_ACCESS_APP_URL` (defaults to the gateway host origin).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getApiHost } from "./gemini-api.js";

/**
 * Returns the list of hostnames that should be treated as Cloudflare AI Gateway
 * endpoints. Configurable via `CLOUDFLARE_AI_GATEWAY_GOOGLE_GEMINI_HOSTS`
 * (comma-separated). Defaults to `gateway.ai.cloudflare.com`.
 */
export function getCloudflareGatewayHosts(): string[] {
  const raw =
    process.env.CLOUDFLARE_AI_GATEWAY_GOOGLE_GEMINI_HOSTS ??
    "gateway.ai.cloudflare.com";
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Returns true when the configured Gemini API host is a Cloudflare AI Gateway
 * endpoint. Detected purely from the URL — no hardcoded hostnames.
 */
export function isCloudflareGateway(): boolean {
  const host = getApiHost();
  return getCloudflareGatewayHosts().some((h) => host.includes(h));
}

/**
 * Returns the CF Access application URL used for `cloudflared access token`.
 * Resolution order:
 * 1. `CLOUDFLARE_AI_GATEWAY_ACCESS_APP_URL` env var
 * 2. Origin of the configured Cloudflare AI Gateway host (scheme + hostname only)
 */
export function getCloudflareAccessAppUrl(): string {
  return (
    process.env.CLOUDFLARE_AI_GATEWAY_ACCESS_APP_URL ??
    `https://${getApiHost().replace(/\/.*$/, "")}`
  );
}

/**
 * Sets up Cloudflare AI Gateway CF Access token acquisition via `cloudflared`.
 *
 * Registers a dynamic auth header provider that returns a short-lived
 * `cf-access-token` JWT. The token is cached in-memory and refreshed on each
 * `session_start` event.
 *
 * No-op when `isCloudflareGateway()` is false.
 */
export function setupCloudflareAccessAuth(
  pi: ExtensionAPI,
  setDynamicAuthHeaders: (
    fn: () => Promise<Record<string, string>>,
  ) => void,
): void {
  if (!isCloudflareGateway()) return;

  const appUrl = getCloudflareAccessAppUrl();
  let cachedToken: string | null = null;
  let tokenFetchInFlight: Promise<string> | null = null;

  const acquireToken = async (): Promise<string> => {
    if (tokenFetchInFlight) return tokenFetchInFlight;
    tokenFetchInFlight = (async () => {
      const result = await pi.exec(
        "cloudflared",
        ["access", "token", `--app=${appUrl}`],
        { timeout: 30_000 },
      );
      if (result.code !== 0 || !result.stdout.trim()) {
        throw new Error(
          `cloudflared access token failed (exit=${result.code}): ${result.stderr.trim()}`,
        );
      }
      cachedToken = result.stdout.trim();
      return cachedToken;
    })().finally(() => {
      tokenFetchInFlight = null;
    });
    return tokenFetchInFlight;
  };

  setDynamicAuthHeaders(async () => {
    const token = cachedToken ?? (await acquireToken());
    return { "cf-access-token": token };
  });

  // Refresh token on each session start.
  pi.on("session_start", async () => {
    cachedToken = null;
    try {
      await acquireToken();
    } catch {
      // Non-fatal — will retry on first request.
    }
  });
}
