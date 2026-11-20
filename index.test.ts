import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PettyContext, PettyExtensionAPI, PettyUI } from "./api";
import { DEFAULT_PET_SETTINGS, savePetSettings } from "./pet-data";

let petAgentDir = "";
let petAgentDirThrows = false;
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => {
		if (petAgentDirThrows) throw new Error("agent dir unavailable");
		return petAgentDir;
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	matchesKey: () => false,
	truncateToWidth: (text: string, width: number) => text.slice(0, Math.max(0, width)),
}));

// ponytail: host modules are absent in this dependency-free repo; import only after Bun test mocks exist.
const { default: pettyExtension } = await import("./index");

type CommandHandler = (args: string, context: PettyContext) => Promise<void>;
type EventHandler = (event: unknown, context: PettyContext) => unknown | Promise<unknown>;
type BusHandler = (message: unknown) => void;

interface CapturedPaneLease {
	render(width: number, maxRows: number, theme: { fg(key: string, text: string): string }): readonly string[];
	typing(): void;
	dispose(): void;
}
interface CapturedReplyLease {
	write(delta: string): void;
	dispose(): void;
}

function createHarness(hasUI = true) {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const bus = new Map<string, BusHandler[]>();
	const widgetOwners = new Map<string, unknown>();
	const widgetCalls: Array<{ key: string; cleared: boolean }> = [];
	const inputObservers: Array<(data: string) => unknown> = [];
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
	let widget: { render(width: number): readonly string[]; dispose?(): void } | undefined;
	const context: PettyContext = {
		hasUI,
		mode: "tui",
		ui: {
			notify: () => { },
			custom: (async () => undefined) as PettyUI["custom"],
			setWidget: (key: string, factory: ((tui: unknown, theme: unknown) => unknown) | undefined) => {
				widgetCalls.push({ key, cleared: factory === undefined });
				widgetOwners.set(key, factory);
				widget?.dispose?.();
				widget = factory?.({ requestRender() { }, terminal: { rows: 24, columns: 80 } }, theme) as typeof widget;
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				inputObservers.push(handler);
				return () => {
					const index = inputObservers.indexOf(handler);
					if (index >= 0) inputObservers.splice(index, 1);
				};
			},
		},
	};
	pettyExtension({
		on(event, handler) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler as EventHandler);
			events.set(event, handlers);
		},
		registerCommand(name, options) {
			commands.set(name, options.handler as CommandHandler);
		},
		events: {
			on(channel, handler) {
				const handlers = bus.get(channel) ?? [];
				handlers.push(handler);
				bus.set(channel, handlers);
				return () => {
					const list = bus.get(channel) ?? [];
					const index = list.indexOf(handler);
					if (index >= 0) list.splice(index, 1);
				};
			},
		},
	} as PettyExtensionAPI);
	return {
		busHandlerCount: () => (bus.get("fireside:companion:v1") ?? []).length,
		commands,
		context,
		events,
		inputObservers,
		petRows: (columns = 60) => widget?.render(columns),
		get currentWidget() {
			return widget;
		},
		widgetCalls,
		widgetOwners,
		/** Controlled bus boundary: the real hosts emit synchronously. */
		busEmit(message: unknown) {
			for (const handler of bus.get("fireside:companion:v1") ?? []) handler(message);
		},
		async emit(event: string, payload: unknown = {}) {
			for (const handler of events.get(event) ?? []) await handler(payload, context);
		},
	};
}

function scratchAgentDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	petAgentDir = directory;
	return directory;
}

function releaseAgentDir(directory: string, harness: { emit(event: string, payload?: unknown): Promise<void> }) {
	void harness.emit("session_shutdown");
	petAgentDir = "";
	rmSync(directory, { recursive: true, force: true });
}


