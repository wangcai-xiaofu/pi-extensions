import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Component,
	type Focusable,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface QaItem {
	index: number;
	question: string;
	answer: string;
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content.trim();
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

export function buildQaItems(entries: any[]): QaItem[] {
	const items: QaItem[] = [];
	let current: QaItem | undefined;

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		const text = messageText(entry.message);

		if (role === "user" && text) {
			current = { index: items.length + 1, question: text, answer: "" };
			items.push(current);
			continue;
		}

		if (role === "assistant" && current && text) {
			current.answer += current.answer ? `\n\n${text}` : text;
		}
	}

	return items;
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function compact(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export interface MousePosition {
	x: number;
	y: number;
}

export function parsePrimaryMousePress(data: string): MousePosition | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) === 0 && (button & 32) === 0 && (button & 3) === 0) {
			return { x: Number.parseInt(sgr[2]!, 10) - 1, y: Number.parseInt(sgr[3]!, 10) - 1 };
		}
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0 && (button & 32) === 0 && (button & 3) === 0) {
			return { x: data.charCodeAt(4) - 33, y: data.charCodeAt(5) - 33 };
		}
	}

	return undefined;
}

export function parseWheelDirection(data: string): -1 | 1 | undefined {
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) !== 0) {
			const direction = button & 3;
			if (direction === 0 || direction === 1) return direction === 0 ? -1 : 1;
		}
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) !== 0) {
			const direction = button & 3;
			if (direction === 0 || direction === 1) return direction === 0 ? -1 : 1;
		}
	}

	return undefined;
}

export interface RawMouseEvent {
	type: "press" | "drag" | "release";
	x: number;
	y: number;
}

/** Parse raw mouse sequences (SGR 1006 and legacy X10) into zero-based terminal coordinates. */
export function parseRawMouseEvent(data: string): RawMouseEvent | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) !== 0) return undefined; // wheel is handled separately
		const x = Number.parseInt(sgr[2]!, 10) - 1;
		const y = Number.parseInt(sgr[3]!, 10) - 1;
		if (sgr[4] === "m") return { type: "release", x, y };
		return { type: (button & 32) !== 0 ? "drag" : "press", x, y };
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) !== 0) return undefined;
		return {
			type: (button & 32) !== 0 ? "drag" : "press",
			x: data.charCodeAt(4) - 33,
			y: data.charCodeAt(5) - 33,
		};
	}

	return undefined;
}

interface CellPoint {
	row: number;
	col: number;
}

interface CellRange {
	from: number;
	to: number;
}

/**
 * Ctrl+C arrives as a plain ETX byte in legacy terminals, but as a CSI-u / 
 * modifyOtherKeys sequence once the Kitty keyboard protocol is active 
 * (pi enables disambiguate + event-type reporting). matchesKey() understands 
 * all of those encodings.
 */
