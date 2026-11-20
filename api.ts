/**
 * Minimal structural types for the host extension API surface pi-petty
 * consumes. The real contracts live in each host's coding-agent package
 * (oh-my-pi extensibility/extensions/types.ts; earendil-works/pi
 * core/extensions/types.d.ts); this dir carries no node_modules, so these are
 * the compile-time shadows. Runtime host differences are shimmed in index.ts.
 */

/** Structural subset of TUI. */
export interface TuiLike {
	requestRender(): void;
	readonly terminal?: { readonly rows: number; readonly columns: number };
}

/** Structural subset of Theme: the colorized text helper pets consume. */
export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** Structural component contract returned to ui.custom(). */
export interface PaneComponent {
	render(width: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export interface PettyUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Focused overlay component (settings preview) — resolves when it calls done(). */
	custom<T>(
		factory: (
			tui: TuiLike,
			theme: ThemeLike,
			keybindings: unknown,
			done: (result: T) => void,
		) => PaneComponent | Promise<PaneComponent>,
		options?: {
			overlay?: boolean;
			overlayOptions?: {
				width?: number | `${number}%`;
				maxHeight?: number | `${number}%`;
				margin?: number;
				fullscreen?: boolean;
				mouseTracking?: boolean;
			};
			signal?: AbortSignal;
		},
	): Promise<T>;
	/** TUI-only public APIs. Optional for headless hosts and older hosts. */
	setWidget?(
		key: string,
		content: ((tui: TuiLike, theme: ThemeLike) => {
			render(width: number): readonly string[];
			invalidate(): void;
			dispose?(): void;
		}) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput?(handler: (data: string) => undefined): () => void;
}

export interface PettyContext {
	ui: PettyUI;
	hasUI: boolean;
	/** hasUI also covers RPC; only TUI mounts component factories. */
	mode?: "tui" | "rpc" | "json" | "print";
}

export type PettyCommandContext = PettyContext;

export interface PettyExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: PettyContext) => void | Promise<void>): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: PettyCommandContext) => Promise<void>;
		},
	): void;
}
