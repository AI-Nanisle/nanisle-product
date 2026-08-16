import { useEffect, useState } from "react";

// Placeholder UI proving the full loop (health → guard → AI seam).
// Replace this whole file when building a real product.

interface Health {
	ok: boolean;
	provider: string;
	accessCodeRequired: boolean;
	aiDisabled: boolean;
}

export default function App() {
	const [health, setHealth] = useState<Health | null>(null);
	const [prompt, setPrompt] = useState("");
	const [accessCode, setAccessCode] = useState("");
	const [answer, setAnswer] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		fetch("/api/health")
			.then((r) => r.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setHealth(null));
	}, []);

	async function ask() {
		setBusy(true);
		setError("");
		setAnswer("");
		try {
			const res = await fetch("/api/demo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(accessCode ? { "x-access-code": accessCode } : {}),
				},
				body: JSON.stringify({ prompt }),
			});
			const data = (await res.json()) as { text?: string; error?: string };
			if (!res.ok) {
				setError(data.error ?? `Request failed (${res.status})`);
			} else {
				setAnswer(data.text ?? "");
			}
		} catch {
			setError("Network error");
		} finally {
			setBusy(false);
		}
	}

	const needsCode = health?.accessCodeRequired ?? false;

	return (
		<div className="min-h-screen bg-zinc-50 text-zinc-900">
			<main className="mx-auto max-w-xl px-6 py-16">
				<h1 className="text-2xl font-semibold tracking-tight">
					nanisle product template
				</h1>
				<p className="mt-2 text-sm text-zinc-500">
					Placeholder UI — replace <code>src/react-app/App.tsx</code> when
					building a product. AI provider:{" "}
					<span className="font-mono">{health ? health.provider : "…"}</span>
					{health?.aiDisabled ? " (disabled)" : ""}
				</p>

				<div className="mt-8 space-y-3">
					<textarea
						className="h-28 w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-500"
						placeholder="Ask something…"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
					/>
					{needsCode && (
						<input
							className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-500"
							type="password"
							placeholder="Access code (this instance is gated)"
							value={accessCode}
							onChange={(e) => setAccessCode(e.target.value)}
						/>
					)}
					<button
						className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
						disabled={busy || prompt.trim().length === 0}
						onClick={ask}
					>
						{busy ? "Thinking…" : "Ask"}
					</button>
				</div>

				{error && (
					<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
						{error}
					</p>
				)}
				{answer && (
					<p className="mt-6 whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-relaxed">
						{answer}
					</p>
				)}

				<footer className="mt-16 text-xs text-zinc-400">
					An island of{" "}
					<a className="underline" href="https://nanisle.com">
						nanisle.com
					</a>{" "}
					· open source ·{" "}
					<a
						className="underline"
						href="https://github.com/AI-Nanisle/nanisle-product"
					>
						fork me
					</a>
				</footer>
			</main>
		</div>
	);
}
