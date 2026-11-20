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
		// Event-bus trap: this host offers a public bus, so any cross-extension
		// listener the extension tried to register would be counted here.
		events: {
			on(channel: string, handler: BusHandler) {
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
		busHandlerCount: () => [...bus.values()].reduce((total, handlers) => total + handlers.length, 0),
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
		// Hidden motion: Petty owns no main pet here.
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, motion: "hidden" });
		// Sentinel: another extension already owns the petty widget key.
		const sentinel = () => ({
			render: () => ["sentinel pet row"] as readonly string[],
			invalidate: () => { },
		});
		harness.widgetOwners.set("petty", sentinel);
		harness.widgetCalls.length = 0;
		try {
			// The standalone entry registers /petty only.
			expect(harness.commands.has("petty")).toBe(true);

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

	test("an owned main widget mounts on session_start and clears with its observer on shutdown", async () => {
		const clock = controlledClock();
		const harness = createHarness();
		const directory = scratchAgentDir("petty-main-");
		try {
			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([{ key: "petty", cleared: false }]);
			expect(harness.petRows(60)?.join("\n")).toMatch(/Miso/);
			expect(harness.inputObservers).toHaveLength(1);
			// No cross-extension subscriptions: a host bus stays untouched.
			expect(harness.busHandlerCount()).toBe(0);
			await harness.emit("session_shutdown");
			expect(harness.widgetCalls).toEqual([
				{ key: "petty", cleared: false },
				{ key: "petty", cleared: true },
			]);
			expect(harness.inputObservers).toHaveLength(0);
			expect(harness.busHandlerCount()).toBe(0);
			expect(clock.liveTimers()).toBe(0);
		} finally {
			try {
				releaseAgentDir(directory, harness);
			} finally {
				clock.restore();
			}
		}
	});

	test("headless hosts never register pets or the main widget", async () => {
		const harness = createHarness(false);
		try {
			await harness.emit("session_start");
			expect(harness.widgetCalls).toEqual([]);
			expect(harness.inputObservers).toHaveLength(0);
			expect(harness.busHandlerCount()).toBe(0);
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

	test("the main producer discards text during terminal typing and resumes without backlog", async () => {
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
			expect(harness.petRows(60)?.join("\n")).not.toContain("q7");
			now += 1500;
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q8" },
			});
			const rows = harness.petRows(60)?.join("\n") ?? "";
			expect(rows).toContain("q8");
			expect(rows).not.toContain("q7");
		} finally {
			Date.now = realNow;
			releaseAgentDir(directory, harness);
		}
	});

	test("main producer boundaries reset the parser and never leak held sequences", async () => {
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
		try {
			await harness.emit("session_start");
			harness.petRows(80);
			// A partial control sequence holds its parser: later text stays hidden.
			await main("\x1b]52;c;");
			now += 500;
			await main("SECRET");
			expect(rows()).not.toContain("SEC");
			await harness.emit("message_end", { message: { role: "assistant" } });
			randomValue = 0.4;
			await main("yes");
			expect(rows()).toContain("yes");
			now += 500;
			// A partial sequence again, this time across a message_start boundary.
			await main("\x1b[");
			await harness.emit("message_start", { message: { role: "assistant" } });
			randomValue = 0.6;
			await main("new");
			expect(rows()).toContain("new");
		} finally {
			Date.now = realNow;
			Math.random = realRandom;
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

describe("standalone lifecycle ownership", () => {
	test("a failed initialization recovers on a later session transition", async () => {
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-init-");
		petAgentDirThrows = true;
		try {
			await harness.emit("session_start");
			// A failed initialization owns no engine and mounts nothing.
			expect(harness.widgetCalls).toEqual([]);
			petAgentDirThrows = false;
			await harness.emit("session_switch");
			// A recovered lifecycle mounts the owned widget.
			expect(harness.widgetCalls).toEqual([{ key: "petty", cleared: false }]);
			petAgentDirThrows = true;
			await harness.emit("session_switch");
			// Losing the engine again clears it.
			expect(harness.widgetCalls).toEqual([
				{ key: "petty", cleared: false },
				{ key: "petty", cleared: true },
			]);
		} finally {
			petAgentDirThrows = false;
			releaseAgentDir(directory, harness);
		}
	});

	test("session_clear rebuilds the pet world and drops old crumbs", async () => {
		const clock = controlledClock();
		const originalRandom = Math.random;
		Math.random = () => 0.5;
		const harness = createHarness();
		const directory = scratchAgentDir("petty-red-clear-");
		const rows = () => harness.petRows(60)?.join("\n") ?? "";
		try {
			await harness.emit("session_start");
			rows();
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "z9" },
			});
			expect(rows()).toContain("z9");
			clock.advance(1500);
			// omp emits session_clear on context reset: the transition rules apply.
			await harness.emit("session_clear");
			// The context reset rebuilds the world: the old visible crumb is
			// gone while the pet remains.
			const rebuilt = rows();
			expect(rebuilt).not.toContain("z9");
			expect(rebuilt).toMatch(/Miso/);
			// Positive control: the next boundary feeds the rebuilt world.
			clock.advance(1500);
			await harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q3" },
			});
			const fed = rows();
			expect(fed).toContain("q3");
			expect(fed).not.toContain("z9");
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
