import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetController } from "./pet-host";
import type { PaneComponent, PettyContext } from "./api";
import type { PetClock } from "./pet-engine";

function harness(clock?: PetClock) {
 const directory = mkdtempSync(join(tmpdir(), "petty-host-"));
 let widget: PaneComponent | undefined;
 let input: ((data: string) => unknown) | undefined;
 let released = 0;
 const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value };
 const ctx = {
  hasUI: true,
  mode: "tui",
  ui: {
   notify: () => { },
   onTerminalInput: (fn: typeof input) => { input = fn; return () => { input = undefined; released++; }; },
   setWidget: (_: string, factory: ((tui: unknown, theme: unknown) => PaneComponent) | undefined) => {
    widget?.dispose?.();
    widget = factory?.({ requestRender() { } }, theme);
   },
  },
 } as unknown as PettyContext;
 const controller = new PetController(() => directory, clock);
 return {
  directory, ctx, controller, theme, widget: () => widget, input: () => input, released: () => released,
  close() { controller.shutdown(); rmSync(directory, { recursive: true, force: true }); }
 };
}

test("main widget preserves input and removes listener on replacement and shutdown", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  const first = ui.widget();
  expect(first?.render(40).join("\n")).toMatch(/Miso/);
  expect(ui.input()?.("draft")).toBeUndefined();
  ui.controller.reset(ui.ctx);
  expect(ui.released()).toBe(1);
  expect(ui.widget()).not.toBe(first);
  // Stale widget disposal cannot tear down the replacement's input observer.
  first?.dispose?.();
  expect(ui.input()).toBeDefined();
  ui.controller.shutdown();
  expect(ui.widget()).toBeUndefined();
  expect(ui.input()).toBeUndefined();
  expect(ui.released()).toBe(2);
 } finally { ui.close(); }
});

test("hidden mode tears down the main widget and its input observer", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  expect(ui.widget()).toBeDefined();
  expect(ui.input()).toBeDefined();
  ui.controller.apply({ ...ui.controller.settings, motion: "hidden" });
  expect(ui.widget()).toBeUndefined();
  expect(ui.input()).toBeUndefined();
  ui.controller.apply({ ...ui.controller.settings, motion: "static" });
  expect(ui.widget()).toBeDefined();
  expect(ui.input()).toBeDefined();
 } finally { ui.close(); }
});

test("settings survive a controller restart without entering conversation history", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  ui.controller.apply({ ...ui.controller.settings, pet: "toast", name: "Biscuit", nameFollowsPet: false, motion: "static" });
  ui.controller.shutdown();
  const restarted = new PetController(() => ui.directory);
  try {
   restarted.ensure(ui.ctx);
   expect(restarted.settings.pet).toBe("toast");
   expect(ui.widget()?.render(50).join("\n")).toContain("Biscuit");
  } finally { restarted.shutdown(); }
 } finally { ui.close(); }
});

test("headless hosts and legacy fake UI do not initialize pet IO or timers", () => {
 let resolved = 0;
 const controller = new PetController(() => { resolved++; throw new Error("must stay lazy"); });
 controller.ensure({ hasUI: false, ui: {} } as PettyContext);
 controller.ensure({ hasUI: true, ui: {} } as PettyContext);
 controller.ensure({ ...harnessContextForRpc(), mode: "rpc" } as PettyContext);
});

function harnessContextForRpc() {
 return { hasUI: true, ui: { setWidget() { throw new Error("RPC must never mount widgets"); } } };
}

test("host-cleared widgets restore once even when another extension cancels session switching", async () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  const first = ui.widget();
  ui.ctx.ui.setWidget!("petty", undefined);
  expect(ui.input()).toBeUndefined();
  await Promise.resolve();
  expect(ui.widget()).toBeDefined();
  expect(ui.widget()).not.toBe(first);
  expect(ui.input()).toBeDefined();
  ui.controller.shutdown();
  await Promise.resolve();
  expect(ui.widget()).toBeUndefined();
  expect(ui.input()).toBeUndefined();
 } finally { ui.close(); }
});

