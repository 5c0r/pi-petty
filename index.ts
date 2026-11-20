/**
 * pi-petty — the standalone desk pet for pi coding agents (oh-my-pi and
 * earendil-works/pi). Split from pi-fireside-chat; the chat side now
 * integrates only through the public `fireside:companion:v1` event channel:
 *   - a Fireside chat pane publishes a pane lease while it owns the focused
 *     overlay: Petty draws the existing pet strip rows and observes typing
 *     the pane has already handled. Petty never receives raw pane input and
 *     suspends its own main terminal observer while the pane is open.
 *   - a Fireside reply publishes a reply lease: Petty feeds visible
 *     text_delta strings into the same engine as main-session deltas.
 * Both hosts invoke bus handlers synchronously; this handler never awaits
 * and contains every optional-peer fault (attach, redraw) itself.
 *
 * Surface: `/petty` opens the pet preview/settings overlay — ten builtin
 * pets, custom sprites, three random actions, Save/Cancel with exact preview
 * rollback. Settings persist at `<agentDir>/fireside-pet.json`: the same
 * schema and path the combined Fireside extension used, resolved lazily.
 * No model calls, prompts, or transcript changes.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { PetController } from "./pet-host";
import type { PettyContext, PettyExtensionAPI } from "./api";

/** Public cross-extension channel shared with pi-fireside-chat. */
const COMPANION_CHANNEL = "fireside:companion:v1";

/** Type guard: message event carrying an assistant-role AgentMessage. */
function isAssistantMessage(event: unknown): event is { message: { role: "assistant" } } {
	if (!event || typeof event !== "object") return false;
	const message = (event as Record<string, unknown>).message;
	return (
		!!message &&
		typeof message === "object" &&
		(message as Record<string, unknown>).role === "assistant"
	);
}

/** Narrow the public MessageUpdateEvent.assistantMessageEvent delta payload once. */
function isTextDeltaEvent(
	event: unknown,
): event is { assistantMessageEvent: { type: "text_delta"; delta: string } } {
	if (!event || typeof event !== "object") return false;
	const payload = (event as Record<string, unknown>).assistantMessageEvent;
	if (!payload || typeof payload !== "object") return false;
	const assistant = payload as Record<string, unknown>;
	return assistant.type === "text_delta" && typeof assistant.delta === "string";
}

/** Local structural shapes of the companion channel wire messages. */
interface CompanionTheme {
	fg(key: string, text: string): string;
}
interface PaneLease {
	render(width: number, maxRows: number, theme: CompanionTheme): readonly string[];
	typing(): void;
	dispose(): void;
}
interface ReplyLease {
	write(delta: string): void;
	dispose(): void;
}
interface CompanionPaneMessage {
	kind: "pane";
	requestRender: () => void;
	attach: (lease: PaneLease) => void;
}
interface CompanionReplyMessage {
	kind: "reply";
	attach: (lease: ReplyLease) => void;
}

