import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

export default function deleteSessionExtension(pi: ExtensionAPI) {
	pi.registerCommand("delete", {
		description: "Move the current persisted session to the trash and exit Pi",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) {
				ctx.ui.notify("当前没有需要删除的持久化会话。", "info");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"删除当前会话？",
				`会话将移入回收站，随后 Pi 会退出。\n\n${sessionFile}`,
			);
			if (!confirmed) {
				ctx.ui.notify("已取消删除当前会话。", "info");
				return;
			}

			try {
				const result = await pi.exec("gio", ["trash", "--", sessionFile]);
				if (result.code !== 0) {
					const reason = result.stderr.trim() || result.stdout.trim() || `gio 退出码 ${result.code}`;
					ctx.ui.notify(`会话未删除：${reason}`, "error");
					return;
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`会话未删除：${reason}`, "error");
				return;
			}

			if (existsSync(sessionFile)) {
				ctx.ui.notify("会话未删除：gio trash 执行后文件仍然存在。", "error");
				return;
			}

			ctx.ui.notify("当前会话已移入回收站，Pi 即将退出。", "info");
			ctx.shutdown();
		},
	});
}