test("session reset explicitly closes a menu when the host ignores custom UI abort signals", async () => {
 const ui = harness();
 let closed = 0;
 let menu: PaneComponent | undefined;
 let release: (() => void) | undefined;
 ui.ctx.ui.custom = async factory => {
  const pending = Promise.withResolvers<never>();
  release = () => { closed++; pending.resolve(undefined as never); };
  const component = factory({ requestRender() { } }, ui.theme, undefined, () => release?.());
  menu = component as PaneComponent;
  return pending.promise;
 };
 try {
  const configured = ui.controller.configure(ui.ctx, () => false, (line, width) => line.slice(0, width));
  expect(menu).toBeDefined();
  ui.controller.reset(ui.ctx);
  expect(closed).toBe(1);
  await configured;
  expect(ui.widget()).toBeDefined();
 } finally { release?.(); ui.close(); }
});

test("a stale deferred menu factory cannot steal or clear the active menu close handle", async () => {
 const ui = harness();
 const closed = { a: 0, b: 0 };
 let invokeStaleFactory: (() => void) | undefined;
 const first = Promise.withResolvers<void>();
 // Menu A: the host defers invoking the factory until later.
 ui.ctx.ui.custom = (async factory => {
  const pending = Promise.withResolvers<never>();
  invokeStaleFactory = () => {
   void factory({ requestRender() { } }, ui.theme, undefined, () => { closed.a++; pending.resolve(undefined as never); });
  };
  first.resolve();
  return pending.promise;
 }) as typeof ui.ctx.ui.custom;
 const configuredA = ui.controller.configure(ui.ctx, () => false, (line, width) => line.slice(0, width));
 try {
  await first.promise;
  // A session reset aborts menu A before its factory ever ran.
  ui.controller.reset(ui.ctx);
  expect(closed.a).toBe(0);
  // Menu B opens and the host invokes B's factory immediately.
  const second = Promise.withResolvers<void>();
  ui.ctx.ui.custom = (async factory => {
   const pending = Promise.withResolvers<never>();
   void factory({ requestRender() { } }, ui.theme, undefined, () => { closed.b++; pending.resolve(undefined as never); });
   second.resolve();
   return pending.promise;
  }) as typeof ui.ctx.ui.custom;
  const configuredB = ui.controller.configure(ui.ctx, () => false, (line, width) => line.slice(0, width));
  await second.promise;
  expect(closed.b).toBe(0);
  // The stale A factory finally runs: it closes itself, but must not touch B's handle.
  invokeStaleFactory!();
  expect(closed.a).toBe(1);
  // A later reset must still explicitly close B on hosts ignoring abort signals.
  ui.controller.reset(ui.ctx);
  expect(closed.b).toBe(1);
  await configuredA;
  void configuredB;
 } finally {
  ui.close();
 }
});

test("a stale pending widget factory cannot publish over the live widget's handle", () => {
 const ui = harness();
 const deferred: Array<() => PaneComponent> = [];
 // Deferred host: registers factories, invokes each only when told.
 ui.ctx.ui.setWidget = (_key: string, factory: ((tui: unknown, theme: unknown) => PaneComponent) | undefined) => {
  if (factory) deferred.push(() => factory({ requestRender() { } }, ui.theme) as PaneComponent);
 };
 ui.controller.ensure(ui.ctx);
 ui.controller.apply({ ...ui.controller.settings, name: "Biscuit" });
 expect(deferred.length).toBe(2);
 // The host invokes the current factory, then the stale pending one.
 deferred[1]!();
 deferred[0]!();
 expect(ui.input()).toBeDefined();
 // Replacing the live widget must detach its observer via the live handle.
 ui.controller.apply({ ...ui.controller.settings, name: "Nori" });
 expect(ui.released()).toBe(1);
 deferred[2]!();
 expect(ui.input()).toBeDefined();
 ui.controller.shutdown();
 expect(ui.released()).toBe(2);
});

test("host initialization errors escape terminal controls before notification", () => {
 const ui = harness();
 const messages: string[] = [];
 ui.ctx.ui.notify = message => { messages.push(message); };
 const controller = new PetController(() => { throw new Error("agent directory: \u001b[2J\u009b0m\u202e"); });
 try {
  controller.ensure(ui.ctx);
  const message = messages[0] ?? "";
  const unsafeCodes = Array.from(message).filter(char => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)).map(char => char.codePointAt(0));
  expect(unsafeCodes).toEqual([]);
  expect(message.includes("agent directory:")).toBe(true);
  expect(message.includes("\\u001b")).toBe(true);
 } finally { controller.shutdown(); ui.close(); }
});