function isCopyShortcut(data: string): boolean {
	return (
		data === "\x03" ||
		matchesKey(data, "ctrl+c") ||
		/^\x1b\[(?:3|99);5(?::\d+)?u$/.test(data) ||
		/^\x1b\[27;5;99~$/.test(data)
	);
}

function samePoint(a: CellPoint, b: CellPoint): boolean {
	return a.row === b.row && a.col === b.col;
}

/**
 * Wrap the visible columns in [startCol, endCol) with the given style, preserving
 * ANSI sequences, wide characters, and the zero-width cursor marker.
 */
function invertColumns(
	line: string,
	startCol: number,
	endCol: number,
	inverse: (text: string) => string,
): string {
	if (startCol >= endCol) return line;
	let result = "";
	let col = 0;
	let index = 0;
	while (index < line.length) {
		if (line.startsWith(CURSOR_MARKER, index)) {
			result += CURSOR_MARKER;
			index += CURSOR_MARKER.length;
			continue;
		}
		if (line.charCodeAt(index) === 0x1b) {
			const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(index));
			if (match) {
				result += match[0];
				index += match[0].length;
				continue;
			}
			// Unknown escape: copy the ESC byte and process the rest normally.
			result += line[index]!;
			index += 1;
			continue;
		}
		const codePoint = line.codePointAt(index) ?? line.charCodeAt(index);
		const char = String.fromCodePoint(codePoint);
		const charWidth = visibleWidth(char);
		if (charWidth > 0 && col >= startCol && col < endCol) {
			result += inverse(char);
		} else {
			result += char;
		}
		col += charWidth;
		index += char.length;
	}
	return result;
}

class QaBrowserComponent implements Component, Focusable {
	focused = false;
	private query: string;
	private selected = 0;
	private detailOffset = 0;
	private readonly enabledMouseReporting: boolean;
	private lastWidth = 0;
	private lastHeight = 0;
	private lastListStart = 0;
	private lastListHeight = 0;
	private lastListRight = 0;
	private lastWide = false;
	private lastInnerWidth = 0;
	private lastPaneSplit = 0;
	private lastContentBottom = 0;
	private lastRenderedLines: string[] = [];
	private selAnchor: CellPoint | undefined;
	private selFocus: CellPoint | undefined;
	private selPaneRange: CellRange | undefined;
	private dragging = false;
	private copyMessage: string | undefined;
	private copyMessageIsError = false;
	private copyMessageUntil = 0;
	private copyTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly items: QaItem[],
		private readonly done: () => void,
		initialQuery = "",
	) {
		this.query = initialQuery;
		this.enabledMouseReporting = tui.mode !== "fullscreen";
		if (this.enabledMouseReporting) {
			// Fullscreen mode already owns mouse reporting and dispatches normalized
			// mouse events through handleMouse(). Regular mode needs raw sequences so
			// this overlay can implement text selection and wheel scrolling itself.
			// 1000 only reports press/release; drag selection additionally needs 1002
			// (button-motion tracking), otherwise the terminal never sends drag events.
			tui.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
		}
	}

	private filteredItems(): QaItem[] {
		const query = this.query.trim().toLocaleLowerCase();
		if (!query) return this.items;
		return this.items.filter((item) =>
			`${item.question}\n${item.answer}`.toLocaleLowerCase().includes(query),
		);
	}

	private normalizeSelection(): QaItem[] {
		const filtered = this.filteredItems();
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, filtered.length - 1)));
		return filtered;
	}

	private handleClickAt(localX: number, localY: number): boolean {
		if (this.lastWidth === 0 || this.lastHeight === 0) return false;
		const listRow = localY - 4;
		if (localX < 1 || localX > this.lastListRight || listRow < 0 || listRow >= this.lastListHeight) {
			return false;
		}
		const filtered = this.normalizeSelection();
		const clickedIndex = this.lastListStart + listRow;
		if (clickedIndex >= filtered.length) return false;
		this.selected = clickedIndex;
		this.detailOffset = 0;
		return true;
	}

	/**
	 * Screen-space origin of this overlay. The TUI already stores where it composited the
	 * overlay, so prefer that over re-deriving it from the terminal size (which drifts when
	 * the TUI clips the overlay to its maxHeight).
	 */
	private overlayOrigin(): { top: number; left: number } {
		const layouts = (this.tui as unknown as {
			renderedOverlayLayouts?: Array<{ entry?: { component?: unknown }; row: number; col: number }>;
		}).renderedOverlayLayouts;
		if (Array.isArray(layouts)) {
			for (let index = layouts.length - 1; index >= 0; index--) {
				const layout = layouts[index];
				if (layout?.entry?.component === this) return { top: layout.row, left: layout.col };
			}
		}
		return {
			top: Math.floor((this.tui.terminal.rows - this.lastHeight) / 2),
			left: Math.floor((this.tui.terminal.columns - this.lastWidth) / 2),
		};
	}

	/** Column window of the pane the drag started in, so copying an answer never drags in list text. */
	private paneRangeAt(localX: number, localY: number): CellRange | undefined {
		if (this.lastInnerWidth <= 0 || localY < 4 || localY >= this.lastContentBottom) return undefined;
		if (!this.lastWide) return { from: 1, to: this.lastInnerWidth };
		if (localX <= this.lastPaneSplit) return { from: 1, to: this.lastPaneSplit };
		return { from: this.lastPaneSplit + 1, to: this.lastInnerWidth };
	}

	/** Linear (native-style) column range for one row: anchor→EOL, full middle rows, SOL→cursor. */
	private selectionColumns(row: number): CellRange | undefined {
		const anchor = this.selAnchor;
		const focus = this.selFocus;
		if (!anchor || !focus) return undefined;
		const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col);
		const start = anchorFirst ? anchor : focus;
		const end = anchorFirst ? focus : anchor;
		if (row < start.row || row > end.row) return undefined;

		let from: number;
		let to: number;
		if (start.row === end.row) {
			from = start.col;
			to = end.col + 1;
		} else if (row === start.row) {
			from = start.col;
			to = this.lastWidth;
		} else if (row === end.row) {
			from = 0;
			to = end.col + 1;
		} else {
			from = 0;
			to = this.lastWidth;
		}

		const pane = this.selPaneRange;
		if (pane) {
			from = Math.max(from, pane.from);
			to = Math.min(to, pane.to);
		}
		return to > from ? { from, to } : undefined;
	}

	private clampPoint(x: number, y: number): CellPoint {
		return {
			row: Math.max(0, Math.min(y, Math.max(0, this.lastHeight - 1))),
			col: Math.max(0, Math.min(x, Math.max(0, this.lastWidth - 1))),
		};
	}

	private clearSelection(): void {
		this.selAnchor = undefined;
		this.selFocus = undefined;
		this.selPaneRange = undefined;
		this.dragging = false;
	}

	private hasActiveSelection(): boolean {
		return Boolean(this.selAnchor && this.selFocus && !samePoint(this.selAnchor, this.selFocus));
	}

	/** Normalized mouse events, used in fullscreen mode where the TUI owns mouse reporting. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.detailOffset = Math.max(0, this.detailOffset + (event.wheelDelta ?? 0) * 3);
			return { handled: true };
		}

		if (event.button !== "left") return undefined;

		if (event.type === "press") {
			this.clearSelection();
			const point = this.clampPoint(event.x, event.y);
			this.selAnchor = point;
			this.selFocus = point;
			this.selPaneRange = this.paneRangeAt(point.col, point.row);
			this.dragging = true;
			return { capture: true };
		}

		if (event.type === "drag") {
			if (!this.dragging) return undefined;
			this.selFocus = this.clampPoint(event.x, event.y);
			return { capture: true };
		}

		if (event.type === "release") {
			if (!this.dragging) return undefined;
			this.dragging = false;
			if (this.selAnchor && this.selFocus && !samePoint(this.selAnchor, this.selFocus)) {
				this.selFocus = this.clampPoint(event.x, event.y);
				return { capture: true };
			}
			// No movement: treat as a plain click, handled by the synthetic click event.
			this.clearSelection();
			return { capture: true };
		}

		if (event.type === "click") {
			if (this.handleClickAt(event.x, event.y)) return { handled: true };
			return undefined;
		}

		return undefined;
	}

	/** Raw mouse sequences, used in regular mode where this overlay enables its own mouse reporting. */
	private handleRawMouse(event: RawMouseEvent): void {
		if (this.lastWidth === 0 || this.lastHeight === 0) return;
		const origin = this.overlayOrigin();
		const localX = event.x - origin.left;
		const localY = event.y - origin.top;

		if (event.type === "press") {
			if (localX < 0 || localX >= this.lastWidth || localY < 0 || localY >= this.lastHeight) return;
			this.clearSelection();
			const point = this.clampPoint(localX, localY);
			this.selAnchor = point;
			this.selFocus = point;
			this.selPaneRange = this.paneRangeAt(point.col, point.row);
			this.dragging = true;
			this.tui.requestRender();
			return;
		}

		if (event.type === "drag") {
			if (!this.dragging) return;
			this.selFocus = this.clampPoint(localX, localY);
			this.tui.requestRender();
			return;
		}

		if (!this.dragging) return;
		this.dragging = false;
		if (this.selAnchor && this.selFocus && !samePoint(this.selAnchor, this.selFocus)) {
			this.selFocus = this.clampPoint(localX, localY);
			this.tui.requestRender();
			return;
		}
		this.clearSelection();
		if (this.handleClickAt(localX, localY)) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (isCopyShortcut(data)) {
			if (this.hasActiveSelection()) void this.copySelectionToClipboard();
			return;
		}

		const wheelDirection = parseWheelDirection(data);
		if (wheelDirection !== undefined) {
			this.detailOffset = Math.max(0, this.detailOffset + wheelDirection * 3);
			this.tui.requestRender();
			return;
		}

		const rawMouse = parseRawMouseEvent(data);
		if (rawMouse) {
			this.handleRawMouse(rawMouse);
			return;
		}

		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}

		const filtered = this.normalizeSelection();
		if (matchesKey(data, "up")) {
			this.clearSelection();
			this.selected = Math.max(0, this.selected - 1);
			this.detailOffset = 0;
		} else if (matchesKey(data, "down")) {
			this.clearSelection();
			this.selected = Math.min(Math.max(0, filtered.length - 1), this.selected + 1);
			this.detailOffset = 0;
		} else if (matchesKey(data, "home")) {
			this.clearSelection();
			this.selected = 0;
			this.detailOffset = 0;
		} else if (matchesKey(data, "end")) {
			this.clearSelection();
			this.selected = Math.max(0, filtered.length - 1);
			this.detailOffset = 0;
		} else if (matchesKey(data, "pageUp")) {
			this.clearSelection();
			this.detailOffset = Math.max(0, this.detailOffset - 8);
		} else if (matchesKey(data, "pageDown")) {
			this.clearSelection();
			this.detailOffset += 8;
		} else if (matchesKey(data, "backspace")) {
			this.clearSelection();
			this.query = Array.from(this.query).slice(0, -1).join("");
			this.selected = 0;
			this.detailOffset = 0;
		} else if (matchesKey(data, "ctrl+u")) {
			this.clearSelection();
			this.query = "";
			this.selected = 0;
			this.detailOffset = 0;
		} else if (
			data.length > 0 &&
			!data.includes("\x1b") &&
			Array.from(data).every((char) => (char.codePointAt(0) ?? 0) >= 32 && char !== "\x7f")
		) {
			this.clearSelection();
			this.query += data;
			this.selected = 0;
			this.detailOffset = 0;
		}

		this.tui.requestRender();
	}

	private getSelectionText(): string | undefined {
		if (!this.hasActiveSelection()) return undefined;
		const anchor = this.selAnchor!;
		const focus = this.selFocus!;
		const startRow = Math.max(0, Math.min(anchor.row, focus.row));
		const endRow = Math.min(this.lastRenderedLines.length - 1, Math.max(anchor.row, focus.row));
		const selected: string[] = [];
		for (let row = startRow; row <= endRow; row++) {
			const line = this.lastRenderedLines[row];
			if (line === undefined) continue;
			const range = this.selectionColumns(row);
			if (!range) continue;
			selected.push(
				stripTerminalSequences(sliceByColumn(line, range.from, range.to - range.from, true)).trimEnd(),
			);
		}
		const text = selected.join("\n").trim();
		return text.length === 0 ? undefined : text;
	}

	private async copySelectionToClipboard(): Promise<void> {
		const text = this.getSelectionText();
		this.clearSelection();
		if (text === undefined) return;
		try {
			await copyToClipboard(text);
			this.flashCopyMessage("已复制选中内容");
		} catch {
			this.flashCopyMessage("复制失败：剪贴板不可用", true);
		}
	}

	private flashCopyMessage(message: string, isError = false): void {
		this.copyMessage = message;
		this.copyMessageIsError = isError;
		this.copyMessageUntil = Date.now() + 2000;
		this.tui.requestRender();
		if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
		this.copyTimer = setTimeout(() => {
			if (this.disposed) return;
			this.copyMessage = undefined;
			this.tui.requestRender();
		}, 2000);
	}

	private applySelectionHighlight(lines: string[]): void {
		if (!this.hasActiveSelection()) return;
		const inverse = (text: string) => this.theme.inverse(text);
		for (let row = 0; row < lines.length; row++) {
			const range = this.selectionColumns(row);
			if (range) lines[row] = invertColumns(lines[row]!, range.from, range.to, inverse);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const outerWidth = Math.max(40, width);
		const innerWidth = outerWidth - 2;
		const height = Math.max(12, Math.min(34, this.tui.terminal.rows - 4));
		const contentHeight = height - 7;
		this.lastWidth = outerWidth;
		this.lastHeight = height;
		const filtered = this.normalizeSelection();
		const selectedItem = filtered[this.selected];
		const border = (text: string) => th.fg("border", text);
		const row = (content: string) => `${border("│")}${fit(content, innerWidth)}${border("│")}`;
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${th.bold(th.fg("accent", "问答浏览器"))}  ${th.fg("dim", `${filtered.length}/${this.items.length} 个问题`)}`));
		const cursor = this.focused ? `${CURSOR_MARKER}${th.inverse(" ")}` : "";
		lines.push(row(` ${th.fg("dim", "搜索:")} ${th.fg("text", this.query)}${cursor}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		if (outerWidth >= 86) {
			const leftWidth = Math.min(42, Math.floor(innerWidth * 0.4));
			const rightWidth = innerWidth - leftWidth - 1;
			const visibleCount = contentHeight;
			this.lastWide = true;
			this.lastInnerWidth = innerWidth;
			this.lastPaneSplit = leftWidth + 1;
			this.lastContentBottom = 4 + contentHeight;
			const start = Math.max(0, Math.min(this.selected - Math.floor(visibleCount / 2), filtered.length - visibleCount));
			this.lastListStart = start;
			this.lastListHeight = visibleCount;
			this.lastListRight = leftWidth;
			const answer = selectedItem?.answer || "（尚无文字回答）";
			const detailLines = selectedItem
				? [
					th.bold(th.fg("accent", `Q${selectedItem.index}`)),
					...wrapTextWithAnsi(th.fg("text", selectedItem.question), rightWidth - 2),
					"",
					th.bold(th.fg("success", "回答")),
					...wrapTextWithAnsi(th.fg("text", answer), rightWidth - 2),
				]
				: [th.fg("dim", "没有匹配的问题")];
			const maxOffset = Math.max(0, detailLines.length - visibleCount);
			this.detailOffset = Math.min(this.detailOffset, maxOffset);

			for (let line = 0; line < contentHeight; line++) {
				const itemIndex = start + line;
				const item = filtered[itemIndex];
				let left = "";
				if (item) {
					const prefix = itemIndex === this.selected ? th.fg("accent", "▶") : " ";
					left = ` ${prefix} ${String(item.index).padStart(2, "0")} ${compact(item.question)}`;
					left = fit(left, leftWidth);
					if (itemIndex === this.selected) left = th.bg("selectedBg", left);
				} else {
					left = " ".repeat(leftWidth);
				}
				const right = fit(` ${detailLines[this.detailOffset + line] ?? ""}`, rightWidth);
				lines.push(`${border("│")}${left}${border("│")}${right}${border("│")}`);
			}
		} else {
			const listHeight = Math.max(3, Math.floor(contentHeight * 0.35));
			this.lastWide = false;
			this.lastInnerWidth = innerWidth;
			this.lastPaneSplit = 0;
			this.lastContentBottom = Math.max(4, height - 3);
			const start = Math.max(0, Math.min(this.selected - Math.floor(listHeight / 2), filtered.length - listHeight));
			this.lastListStart = start;
			this.lastListHeight = listHeight;
			this.lastListRight = innerWidth;
			for (let line = 0; line < listHeight; line++) {
				const itemIndex = start + line;
				const item = filtered[itemIndex];
				const prefix = itemIndex === this.selected ? th.fg("accent", "▶") : " ";
				const text = item ? ` ${prefix} ${String(item.index).padStart(2, "0")} ${compact(item.question)}` : "";
				lines.push(row(itemIndex === this.selected ? th.bg("selectedBg", fit(text, innerWidth)) : text));
			}
			lines.push(border(`├${"─".repeat(innerWidth)}┤`));
			const previewWidth = innerWidth - 2;
			const answer = selectedItem?.answer || "（尚无文字回答）";
			const preview = selectedItem
				? [
					th.bold(th.fg("accent", `Q${selectedItem.index} ${compact(selectedItem.question)}`)),
					"",
					...wrapTextWithAnsi(th.fg("text", answer), previewWidth),
				]
				: [th.fg("dim", "没有匹配的问题")];
			const previewHeight = contentHeight - listHeight - 1;
			const maxOffset = Math.max(0, preview.length - previewHeight);
			this.detailOffset = Math.min(this.detailOffset, maxOffset);
			for (let line = 0; line < previewHeight; line++) {
				lines.push(row(` ${preview[this.detailOffset + line] ?? ""}`));
			}
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const footer = this.copyMessage !== undefined && Date.now() < this.copyMessageUntil
			? ` ${th.fg(this.copyMessageIsError ? "error" : "success", this.copyMessage)}${th.fg("dim", " · Esc 关闭")}`
			: ` ${th.fg("dim", `输入搜索 · 点击左侧/↑↓ 选择 · 拖选后 Ctrl+C 复制 · 滚轮/PgUp/PgDn 翻回答 · Ctrl+U 清空 · Esc 关闭`)}`;
		lines.push(row(footer));

		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

		this.applySelectionHighlight(lines);
		this.lastRenderedLines = lines;
		return lines;
	}

	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
		if (this.copyTimer !== undefined) clearTimeout(this.copyTimer);
		if (this.enabledMouseReporting) {
			this.tui.terminal.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
		}
	}
}

export default function qaBrowser(pi: ExtensionAPI) {
	pi.registerCommand("qa", {
		description: "Browse and search user questions with their corresponding answers",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/qa 仅支持交互式 TUI 模式。", "error");
				return;
			}

			await ctx.waitForIdle();
			const items = buildQaItems(ctx.sessionManager.getBranch());
			if (items.length === 0) {
				ctx.ui.notify("当前会话还没有可浏览的用户问题。", "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new QaBrowserComponent(tui, theme, items, done, args.trim()),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "92%",
						minWidth: 40,
						maxHeight: "92%",
					},
				},
			);
		},
	});
}
