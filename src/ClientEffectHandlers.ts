/**
 * Client Effect Handlers Factory
 *
 * Creates the standard effect handler set for client-side trait execution.
 * Platform-agnostic — works with any UI framework that provides the required interfaces.
 *
 * @packageDocumentation
 */

import { createLogger } from '@almadar/logger';
import type { PatternConfig, BusEventSource, FieldValue } from '@almadar/core';
import type { EffectHandlers, EventPayload, EntityRow, ServiceParams, PatternProps, BrowserFilePickerOptions, BrowserGeolocationOptions } from './types.js';

const log = createLogger('almadar:runtime:effects:client');

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal event bus interface required by the factory.
 */
export interface ClientEventBus {
    /** `source` is `EffectExecutor.sourceStamp()` ({orbital, trait, transition,
     * …ids}) — forwarded so the bus can tell a machine-originated emit (bare
     * key by design, delivered via manager/bare-cascade) from a component
     * emit missing its TraitScopeProvider. */
    emit: (type: string, payload?: EventPayload, source?: BusEventSource) => void;
}

/**
 * Slot setter interface for render-ui effects.
 * The factory doesn't know about React state — it just calls this function.
 */
export interface SlotSetter {
    /** Accumulate a pattern into the pending slot map */
    addPattern: (slot: string, pattern: PatternConfig | null, props?: PatternProps) => void;
    /** Mark a slot for clearing */
    clearSlot: (slot: string) => void;
}

/**
 * Options for creating client effect handlers.
 */
export interface CreateClientEffectHandlersOptions {
    /** Event bus for emit effects */
    eventBus: ClientEventBus;
    /** Slot setter for render-ui effects */
    slotSetter: SlotSetter;
    /** Navigate function for navigate effects. `crumb` labels the target
     * page's navigation-stack entry (from the effect's `{ crumb: … }`
     * options). */
    navigate?: (path: string, params?: { [key: string]: string }, crumb?: string) => void;
    /** Navigate-back function: pop the orbital-scoped navigation stack. */
    navigateBack?: () => void;
    /**
     * Live client-entity write target for `[runtime]` entities. `(set
     * @entity.<field> value)` runs entirely in the browser for in-memory
     * entities (game boards, wizards): there is no server row to persist to,
     * so the canonical client `set` must mutate THIS object — the same object
     * `EffectExecutor` reads `@entity.*` from for the current `executeAll` and
     * the next tick seeds from. When omitted, `set` is a no-op (bridge mode:
     * the server owns persistence). One store, read live by render-ui, guards,
     * and ticks — no guard-vs-render split.
     */
    liveEntity?: EntityRow;
    /**
     * Bridge mode — no local persistence adapter is wired, so the SERVER
     * executes every persist and returns its outcome. Sets
     * `EffectHandlers.persistDelegated` so the executor skips the placeholder
     * `persist` below instead of reading its `undefined` as a denial
     * (an error in every browser console + a client-side `failure` emit
     * while the server had succeeded). The hook decides this from whether a
     * `persistence` adapter was supplied — `liveEntity` says nothing about
     * it (the hook always binds one for `(set @entity.X)`).
     */
    persistDelegated?: boolean;
    /** Same bridge-mode delegation as `persistDelegated`, for `(call-service …)`: set when no consumer `callService` is wired, so the executor skips the mock fallback below and the server's cascade carries the result. */
    callServiceDelegated?: boolean;
    /**
     * Optional consumer-supplied call-service handler. When set, it runs
     * instead of the default mock fallback — use to wire the playground
     * to real backends. When omitted, `callService` returns a synthetic
     * mock result so service-atom chains advance end-to-end in offline /
     * standalone-preview mode (see OrbitalServerRuntime's mock parallel).
     */
    callService?: (
        service: string,
        action: string,
        params?: ServiceParams
    ) => Promise<EventPayload>;
    /**
     * Send-server handler for `send-server` effects.
     * When omitted, defaults to a lazy WebSocket transport connecting to the
     * server's `/ws/events` endpoint. The handler produces the server wire
     * message `{ type: 'ORBITAL_EVENT', payload: { orbital, event, payload } }`
     * that `setupEventBroadcast` decodes.
     *
     * Pass a custom function here to override the transport (e.g. in tests or
     * when the WS URL differs from the default).
     *
     * `orbitalName` is injected at call time by the EffectContext when available.
     */
    sendServer?: (event: string, payload?: EventPayload) => void;
    /** Orbital name used to stamp the WS message (used by the default transport) */
    orbitalName?: string;
}

// ============================================================================
// Factory
// ============================================================================