export default function pettyExtension(pi: PettyExtensionAPI): void {
	const pets = new PetController(() => getAgentDir());
	/** Live companion leases; at most one pane and one reply owner at a time. */
	let paneLease: { disposed: boolean; unsubscribe: () => void } | undefined;
	let replyLease: { disposed: boolean } | undefined;
	let busListener: (() => void) | undefined;

	function teardownReply(state: { disposed: boolean }): void {
		if (state.disposed) return;
		state.disposed = true;
		if (replyLease === state) {
			replyLease = undefined;
			// The owner closed its reply boundary: drop its parser state too.
			pets.resetFeed("fireside");
		}
	}

	function teardownPane(state: { disposed: boolean; unsubscribe: () => void }): void {
		if (state.disposed) return;
		state.disposed = true;
		state.unsubscribe();
		if (paneLease === state) {
			paneLease = undefined;
			pets.releaseMainInput();
		}
	}

	/** Synchronous companion handler — no promises cross this seam. */
	function onCompanion(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const companion = message as Record<string, unknown>;
		if (
			companion.kind === "pane" &&
			typeof companion.requestRender === "function" &&
			typeof companion.attach === "function"
		) {
			const pane = companion as unknown as CompanionPaneMessage;
			if (paneLease) teardownPane(paneLease);
			const state = { disposed: false, unsubscribe: () => { } };
			// The pane owns focused input while open: typing arrives only via
			// the lease, and the main terminal observer stays suspended.
			pets.holdMainInput();
			state.unsubscribe = pets.subscribe(() => {
				if (state.disposed || paneLease !== state) return;
				try {
					pane.requestRender();
				} catch {
					// An optional peer's redraw fault must never break pets or teardown.
				}
			});
			const lease: PaneLease = {
				render: (width, maxRows, theme) =>
					state.disposed || paneLease !== state ? [] : pets.renderFireside(width, maxRows, theme),
				typing: () => {
					if (!state.disposed && paneLease === state) pets.activity("typing");
				},
				dispose: () => teardownPane(state),
			};
			paneLease = state;
			try {
				pane.attach(lease);
			} catch {
				// The peer never received the lease: release everything it would own.
				teardownPane(state);
			}
			return;
		}
		if (companion.kind === "reply" && typeof companion.attach === "function") {
			const reply = companion as unknown as CompanionReplyMessage;
			if (replyLease) teardownReply(replyLease);
			const state = { disposed: false };
			const lease: ReplyLease = {
				write: delta => {
					// A stale or replaced lease can never feed a later reply.
					if (state.disposed || replyLease !== state) return;
					pets.activity("reply");
					// The synchronous redraw may have transitioned the session.
					if (state.disposed || replyLease !== state) return;
					pets.feedDelta(delta, "fireside");
				},
				dispose: () => teardownReply(state),
			};
			replyLease = state;
			try {
				reply.attach(lease);
			} catch {
				// Clear exactly this token and its parser; pets keep running.
				teardownReply(state);
			}
		}
	}

	/** The companion listener lives only while a Petty engine can act on it. */
	const syncBusListener = (ctx: PettyContext): void => {
		const live =
			pets.active && ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.setWidget === "function";
		if (live && !busListener && typeof pi.events?.on === "function") {
			try {
				busListener = pi.events.on(COMPANION_CHANNEL, onCompanion);
			} catch {
				// An optional peer seam must never break the pet itself.
				busListener = undefined;
			}
		} else if (!live && busListener) {
			busListener();
			busListener = undefined;
		}
	};

	/** Session transitions rebuild the pet world. Pane redraw rebinds; old
	 * replies and their parsers die at the boundary. */
	const transitionSession = (ctx: PettyContext): void => {
		if (replyLease) teardownReply(replyLease);
		pets.reset(ctx);
		syncBusListener(ctx);
	};

	// omp: session_start/session_switch/session_branch/session_tree/session_clear.
	// pi: session_start/session_tree (others never fire; unknown names are inert).
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree", "session_clear"]) {
		try {
			pi.on(event, (_event, ctx) => transitionSession(ctx));
		} catch {
			// Host rejects unknown event names — pets stay reachable via /petty.
		}
	}
	try {
		pi.on("session_shutdown", () => {
			if (replyLease) teardownReply(replyLease);
			if (paneLease) teardownPane(paneLease);
			pets.shutdown();
			busListener?.();
			busListener = undefined;
		});
	} catch {
		// Older hosts reject unknown event names.
	}

	pi.on("message_start", event => {
		if (isAssistantMessage(event)) {
			pets.resetFeed("main");
			pets.activity("reply");
		}
	});
	pi.on("message_update", event => {
		if (isAssistantMessage(event)) {
			pets.activity("reply");
			// Public delta payload: never diff whole assistant messages.
			const delta = isTextDeltaEvent(event) ? event.assistantMessageEvent : undefined;
			if (delta) pets.feedDelta(delta.delta, "main");
		}
	});
	pi.on("message_end", _event => {
		pets.resetFeed("main");
	});

	pi.registerCommand("petty", {
		description: "Customize your local Petty desk pet with a live preview",
		handler: async (_args, ctx) => {
			await pets.configure(ctx, matchesKey, (text, width) => truncateToWidth(text, width, ""));
		},
	});
}
