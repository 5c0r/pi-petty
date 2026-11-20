import type { PaneComponent, PettyCommandContext, PettyContext, ThemeLike } from "./api";
import { DEFAULT_PET_SETTINGS, PET_COLORS, formatPetError, loadPetSettings, parsePetSettings, resolvePetSprite, savePetSettings, type PetSettings } from "./pet-data";
import { PetEngine, type PetClock } from "./pet-engine";
import { createPetMenu } from "./pet-menu";

const WIDGET_KEY = "petty";
export function colorPet(theme: ThemeLike, palette: PetSettings["palette"], text: string): string {
 return palette === "theme" ? theme.fg("accent", text) : `\x1b[38;2;${PET_COLORS[palette]}m${text}\x1b[39m`;
}

/** Owns host resources; the engine owns only animation state and its one timer. */
export class PetController {
 settings: PetSettings = { ...DEFAULT_PET_SETTINGS };
 private engine?: PetEngine;
 private ctx?: PettyContext;
 private directory?: string;
 private removeWidget?: () => void;
 private widgetRegistered = false;
 private inputDetach?: () => void;
 private menuAbort?: AbortController;
 private closeMenu?: () => void;
 private liveWidgetToken?: object;
 private widgetGeneration = 0;

 constructor(private readonly agentDir: () => string, private readonly clock?: PetClock) { }

 ensure(ctx: PettyContext): void {
  // RPC exposes hasUI but never mounts component factories.
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
  if (this.engine) {
   if (!this.removeWidget && this.settings.motion !== "hidden") this.mountMain();
   return;
  }
  this.ctx = ctx;
  try {
   this.directory = this.agentDir();
   const loaded = loadPetSettings(this.directory);
   this.settings = loaded.settings;
   if (loaded.error) ctx.ui.notify(loaded.error, "warning");
   const resolved = resolvePetSprite(this.settings);
   if (resolved.error) ctx.ui.notify(resolved.error, "warning");
   this.engine = new PetEngine(this.settings, resolved.sprite, this.clock);
   this.mountMain();
  } catch (cause) {
   ctx.ui.notify(`Petty: ${formatPetError(cause)}`, "error");
  }
 }

 reset(ctx: PettyContext): void {
  this.shutdown();
  this.ensure(ctx);
 }

 shutdown(): void {
  this.widgetGeneration++;
  this.closeMenu?.();
  this.closeMenu = undefined;
  this.menuAbort?.abort();
  this.menuAbort = undefined;
  this.removeWidget?.();
  this.removeWidget = undefined;
  this.inputDetach?.();
  this.clearOwnedWidget();
  this.engine?.dispose();
  this.engine = undefined;
  this.ctx = undefined;
  this.directory = undefined;
 }