describe("petty standalone ownership", () => {
	test("session_start and session_shutdown leave a preexisting petty widget untouched without pet IO", async () => {
		const harness = createHarness();
		const directory = scratchAgentDir("petty-own-");
		// Fireside-only placement with static motion: Petty owns no main pet here.
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside", motion: "static" });
		// Sentinel: another extension already owns the petty widget key.
		const sentinel = () => ({
			render: () => ["sentinel pet row"] as readonly string[],
			invalidate: () => { },
		});
		harness.widgetOwners.set("petty", sentinel);
		harness.widgetCalls.length = 0;
		try {
			// The standalone entry registers /petty only — no combined-era alias.
			expect(harness.commands.has("petty")).toBe(true);
			expect(harness.commands.has("fireside-pet")).toBe(false);

			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([]);
			expect(harness.widgetOwners.get("petty")).toBe(sentinel);
			expect(harness.inputObservers).toHaveLength(0);

			await harness.emit("session_shutdown");
			expect(harness.widgetCalls).toEqual([]);
			expect(harness.widgetOwners.get("petty")).toBe(sentinel);
			expect(harness.inputObservers).toHaveLength(0);
		} finally {
			releaseAgentDir(directory, harness);
		}
	});

	test("an owned main widget mounts on session_start and clears with its observer and bus listener on shutdown", async () => {
		const harness = createHarness();
		const directory = scratchAgentDir("petty-main-");
		try {
			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([{ key: "petty", cleared: false }]);
			expect(harness.petRows(60)?.join("\n")).toMatch(/Miso/);
			expect(harness.inputObservers).toHaveLength(1);
			expect(harness.busHandlerCount()).toBe(1);
			await harness.emit("session_shutdown");
			expect(harness.widgetCalls).toEqual([
				{ key: "petty", cleared: false },
				{ key: "petty", cleared: true },
			]);
			expect(harness.inputObservers).toHaveLength(0);
			expect(harness.busHandlerCount()).toBe(0);
			// The companion listener is gone: a reply attach is a plain no-op.
			let attached = false;
			harness.busEmit({ kind: "reply", attach: () => { attached = true; } });
			expect(attached).toBe(false);
		} finally {
			releaseAgentDir(directory, harness);
		}
	});

	test("headless hosts never register pets, the main widget, or the companion listener", async () => {
		const harness = createHarness(false);
		try {
			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([]);
			expect(harness.inputObservers).toHaveLength(0);
			expect(harness.busHandlerCount()).toBe(0);
			harness.busEmit({ kind: "reply", attach: () => { throw new Error("must not attach"); } });
			await harness.emit("session_shutdown");
		} finally {
			releaseAgentDir("", harness);
		}
	});
});

describe("streaming crumbs producers", () => {
	test("main assistant text_delta events drop food; thinking and tool events do not", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-feed-");
		try {
			await harness.emit("session_start");
			const baseline = harness.petRows(60)?.join("\n") ?? "";
			const assistant = { message: { role: "assistant" } };
			await harness.emit("message_start");
			const update = (assistantMessageEvent: unknown) =>
				Promise.all((harness.events.get("message_update") ?? [])
					.map(handler => handler({ ...assistant, assistantMessageEvent }, harness.context)));
			await update({ type: "thinking_delta", delta: "internal reasoning" });
			await update({ type: "tool_call", name: "bash" });
			expect(harness.petRows(60)?.join("\n")).toBe(baseline);
			await update({ type: "text_delta", delta: "q7" });
			const rows = harness.petRows(60)?.join("\n") ?? "";
			expect(rows).not.toBe(baseline);
			expect(rows).toContain("q7");
			await update({ type: "thinking_delta", delta: "more reasoning" });
			expect(harness.petRows(60)?.join("\n")).toBe(rows);
		} finally {
			Math.random = originalRandom;
			releaseAgentDir(directory, harness);
		}
	});

	test("reply lease text_delta feeds the shared feeder from the companion channel", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-reply-");
		try {
			await harness.emit("session_start");
			const baseline = harness.petRows(60)?.join("\n") ?? "";
			let lease: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { lease = captured; } });
			expect(lease).toBeDefined();
			lease!.write("z9");
			const rows = harness.petRows(60)?.join("\n") ?? "";
			expect(rows).not.toBe(baseline);
			expect(rows).toContain("z9");
			// The seam stays one-way: a disposed lease can never feed again.
			lease!.dispose();
			lease!.write("late");
			expect(harness.petRows(60)?.join("\n")).toBe(rows);
		} finally {
			Math.random = originalRandom;
			releaseAgentDir(directory, harness);
		}
	});

	test("actual main and reply producers discard text during terminal typing and resume without backlog", async () => {
		let now = 10000;
		const realNow = Date.now;
		Date.now = () => now;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-typing-");
		try {
			await harness.emit("session_start");
			harness.petRows(60);
			harness.inputObservers[0]?.("draft");
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q7" },
			});
			let lease: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { lease = captured; } });
			lease!.write("z9");
			expect(harness.petRows(60)?.join("\n")).not.toContain("q7");
			expect(harness.petRows(60)?.join("\n")).not.toContain("z9");
			now += 1500;
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q8" },
			});
			const rows = harness.petRows(60)?.join("\n") ?? "";
			expect(rows).toContain("q8");
			expect(rows).not.toContain("q7");
			expect(rows).not.toContain("z9");
		} finally {
			Date.now = realNow;
			releaseAgentDir(directory, harness);
		}
	});

	test("actual producer boundaries reset only their parser and never cross-contaminate sources", async () => {
		let now = 10000;
		const realNow = Date.now;
		Date.now = () => now;
		let randomValue = 0.2;
		const realRandom = Math.random;
		Math.random = () => randomValue;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-parsers-");
		const rows = () => harness.petRows(80)?.join("\n") ?? "";
		const main = (delta: string) => harness.emit("message_update", {
			message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta },
		});
		const attachReply = () => {
			let lease: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { lease = captured; } });
			return () => lease!;
		};
		try {
			await harness.emit("session_start");
			harness.petRows(80);
			await main("\x1b]52;c;");
			const firstReply = attachReply();
			firstReply().write("ok");
			expect(rows()).toContain("ok");
			now += 500;
			await main("SECRET");
			expect(rows()).not.toContain("SEC");
			await harness.emit("message_end", { message: { role: "assistant" } });
			randomValue = 0.4;
			await main("yes");
			expect(rows()).toContain("yes");
			now += 500;
			await main("\x1b[");
			await harness.emit("message_start", { message: { role: "assistant" } });
			randomValue = 0.6;
			await main("new");
			expect(rows()).toContain("new");
			now += 500;
			// A partial fireside sequence holds its parser; a replacement
			// reply lease resets exactly that parser at the turn boundary.
			const staleReply = attachReply();
			staleReply().write("\x1b]52;c;");
			now += 500;
			randomValue = 0.8;
			const freshReply = attachReply();
			freshReply().write("end");
			expect(rows()).toContain("end");
			// The stale lease can neither feed nor reset the fresh parser.
			staleReply().write("STALE");
			staleReply().dispose();
			freshReply().write("tail");
			expect(rows()).not.toContain("STALE");
		} finally {
			Date.now = realNow;
			Math.random = realRandom;
			releaseAgentDir(directory, harness);
		}
	});
});

