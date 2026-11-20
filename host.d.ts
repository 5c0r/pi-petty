/**
 * Ambient declarations for host-resolved modules.
 *
 * Entry imports the "@earendil-works/*" scope: earendil-works/pi resolves it
 * natively; oh-my-pi (omp) remaps it to its bundled in-process copies
 * (legacy-pi-compat PI_SCOPE_ALIASES includes "earendil-works" — verified
 * live). This dir intentionally carries no node_modules, so tsc needs these
 * minimal shapes. Sources:
 *   - earendil-works/pi packages/tui (matchesKey, truncateToWidth),
 *     packages/coding-agent barrel (getAgentDir)
 *   - omp equivalents (same positional contracts)
 */

declare module "@earendil-works/pi-tui" {
	export function matchesKey(data: string, key: string): boolean;
	export function truncateToWidth(text: string, width: number, ellipsis?: string, pad?: boolean): string;
}

declare module "@earendil-works/pi-coding-agent" {
	export function getAgentDir(): string;
}

/** Narrow Node filesystem surface shared by both host runtimes. */
declare module "node:fs" {
	export const constants: { O_RDONLY: number; O_NONBLOCK: number };
	export function openSync(path: string, flags: number): number;
	export function closeSync(fd: number): void;
	export function fstatSync(fd: number): { size: number; isFile(): boolean };
	export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function mkdirSync(path: string, options: { recursive: true; mode?: number }): string | undefined;
	export function mkdtempSync(prefix: string): string;
	export function writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode?: number }): void;
	export function renameSync(from: string, to: string): void;
	export function rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
}
declare module "node:path" {
	export function join(...paths: string[]): string;
}

declare var process: { stdout: { rows?: number; columns?: number } };