 /** Replacing a widget is a settings change, never an animation frame. */
 private mountMain(): void {
  const ctx = this.ctx;
  const engine = this.engine;
  if (!ctx || !engine) return;
  const generation = ++this.widgetGeneration;
  this.removeWidget?.();
  this.removeWidget = undefined;
  if (this.settings.motion === "hidden") {
   this.clearOwnedWidget();
   return;
  }
  ctx.ui.setWidget?.(WIDGET_KEY, (tui, theme) => {
   // A pending factory the host invokes after a replacement publishes nothing.
   if (this.widgetGeneration !== generation) {
    return { render: () => [], invalidate() { }, dispose() { } };
   }
   let disposed = false;
   const token = {};
   const unsubscribe = engine.subscribe(() => { if (!disposed) tui.requestRender(); });
   // Publish widget ownership before the input observer can exist for it.
   this.liveWidgetToken = token;
   const detachInput = this.attachMainInput();
   const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    // The live widget's observer dies with it; a replacement installs its own.
    if (this.liveWidgetToken === token) {
     this.liveWidgetToken = undefined;
     this.inputDetach?.();
    }
    detachInput?.();
    if (this.widgetGeneration === generation) {
     // The host took this widget over: relinquish our key registration.
     this.widgetRegistered = false;
     this.removeWidget = undefined;
    }
    // The host can clear widgets before an earlier extension cancels switching.
    // One guarded microtask restores the still-owned widget, never a timer loop.
    queueMicrotask(() => {
     if (this.widgetGeneration === generation && this.engine === engine) this.mountMain();
    });
   };
   this.removeWidget = dispose;
   return {
    render: (width: number) => engine.render(width, (tui.terminal?.rows ?? process.stdout.rows ?? 24) < 14 ? 1 : 3)
     .map(line => colorPet(theme, this.settings.palette, line)),
    invalidate() { },
    dispose,
   };
  }, { placement: "aboveEditor" });
  this.widgetRegistered = true;
 }

 /** Clear the widget key only when this controller registered it. */
 private clearOwnedWidget(): void {
  if (!this.widgetRegistered) return;
  this.widgetRegistered = false;
  this.ctx?.ui.setWidget?.(WIDGET_KEY, undefined);
 }

 /** Register the main input observer once per live widget; identity-guarded. */
 private attachMainInput(): (() => void) | undefined {
  const ctx = this.ctx;
  const engine = this.engine;
  if (!ctx || !engine || !this.liveWidgetToken || this.inputDetach) return undefined;
  if (this.settings.motion === "hidden") return undefined;
  const unobserve = ctx.ui.onTerminalInput?.(data => {
   // This observes terminal input activity, not editor identity or text changes.
   // Never return consume/data or retain the raw input.
   if (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(data) || data === "\x7f" || data.startsWith("\x1b[200~")) {
    engine.activity("typing");
   }
   return undefined;
  });
  if (!unobserve) return undefined;
  const detach = () => {
   if (this.inputDetach !== detach) return;
   this.inputDetach = undefined;
   unobserve();
  };
  this.inputDetach = detach;
  return detach;
 }

 apply(settings: PetSettings): void {
  if (!this.engine || !this.directory) throw new Error("Pet UI is unavailable outside an interactive TUI.");
  const valid = parsePetSettings(settings);
  const resolved = resolvePetSprite(valid);
  if (resolved.error) throw new Error(resolved.error);
  savePetSettings(this.directory, valid);
  this.settings = valid;
  this.engine.update(valid, resolved.sprite);
  this.mountMain();
 }

 activity(kind: "typing" | "reply"): void { this.engine?.activity(kind); }

 /** One visible assistant delta; the engine owns sampling bounds. */
 feedDelta(text: string): number { return this.engine?.feedDelta(text) ?? 0; }

 resetFeed(): void { this.engine?.resetFeed(); }

 async configure(ctx: PettyCommandContext, key: (data: string, key: string) => boolean,
  clip: (text: string, width: number) => string): Promise<void> {
  this.ensure(ctx);
  const engine = this.engine;
  if (!engine) { ctx.ui.notify("Petty needs an interactive TUI.", "warning"); return; }
  if (this.menuAbort) { ctx.ui.notify("Petty settings are already open.", "info"); return; }
  const abort = new AbortController();
  this.menuAbort = abort;
  let closeMenu: (() => void) | undefined;
  try {
   await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const menu = createPetMenu({
     settings: this.settings, engine,
     rows: () => tui.terminal?.rows ?? process.stdout.rows ?? 24,
     key, clip,
     color: (palette, text) => colorPet(theme, palette, text),
     redraw: () => tui.requestRender(),
     commit: settings => {
      if (this.engine !== engine || abort.signal.aborted) throw new Error("Session changed; reopen pet settings.");
      this.apply(settings);
     },
     done: () => closeMenu?.(),
    }) satisfies PaneComponent;
    let closed = false;
    closeMenu = () => {
     if (closed) return;
     closed = true;
     menu.dispose();
     done();
    };
    // Only the current menu's factory may publish the close handle.
    if (this.menuAbort === abort) this.closeMenu = closeMenu;
    if (abort.signal.aborted) closeMenu();
    return menu;
   }, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
    signal: abort.signal,
   });
  } finally {
   if (this.menuAbort === abort) this.menuAbort = undefined;
   if (this.closeMenu === closeMenu) this.closeMenu = undefined;
  }
 }
}
