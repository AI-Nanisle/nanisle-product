import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";

/**
 * Gate for token-spending endpoints. Two checks:
 *
 * 1. AI_DISABLED=1 → 503. Kill switch for incident response: flip the var,
 *    redeploy, spending stops while the rest of the app stays up.
 * 2. ACCESS_CODE set → the request must carry a matching `x-access-code`
 *    header. Comma-separated values allow handing different codes to
 *    different people and rotating them independently.
 *
 * Unset ACCESS_CODE means open access — fine for local dev and mock mode,
 * never for a public instance running on real credentials. Budgets and rate
 * limits are enforced one layer up, at the gateway (docs/ai-access.md).
 */
export const aiGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	if (c.env.AI_DISABLED === "1") {
		return c.json({ error: "AI is temporarily disabled on this instance." }, 503);
	}
	const codes = (c.env.ACCESS_CODE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (codes.length > 0) {
		const given = c.req.header("x-access-code") ?? "";
		let ok = false;
		for (const code of codes) {
			if (await safeEqual(code, given)) ok = true;
		}
		if (!ok) {
			return c.json({ error: "Missing or incorrect access code." }, 401);
		}
	}
	await next();
});

// Compare via SHA-256 digests so the comparison is constant-time and
// length-independent (a plain === would leak match length via timing).
async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [da, db] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const va = new Uint8Array(da);
	const vb = new Uint8Array(db);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}
