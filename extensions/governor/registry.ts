/**
 * The registry packages and guard hosts meet through, on `globalThis` under `Symbol.for` keys.
 *
 * pi loads every extension file in its own module scope, so two packages cannot share a module
 * variable. Same idea as pi-chassis's widget registry: a package that loads before the host
 * queues its registration, and the host takes the queue over, so load order does not matter.
 *
 * Unlike a widget registry, this one is a shared rule store with any number of hosts reading it.
 * A subagent child can run in the same process as its parent and load its own copy of the host;
 * every host sees the same registered rules, and the store lives until the last host is gone.
 * Registrations belong to a package (`owner`), not to a host.
 *
 * A client registers only with a store whose `apiVersion` equals its own. A different version is
 * not assumed to understand it: the registration stays queued and the package's `whenNoHost`
 * choice applies, which is blocking or its own handler, never silence.
 */

import type { Rule } from "./rules.ts";

/** Bumped on any change to `Registration` or `Registry` that an older client could not use. */
export const API_VERSION = 1;
export const REGISTRY = Symbol.for("pi-governor/registry");
export const PENDING = Symbol.for("pi-governor/pending");

/** The validated, frozen rules one package registered. */
export interface HostPack {
	readonly id: string;
	readonly rules: readonly Rule[];
}

export interface Registration {
	readonly apiVersion: number;
	readonly pack: HostPack;
	/** Identifies the registering package instance (its `pi` object), so one package can replace its own rules and nobody else's. */
	readonly owner: object;
	/** The store holds the rules. `remove` takes them out again. */
	accepted(remove: () => void): void;
	/** The last host went away; the package's `whenNoHost` choice applies again. */
	revoked(): void;
}

interface Entry {
	registration: Registration;
}

export interface Registry {
	apiVersion?: number;
	/** The live hosts (ids). The store exists while there is at least one. */
	hosts?: Set<string>;
	entries?: Entry[];
	/** Sessions (by their session manager) whose `tool_call` handlers include a host. */
	covered?: WeakSet<object>;
	/** Takes a registration. Throws if it cannot, in which case nothing was accepted. */
	register?(registration: Registration): void;
}

type Globals = Record<symbol, unknown>;
const globals = globalThis as unknown as Globals;

function registryObject(): Registry {
	const existing = globals[REGISTRY];
	if (typeof existing === "object" && existing !== null) return existing as Registry;
	const created: Registry = {};
	globals[REGISTRY] = created;
	return created;
}

/** The store's `register`, if a store with this client's API version is live. */
export function findHost(): Required<Pick<Registry, "register">> | undefined {
	const registry = globals[REGISTRY] as Registry | undefined;
	if (!registry || registry.apiVersion !== API_VERSION || typeof registry.register !== "function") return undefined;
	return { register: registry.register.bind(registry) };
}

function pendingList(): Registration[] {
	const existing = globals[PENDING];
	if (Array.isArray(existing)) return existing as Registration[];
	const created: Registration[] = [];
	globals[PENDING] = created;
	return created;
}

const sameOwner = (a: Registration, b: Registration): boolean => a.owner === b.owner && a.pack.id === b.pack.id;

/** Queue a registration for a host that has not loaded. The same owner and id replaces its earlier entry. Returns a remover. */
export function queuePending(registration: Registration): () => void {
	const list = pendingList();
	const same = list.findIndex((r) => r.apiVersion === registration.apiVersion && sameOwner(r, registration));
	if (same >= 0) list.splice(same, 1);
	list.push(registration);
	return () => {
		const at = list.indexOf(registration);
		if (at >= 0) list.splice(at, 1);
	};
}

function addToStore(registry: Registry, registration: Registration): void {
	if (registration.apiVersion !== API_VERSION) throw new Error(`unsupported pi-governor API version ${String(registration.apiVersion)}`);
	if (!registry.entries || !registry.hosts?.size) throw new Error("no pi-governor host is loaded");
	const entries = registry.entries;
	// A package registering again replaces its own earlier rules. A package with the same id but a
	// different owner is kept alongside: nobody can replace, and so loosen, another package's rules.
	const old = entries.findIndex((e) => sameOwner(e.registration, registration));
	if (old >= 0) entries.splice(old, 1);
	const entry: Entry = { registration };
	entries.push(entry);
	registration.accepted(() => {
		const at = entries.indexOf(entry);
		if (at >= 0) entries.splice(at, 1);
	});
}

/**
 * Record that a host's `tool_call` handler is installed in the session behind `key` (its session
 * manager). A store can be shared by several sessions in one process, such as a subagent child
 * that runs inside its parent's process; only a session that has a host handler of its own is
 * covered, so a package in a session without one still applies its `whenNoHost` choice.
 */
export function markCovered(key: object): void {
	(globals[REGISTRY] as Registry | undefined)?.covered?.add(key);
}

/** Whether a host handler is installed in the session behind `key`. */
export function isCovered(key: object): boolean {
	const registry = globals[REGISTRY] as Registry | undefined;
	return registry?.apiVersion === API_VERSION && registry.covered?.has(key) === true;
}

/** The rule packs now registered, oldest first. Empty when no host is loaded. */
export function livePacks(): readonly HostPack[] {
	const registry = globals[REGISTRY] as Registry | undefined;
	if (!registry || registry.apiVersion !== API_VERSION || !registry.entries) return [];
	return registry.entries.map((e) => e.registration.pack);
}

/** The registrations behind `livePacks()`, for the status command. */
export function liveRegistrations(): readonly Registration[] {
	const registry = globals[REGISTRY] as Registry | undefined;
	if (!registry || registry.apiVersion !== API_VERSION || !registry.entries) return [];
	return registry.entries.map((e) => e.registration);
}

/** How many hosts are live in this process. */
export function hostCount(): number {
	const registry = globals[REGISTRY] as Registry | undefined;
	return registry?.apiVersion === API_VERSION ? (registry.hosts?.size ?? 0) : 0;
}

/**
 * Make `hostId` a live host and take over the registrations queued before any host loaded. The
 * first host creates the store. Throws if a store with another API version is live, so the load
 * fails visibly. Returns the function that removes this host again; when the last host goes, the
 * store is dismantled and every package is told (`revoked`), which puts its `whenNoHost` choice
 * back in force.
 */
export function publishHost(hostId: string): () => void {
	const registry = registryObject();
	if (registry.apiVersion !== undefined && registry.apiVersion !== API_VERSION) {
		throw new Error(`a pi-governor host with API version ${registry.apiVersion} is already loaded; this one speaks ${API_VERSION}`);
	}
	if (registry.apiVersion === undefined) {
		registry.apiVersion = API_VERSION;
		registry.hosts = new Set();
		registry.entries = [];
		registry.covered = new WeakSet();
		registry.register = function (this: Registry, registration) {
			addToStore(this, registration);
		};
	}
	registry.hosts!.add(hostId);
	const list = pendingList();
	for (const registration of [...list]) {
		if (registration.apiVersion !== API_VERSION) continue;
		list.splice(list.indexOf(registration), 1);
		try {
			addToStore(registry, registration);
		} catch {
			// An entry the store cannot take stays out; its package keeps its whenNoHost behaviour.
		}
	}
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		registry.hosts?.delete(hostId);
		if (registry.hosts?.size) return;
		const held = registry.entries ?? [];
		delete registry.entries;
		delete registry.covered;
		delete registry.hosts;
		delete registry.register;
		delete registry.apiVersion;
		for (const { registration } of held) {
			try {
				registration.revoked();
			} catch {
				// a package's callback must not stop the others from being told
			}
		}
	};
}
