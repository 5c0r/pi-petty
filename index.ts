/**
 * pi-petty — the standalone desk pet for pi coding agents (oh-my-pi and
 * earendil-works/pi).
 *
 * Surface: `/petty` opens the pet preview/settings overlay — ten builtin
 * pets, custom sprites, three random actions, Save/Cancel with exact preview
 * rollback. Settings persist at `<agentDir>/fireside-pet.json`, resolved
 * lazily. No model calls, prompts, or transcript changes, and no other
 * extension surface: Petty subscribes to nothing it does not own.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { PetController } from "./pet-host";
import type { PettyExtensionAPI } from "./api";

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

export default function pettyExtension(pi: PettyExtensionAPI): void {
	const pets = new PetController(() => getAgentDir());

	// Session transitions rebuild the pet world. omp:
	// session_start/session_switch/session_branch/session_tree/session_clear.
	// pi: session_start/session_tree (others never fire; unknown names are inert).
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree", "session_clear"]) {
		try {
			pi.on(event, (_event, ctx) => pets.reset(ctx));
		} catch {
			// Host rejects unknown event names — pets stay reachable via /petty.
		}
	}
	try {
		pi.on("session_shutdown", () => pets.shutdown());
	} catch {
		// Older hosts reject unknown event names.
	}

	pi.on("message_start", event => {
		if (isAssistantMessage(event)) {
			pets.resetFeed();
			pets.activity("reply");
		}
	});
	pi.on("message_update", event => {
		if (isAssistantMessage(event)) {
			pets.activity("reply");
			// Public delta payload: never diff whole assistant messages.
			const delta = isTextDeltaEvent(event) ? event.assistantMessageEvent : undefined;
			if (delta) pets.feedDelta(delta.delta);
		}
	});
	pi.on("message_end", _event => {
		pets.resetFeed();
	});

	pi.registerCommand("petty", {
		description: "Customize your local Petty desk pet with a live preview",
		handler: async (_args, ctx) => {
			await pets.configure(ctx, matchesKey, (text, width) => truncateToWidth(text, width, ""));
		},
	});
}
