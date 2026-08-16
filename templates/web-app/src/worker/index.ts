import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AiError, complete, resolveProvider } from "./ai";
import { aiGuard } from "./guard";
import type { AppEnv } from "./env";

const app = new Hono<{ Bindings: AppEnv }>();

app.get("/api/health", (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(c.env);
	} catch {
		// leave "invalid" — misconfigured AI_PROVIDER shouldn't take health down
	}
	return c.json({
		ok: true,
		provider,
		accessCodeRequired: Boolean(c.env.ACCESS_CODE),
		aiDisabled: c.env.AI_DISABLED === "1",
	});
});

// Demo endpoint — replace with the product's real routes, but keep the
// aiGuard on anything that spends tokens.
app.post("/api/demo", aiGuard, async (c) => {
	let prompt: unknown;
	try {
		({ prompt } = await c.req.json<{ prompt?: unknown }>());
	} catch {
		return c.json({ error: "Body must be JSON: {\"prompt\": \"...\"}" }, 400);
	}
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		return c.json({ error: "prompt must be a non-empty string" }, 400);
	}
	if (prompt.length > 4000) {
		return c.json({ error: "prompt too long (max 4000 chars)" }, 413);
	}

	try {
		const result = await complete(c.env, { prompt });
		return c.json(result);
	} catch (err) {
		// Clients get generic messages only — never raw upstream errors.
		if (err instanceof AiError) {
			return c.json({ error: err.message }, err.status as ContentfulStatusCode);
		}
		if (err instanceof Anthropic.RateLimitError) {
			return c.json({ error: "Upstream rate limit — try again shortly." }, 429);
		}
		if (err instanceof Anthropic.APIError) {
			console.error("upstream AI error", err.status, err.name);
			return c.json({ error: "Upstream AI error." }, 502);
		}
		throw err;
	}
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