describe("companion pane leases", () => {
	test("pane leases draw the strip, own typing, and suspend the main input observer until close", async () => {
		const clock = controlledClock();
		let randomValue = 0.5;
		const originalRandom = Math.random;
		Math.random = () => randomValue;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-pane-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "both" });
		const rows = () => harness.petRows(60)?.join("\n") ?? "";
		try {
			await harness.emit("session_start");
			expect(harness.inputObservers).toHaveLength(1);
			let paints = 0;
			let pane: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { paints++; },
				attach: lease => { pane = lease; },
			});
			expect(pane).toBeDefined();
			// The focused pane owns input: the main observer is suspended.
			expect(harness.inputObservers).toHaveLength(0);
			const strip = pane!.render(60, 3, { fg: (_key, text) => text });
			expect(strip.length).toBeGreaterThan(0);
			expect(strip.join("\n")).toMatch(/Miso/);
			// Pane typing is the sole activity path while the pane is open.
			let reply: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { reply = captured; } });
			pane!.typing();
			reply!.write("z9");
			expect(rows()).not.toContain("z9");
			for (let tick = 0; tick < 6; tick++) await clock.tick();
			reply!.write("z8");
			expect(rows()).toContain("z8");
			// A replacement pane keeps the hold; the stale dispose cannot restore input.
			let nextPane: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { paints++; },
				attach: lease => { nextPane = lease; },
			});
			expect(harness.inputObservers).toHaveLength(0);
			pane!.dispose();
			expect(harness.inputObservers).toHaveLength(0);
			// Closing the live pane restores the owned main observer; the
			// active reply keeps feeding after the pane is gone.
			nextPane!.dispose();
			expect(harness.inputObservers).toHaveLength(1);
			// Distinct column + ticked physics keep the new crumb visible.
			randomValue = 0.2;
			await clock.tick();
			await clock.tick();
			reply!.write("q5");
			expect(rows()).toContain("q5");
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				Math.random = originalRandom;
				clock.restore();
			}
		}
	});

	test("session transitions rebind the pane strip and invalidate old replies", async () => {
		const harness = createHarness();
		const directory = scratchAgentDir("petty-switch-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside" });
		try {
			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([]);
			let pane: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { },
				attach: lease => { pane = lease; },
			});
			pane!.render(60, 3, { fg: (_key, text) => text });
			let reply: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { reply = captured; } });
			reply!.write("z9");
			expect(pane!.render(60, 3, { fg: (_key, text) => text }).join("\n")).toContain("z9");
			await harness.emit("session_switch");
			// The old reply died at the boundary: its writes feed nothing.
			reply!.write("x7");
			const strip = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(strip).not.toContain("x7");
			// The pane strip survives the transition on the rebuilt engine.
			expect(strip).toMatch(/Miso/);
			// The pane still owns input across the transition: no main observer.
			expect(harness.inputObservers).toHaveLength(0);
		} finally {
			releaseAgentDir(directory, harness);
		}
	});
});

