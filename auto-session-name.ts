import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TITLE_PROMPT = `你是会话标题生成器。根据用户的第一条消息生成一个简洁、明确的中文标题。

要求：
- 只输出标题，不要解释
- 最多 20 个字符
- 不要引号、Markdown、前缀或句末标点
- 保留关键技术名词，但整体使用中文`;

function hasUserMessage(entries: any[]): boolean {
	return entries.some(
		(entry: any) => entry.type === "message" && entry.message?.role === "user",
	);
}

function sanitizeTitle(raw: string): string {
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return "";

	const cleaned = firstLine
		.replace(/^#{1,6}\s*/, "")
		.replace(/^(?:标题|会话标题)\s*[:：]\s*/, "")
		.replace(/^[`'“”‘’\"]+|[`'“”‘’\"]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/[。.!！?？;；]+$/g, "")
		.trim();

	return Array.from(cleaned).slice(0, 20).join("");
}

export default function autoSessionName(pi: ExtensionAPI) {
	let eligible = false;
	let naming = false;
	let sessionAbort = new AbortController();

	pi.on("session_start", (_event, ctx) => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		eligible =
			ctx.sessionManager.isPersisted() &&
			!pi.getSessionName() &&
			!hasUserMessage(ctx.sessionManager.getEntries());
		naming = false;
	});

	pi.on("session_shutdown", () => {
		sessionAbort.abort();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!eligible || naming || pi.getSessionName()) return;

		// Only the first user message gets one naming attempt. Run it in the
		// background so title generation never delays the user's main request.
		eligible = false;
		if (!ctx.model) return;

		const prompt = event.prompt.trim();
		if (!prompt) return;

		naming = true;
		const signal = sessionAbort.signal;
		void (async () => {
			try {
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: prompt.slice(0, 6000) }],
					timestamp: Date.now(),
				};
				const response = await ctx.modelRegistry.complete(
					ctx.model!,
					{ systemPrompt: TITLE_PROMPT, messages: [userMessage] },
					{ signal },
				);
				if (signal.aborted || response.stopReason === "aborted" || pi.getSessionName()) return;

				const rawTitle = response.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n");
				const title = sanitizeTitle(rawTitle);
				if (title && !signal.aborted && !pi.getSessionName()) {
					pi.setSessionName(title);
				}
			} catch {
				// Naming is best-effort and must never interrupt the user's main request.
			} finally {
				naming = false;
			}
		})();
	});
}