// ============================================================================
// WS Transport (lazy singleton per page-load)
// ============================================================================

/** Lazily-opened WebSocket to the server's /ws/events endpoint. */
let _ws: WebSocket | null = null;
let _wsQueue: string[] = [];

function getOrOpenWs(): WebSocket | null {
    if (typeof WebSocket === 'undefined' || typeof location === 'undefined') return null;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
        return _ws;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/events`;
    try {
        _ws = new WebSocket(url);
        _ws.addEventListener('open', () => {
            const queued = _wsQueue.splice(0);
            for (const msg of queued) {
                _ws!.send(msg);
            }
        });
        _ws.addEventListener('error', () => {
            _ws = null;
        });
        _ws.addEventListener('close', () => {
            _ws = null;
        });
    } catch {
        _ws = null;
    }
    return _ws;
}

/** PushManager.subscribe wants the VAPID public key as raw bytes, not base64url. */
function urlBase64ToArrayBuffer(base64Url: string): ArrayBuffer {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const buffer = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++) {
        view[i] = raw.charCodeAt(i);
    }
    return buffer;
}

function sendServerEvent(orbital: string, event: string, payload?: EventPayload): void {
    const msg = JSON.stringify({
        type: 'ORBITAL_EVENT',
        payload: { orbital, event, payload: payload ?? null },
    });
    const ws = getOrOpenWs();
    if (!ws) {
        log.warn('send-server:no-ws', { event });
        return;
    }
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
    } else {
        _wsQueue.push(msg);
    }
}

/**
 * Create client-side effect handlers for trait state machine execution.
 *
 * Client handles: emit, renderUI, navigate, sendServer, set (when a
 * `liveEntity` is wired), callService (mock fallback or consumer-supplied).
 * Bridge mode (no `liveEntity` / no consumer `callService`): `persist`/`set`
 * are no-ops and `persistDelegated`/`callServiceDelegated` tell the executor
 * the SERVER already carried the write, so it never reads the local no-op as
 * a denial.
 *
 * @example
 * ```ts
 * const handlers = createClientEffectHandlers({
 *   eventBus,
 *   slotSetter: {
 *     addPattern: (slot, pattern, props) => pendingSlots.get(slot)?.push({ pattern, props }),
 *     clearSlot: (slot) => pendingSlots.set(slot, []),
 *   },
 *   navigate: (path) => router.push(path),
 * });
 * ```
 */
export function createClientEffectHandlers(
    options: CreateClientEffectHandlersOptions
): EffectHandlers {
    const {
        eventBus, slotSetter, navigate, navigateBack, sendServer, orbitalName = '',
        callService: consumerCallService, liveEntity, persistDelegated, callServiceDelegated,
    } = options;

    return {
        emit: (event: string, payload?: EventPayload, source?: BusEventSource) => {
            // The event bus wraps its second arg AS the event's `payload`
            // field (see IEventBus contract). Double-wrapping as `{ payload }`
            // here made subscribers see `event.payload = { payload: realPayload }`,
            // and `@payload.X` binding resolution failed (one level too deep).
            // Pass the caller's payload through directly.
            const prefixedEvent = event.startsWith('UI:') ? event : `UI:${event}`;
            eventBus.emit(prefixedEvent, payload, source);
        },

        persist: async () => {
            log.debug('persist is server-side only, ignored on client');
            return undefined;
        },
        // Bridge mode: the server runs every persist and the response
        // carries its outcome — tell the executor so the placeholder above is
        // never read as a denial (see `EffectHandlers.persistDelegated`).
        ...(persistDelegated === true ? { persistDelegated: true as const } : {}),
        ...(callServiceDelegated === true ? { callServiceDelegated: true as const } : {}),

        // `[runtime]` entities live only in the browser — `(set @entity.X)`
        // must land in the live client store so the same `executeAll`'s
        // render-ui, the next tick, and guards all read the advanced value.
        // Without a `liveEntity` we are in bridge mode (server persists),
        // so the write is a no-op here.
        set: (_entityId: string, field: string, value: FieldValue) => {
            if (!liveEntity) {
                log.warn('set is server-side only, ignored on client (no live entity)');
                return;
            }
            liveEntity[field] = value;
        },

        callService: async (service: string, action: string, params?: ServiceParams) => {
            // Consumer-supplied handler wins — playgrounds wire real backends here.
            if (consumerCallService) return consumerCallService(service, action, params);
            // Mock fallback: return a synthetic result that satisfies common
            // service-atom emit shapes (id, clientSecret, success, status,
            // params-echo). Mirrors OrbitalServerRuntime's mock-mode default
            // so client-side state machines (offline preview, runtime-verify
            // standalone) advance instead of stalling at null payloads. The
            // server-side parallel exists for bridge mode where the SERVER
            // processes call-service; this branch is the same intent for
            // browser-only execution.
            const mockId = `mock_${service}_${action}_${Math.random().toString(36).slice(2, 10)}`;
            const paramsEcho: Partial<EntityRow> = {};
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null || v instanceof Date)) {
                        paramsEcho[k] = v;
                    }
                }
            }
            return {
                id: mockId,
                clientSecret: `secret_${mockId}`,
                success: true,
                status: 'succeeded',
                ...paramsEcho,
            };
        },

        renderUI: (slot: string, pattern: PatternConfig | null, props?: PatternProps) => {
            if (pattern === null) {
                slotSetter.clearSlot(slot);
                return;
            }
            slotSetter.addPattern(slot, pattern, props);
        },

        navigate: navigate ?? ((path: string) => {
            if (typeof window !== 'undefined' && /^https?:\/\//.test(path)) {
                window.location.href = path;
                return;
            }
            log.warn('navigate-no-handler', { path });
        }),

        navigateBack: navigateBack ?? (() => {
            log.warn('navigate-back-no-handler');
        }),

        sendServer: sendServer ?? ((event: string, payload?: EventPayload) => {
            sendServerEvent(orbitalName, event, payload);
        }),

        // === Browser device handlers (client host path) ===
        // Each throws when the underlying API is unavailable so the executor's
        // runSubstrate wrapper fires `emit.failure` with `{ error }`.

        browserOpenFilePicker: async (options?: BrowserFilePickerOptions) => {
            // The File System Access API is newer than the DOM lib this package
            // is pinned to, so `window.showOpenFilePicker` is not on `Window`.
            // Type the host surface structurally and narrow through a single
            // `Window & { ... }` intersection (overlaps `Window` → no `unknown`
            // / `any` double-cast).
            type FilePickerFn = (pickerOptions?: {
                multiple?: boolean;
                types?: Array<{ accept: Record<string, string[]> }>;
            }) => Promise<Array<{ getFile: () => Promise<File> }>>;
            if (typeof window === 'undefined' || !('showOpenFilePicker' in window)) {
                throw new Error('File picker API is not available in this environment');
            }
            const host = window as Window & { showOpenFilePicker: FilePickerFn };
            const pickerOptions: { multiple?: boolean; types?: Array<{ accept: Record<string, string[]> }> } = {};
            if (options?.multiple === true) pickerOptions.multiple = true;
            if (typeof options?.accept === 'string' && options.accept.length > 0) {
                pickerOptions.types = [{ accept: { [options.accept]: [] } }];
            }
            const handles = await host.showOpenFilePicker(pickerOptions);
            const files = await Promise.all(handles.map(async (handle) => {
                const file = await handle.getFile();
                return { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
            }));
            return { files };
        },

        browserClipboardRead: async () => {
            if (typeof navigator === 'undefined' || !navigator.clipboard) {
                throw new Error('Clipboard API is not available in this environment');
            }
            const text = await navigator.clipboard.readText();
            return { text };
        },

        browserClipboardWrite: async (text: string) => {
            if (typeof navigator === 'undefined' || !navigator.clipboard) {
                throw new Error('Clipboard API is not available in this environment');
            }
            await navigator.clipboard.writeText(text);
            return { text };
        },

        browserPushSubscribe: async () => {
            if (
                typeof navigator === 'undefined' || !('serviceWorker' in navigator) ||
                typeof window === 'undefined' || !('PushManager' in window)
            ) {
                throw new Error('Push API is not available in this environment');
            }
            const keyResponse = await fetch('/api/push/vapid-public-key');
            if (!keyResponse.ok) {
                throw new Error('Push is not configured on this host (no VAPID public key)');
            }
            const { publicKey } = await keyResponse.json() as { publicKey: string };
            const registration = await navigator.serviceWorker.register('/almadar-push-sw.js');
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToArrayBuffer(publicKey),
            });
            const json = subscription.toJSON();
            const endpoint = json.endpoint ?? '';
            const p256dh = json.keys?.p256dh ?? '';
            const auth = json.keys?.auth ?? '';
            if (!endpoint || !p256dh || !auth) {
                throw new Error('Push subscription resolved without endpoint/keys');
            }
            return { endpoint, p256dh, auth };
        },

        browserGeolocationCurrent: async (options?: BrowserGeolocationOptions) => {
            if (typeof navigator === 'undefined' || !navigator.geolocation) {
                throw new Error('Geolocation API is not available in this environment');
            }
            const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, options);
            });
            return {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
            };
        },
    };
}