/** Controlled engine-clock scope: SYSTEM_CLOCK resolves Date.now and
 * setInterval/clearInterval dynamically, so scoped globals drive the real
 * engine timers deterministically (TICK_MS = 250) with no production seam. */
function controlledClock(start = 10000) {
	const realNow = Date.now;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	let now = start;
	const timers = new Map<number, () => void>();
	let nextHandle = 0;
	Date.now = () => now;
	globalThis.setInterval = ((fn: () => void) => {
		const handle = ++nextHandle;
		timers.set(handle, fn);
		return handle;
	}) as typeof globalThis.setInterval;
	globalThis.clearInterval = ((handle: unknown) => {
		timers.delete(handle as number);
	}) as typeof globalThis.clearInterval;
	return {
		async tick() {
			now += 250;
			for (const fn of [...timers.values()]) fn();
			await Promise.resolve();
		},
		advance(ms: number) {
			now += ms;
		},
		liveTimers: () => timers.size,
		restore() {
			timers.clear();
			Date.now = realNow;
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		},
	};
}

describe("companion lifecycle ownership", () => {
	test("pane replacement stops the old redraw callback and only the live pane renders", async () => {
		const clock = controlledClock();
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-replace-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside" });
		try {
			await harness.emit("session_start");
			let firstPaints = 0;
			let first: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { firstPaints++; },
				attach: lease => { first = lease; },
			});
			first!.render(60, 3, { fg: (_key, text) => text });
			let secondPaints = 0;
			let second: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { secondPaints++; },
				attach: lease => { second = lease; },
			});
			second!.render(60, 3, { fg: (_key, text) => text });
			for (let tick = 0; tick < 4; tick++) await clock.tick();
			expect(secondPaints).toBeGreaterThan(0);
			// The replaced pane's redraw callback must be gone: only the live pane ticks.
			expect(firstPaints).toBe(0);
			// Closing the live pane stops the last Fireside-only timer.
			second!.dispose();
			const settled = secondPaints;
			for (let tick = 0; tick < 4; tick++) await clock.tick();
			expect(secondPaints).toBe(settled);
			expect(clock.liveTimers()).toBe(0);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				clock.restore();
			}
		}
	});

	test("a disposed pane lease neither renders nor suppresses new visible food", async () => {
		let now = 10000;
		const realNow = Date.now;
		Date.now = () => now;
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-stale-pane-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "both" });
		try {
			await harness.emit("session_start");
			harness.petRows(60);
			let first: CapturedPaneLease | undefined;
			harness.busEmit({ kind: "pane", requestRender: () => { }, attach: lease => { first = lease; } });
			harness.busEmit({ kind: "pane", requestRender: () => { }, attach: () => { } });
			// The replaced lease must not draw on a later frame.
			expect(first!.render(60, 3, { fg: (_key, text) => text })).toEqual([]);
			// Its typing must not pause food for the live owner.
			first!.typing();
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q7" },
			});
			expect(harness.petRows(60)?.join("\n")).toContain("q7");
		} finally {
			Date.now = realNow;
			Math.random = originalRandom;
			releaseAgentDir(directory, harness);
		}
	});

	test("session shutdown closes the pane lease and a renewed session never rebinds its callback", async () => {
		const clock = controlledClock();
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-renew-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside" });
		try {
			await harness.emit("session_start");
			let paints = 0;
			let pane: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => { paints++; },
				attach: lease => { pane = lease; },
			});
			pane!.render(60, 3, { fg: (_key, text) => text });
			for (let tick = 0; tick < 2; tick++) await clock.tick();
			expect(paints).toBeGreaterThan(0);
			await harness.emit("session_shutdown");
			await harness.emit("session_start");
			// The closed pane's callback must not come back with the renewed engine.
			const paintsNow = paints;
			for (let tick = 0; tick < 4; tick++) await clock.tick();
			expect(paints).toBe(paintsNow);
			expect(clock.liveTimers()).toBe(0);
			expect(harness.inputObservers).toHaveLength(0);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				clock.restore();
			}
		}
	});

	test("a throwing pane attach releases its subscription, restores owned main input, and leaves no Fireside-only timer", async () => {
		const clock = controlledClock();
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-attach-throw-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "both" });
		try {
			await harness.emit("session_start");
			expect(harness.inputObservers).toHaveLength(1);
			let paints = 0;
			// The optional peer's failure must be contained by the handler itself.
			let escaped: unknown;
			try {
				harness.busEmit({
					kind: "pane",
					requestRender: () => { paints++; },
					attach: () => { throw new Error("peer rejected the lease"); },
				});
			} catch (error) {
				escaped = error;
			}
			expect(escaped).toBeUndefined();
			// Optional peer failure restores the owned main input observer…
			expect(harness.inputObservers).toHaveLength(1);
			// …and leaks no animation subscription: no ticks may reach it.
			for (let tick = 0; tick < 4; tick++) await clock.tick();
			expect(paints).toBe(0);
			// The failed attempt does not block a later owner.
			let lease: CapturedPaneLease | undefined;
			harness.busEmit({ kind: "pane", requestRender: () => { }, attach: captured => { lease = captured; } });
			expect(lease).toBeDefined();
			lease!.dispose();
			expect(harness.inputObservers).toHaveLength(1);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				clock.restore();
			}
		}
	});

	test("a throwing reply attach does not block the next reply owner or the main producer", async () => {
		const clock = controlledClock();
		const originalRandom = Math.random;
		let randomValue = 0.5;
		Math.random = () => randomValue;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-reply-throw-");
		try {
			await harness.emit("session_start");
			harness.petRows(60);
			const baseline = harness.petRows(60)?.join("\n") ?? "";
			// The optional peer's failure must be contained by the handler itself.
			let escaped: unknown;
			try {
				harness.busEmit({
					kind: "reply",
					attach: () => { throw new Error("peer rejected the lease"); },
				});
			} catch (error) {
				escaped = error;
			}
			expect(escaped).toBeUndefined();
			// Main producer unaffected by the optional peer failure.
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q7" },
			});
			const rows = harness.petRows(60)?.join("\n") ?? "";
			expect(rows).not.toBe(baseline);
			expect(rows).toContain("q7");
			// The next reply owner still feeds (shared 2/s sampling spaced by the clock).
			let randomValue2 = 0.2;
			Math.random = () => randomValue2;
			await clock.tick();
			await clock.tick();
			let lease: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { lease = captured; } });
			lease!.write("z9");
			expect(harness.petRows(60)?.join("\n")).toContain("z9");
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				Math.random = originalRandom;
				clock.restore();
			}
		}
	});

	test("the companion listener follows engine availability across failed and recovered initializations", async () => {
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-init-");
		petAgentDirThrows = true;
		try {
			await harness.emit("session_start");
			// A failed initialization owns no engine: no companion listener.
			expect(harness.busHandlerCount()).toBe(0);
			petAgentDirThrows = false;
			await harness.emit("session_switch");
			// A recovered lifecycle acquires the listener.
			expect(harness.busHandlerCount()).toBe(1);
			petAgentDirThrows = true;
			await harness.emit("session_switch");
			// Losing the engine again releases it.
			expect(harness.busHandlerCount()).toBe(0);
		} finally {
			petAgentDirThrows = false;
			releaseAgentDir(directory, harness);
		}
	});

	test("a throwing peer redraw callback cannot escape the main message handler or teardown", async () => {
		const clock = controlledClock();
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-redraw-throw-");
		try {
			await harness.emit("session_start");
			harness.petRows(60);
			harness.busEmit({
				kind: "pane",
				requestRender: () => { throw new Error("peer redraw exploded"); },
				attach: () => { },
			});
			// A visible main delta must feed the pet even when the peer redraw throws.
			await expect(harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q7" },
			})).resolves.toBeUndefined();
			expect(harness.petRows(60)?.join("\n")).toContain("q7");
			// Teardown still completes and clears owned resources.
			await expect(harness.emit("session_shutdown")).resolves.toBeUndefined();
			expect(harness.widgetCalls.at(-1)).toEqual({ key: "petty", cleared: true });
			expect(harness.inputObservers).toHaveLength(0);
			expect(clock.liveTimers()).toBe(0);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				Math.random = originalRandom;
				clock.restore();
			}
		}
	});

	test("session_clear invalidates old reply leases and keeps the pane strip safe", async () => {
		const clock = controlledClock();
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-clear-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside" });
		try {
			await harness.emit("session_start");
			let pane: CapturedPaneLease | undefined;
			harness.busEmit({ kind: "pane", requestRender: () => { }, attach: lease => { pane = lease; } });
			pane!.render(60, 3, { fg: (_key, text) => text });
			let reply: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { reply = captured; } });
			reply!.write("z9");
			expect(pane!.render(60, 3, { fg: (_key, text) => text }).join("\n")).toContain("z9");
			clock.advance(1500);
			// omp emits session_clear on context reset: the transition rules apply.
			await harness.emit("session_clear");
			// The context reset rebuilds the world: the old visible crumb is
			// gone from the drawable rebuilt strip while the pet remains.
			const rebuilt = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(rebuilt).not.toContain("z9");
			expect(rebuilt).toMatch(/Miso/);
			reply!.write("x7");
			const strip = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(strip).not.toContain("x7");
			// Positive control: a fresh lease owns the next boundary and feeds.
			clock.advance(1500);
			let fresh: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { fresh = captured; } });
			fresh!.write("q3");
			const fed = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(fed).toContain("q3");
			expect(fed).not.toContain("x7");
			expect(fed).toMatch(/Miso/);
			expect(clock.liveTimers()).toBe(1);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				Math.random = originalRandom;
				clock.restore();
			}
		}
	});

	test("a reentrant redraw cannot make a stale reply write feed the next session", async () => {
		const clock = controlledClock();
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-reentrant-");
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "fireside" });
		let transitioned = false;
		try {
			await harness.emit("session_start");
			let armed = false;
			let reentered = false;
			let pane: CapturedPaneLease | undefined;
			harness.busEmit({
				kind: "pane",
				requestRender: () => {
					// A peer redraw may switch sessions reentrantly; the new
					// world is drawable before the stale outer feed resumes.
					if (armed && !reentered) {
						reentered = true;
						void harness.emit("session_switch");
						pane!.render(60, 3, { fg: (_key, text) => text });
						transitioned = true;
					}
				},
				attach: lease => { pane = lease; },
			});
			pane!.render(60, 3, { fg: (_key, text) => text });
			let reply: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { reply = captured; } });
			// Park the pet idle so the reply activity itself redraws synchronously.
			pane!.typing();
			clock.advance(2000);
			armed = true;
			reply!.write("z9");
			expect(transitioned).toBe(true);
			// The write started on the old session; its delta must never reach the new one.
			let strip = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(strip).not.toContain("z9");
			expect(strip).toMatch(/Miso/);
			// A fresh lease on the new session still feeds the rebuilt world.
			clock.advance(500);
			let fresh: CapturedReplyLease | undefined;
			harness.busEmit({ kind: "reply", attach: captured => { fresh = captured; } });
			fresh!.write("q3");
			strip = pane!.render(60, 3, { fg: (_key, text) => text }).join("\n");
			expect(strip).toContain("q3");
			expect(strip).not.toContain("z9");
			expect(clock.liveTimers()).toBe(1);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				Math.random = originalRandom;
				clock.restore();
			}
		}
	});

	test("host widget replacement followed by shutdown leaves the host sentinel intact", async () => {
		const clock = controlledClock();
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-sentinel-");
		try {
			await harness.emit("session_start");
			expect(harness.widgetOwners.get("petty")).toBeDefined();
			// The host disposes Petty's widget and installs its own sentinel.
			harness.currentWidget?.dispose?.();
			const sentinel = () => ({
				render: () => ["host sentinel row"] as readonly string[],
				invalidate: () => { },
			});
			harness.widgetOwners.set("petty", sentinel);
			harness.widgetCalls.length = 0;
			await harness.emit("session_shutdown");
			// Petty never re-registered after the host takeover: clearing would wipe the sentinel.
			expect(harness.widgetCalls).toEqual([]);
			expect(harness.widgetOwners.get("petty")).toBe(sentinel);
			expect(clock.liveTimers()).toBe(0);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				clock.restore();
			}
		}
	});
});
