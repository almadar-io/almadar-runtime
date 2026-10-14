/**
 * The host half of the kernel path: the I/O the kernel asks for, answered with the runtime's own
 * adapters. Persistence goes through the `PersistenceAdapter` (`@almadar/db`), `call-service` through the
 * injected provider (or the mock / integrations default the JS stage uses), substrate operators through
 * the program host. Nothing here decides an execution step.
 */
import {
  EntityRowSchema,
  isJsonObject,
  type EntityRow,
  type EventPayload,
  type JsonValue,
  type PersistenceAdapter,
  type ServiceHostPorts,
  type ServiceParams,
  type UserContext,
} from '@almadar/core';
import { issuePayload } from '../effects/EffectExecutor.js';
import { untilAborted, type InFlightCalls } from '../effects/in-flight-calls.js';
import type { EffectHandlers, ServiceCallContext } from '../types.js';
import type { CallSiteWire, IoAnswerWire, IoRequestWire, Settled, SubstrateFailureWire } from './wire.js';

/** `call-service`, exactly as the JS stage resolves it: the host's handler, mock mode, or the integrations default. */
export type KernelCallService = (
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context: ServiceCallContext | undefined,
) => Promise<EventPayload | null>;

/** A follow-on step's `call-service` outcome, run later as a dispatch of its own on `traitName`. */
export interface DeferredCallOutcome {
  orbital: string;
  traitName: string;
  event: string;
  payload: EventPayload | undefined;
  entityId: string | undefined;
  originClientId: string | undefined;
  user: UserContext | undefined;
  locale: string | undefined;
}

export interface KernelHostPorts {
  persistence: PersistenceAdapter;
  callService: KernelCallService;
  /** The program host, read per call: a host wires it lazily. */
  programEffect: () => EffectHandlers['programEffect'];
  inFlightCalls: InFlightCalls;
  /** The running app lent to one `call-service` provider as the caller. */
  servicePorts: (caller: { orbital: string; trait: string }, user: UserContext | undefined, message: (payload: EventPayload) => void) => ServiceHostPorts;
  /** Deliver one live message of a running call (`emit.onMessage`) to the requesting tab only, never in-band. */
  deliverLive: (site: { orbital: string; trait: string; event: string }, payload: EventPayload, originClientId: string | undefined) => void;
  /** Read per call: the sink a follow-on call's outcome runs through, absent when the host cannot deliver it to the tab. */
  deferCallOutcome: () => ((call: DeferredCallOutcome) => void) | undefined;
}

/** What one dispatch brings to its answers. */
export interface KernelAnswerScope {
  /** The orbital the request is addressed to. */
  orbital: string;
  /** The viewer the dispatch runs as; a substrate operator is called as them. */
  user?: UserContext;
  /** The requesting tab. */
  originClientId?: string;
  locale?: string;
  entityId?: string;
  /** Runs `work` with the host's event queue released (a service call must not hold the next event). */
  outsideEventQueue?: <T>(work: () => Promise<T>) => Promise<T>;
}

function toJson(value: object | string | number | boolean | null): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

function rowOf(value: JsonValue): EntityRow {
  return EntityRowSchema.parse(value);
}

async function settle<T>(work: () => Promise<T>): Promise<Settled<T, string>> {
  try {
    return { ok: await work() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeRow(persistence: PersistenceAdapter, entityType: string, id: string, data: JsonValue): Promise<JsonValue> {
  const incoming = rowOf(data);
  const existing = await persistence.getById(entityType, id);
  if (existing === null) await persistence.create(entityType, { ...incoming, id });
  else await persistence.update(entityType, id, { ...incoming, id });
  return toJson((await persistence.getById(entityType, id)) ?? { ...existing, ...incoming, id });
}

function serviceParams(args: JsonValue): ServiceParams | undefined {
  if (args === null) return undefined;
  if (!isJsonObject(args)) throw new Error('call-service: the arguments are not an object');
  return args;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callService(
  ports: KernelHostPorts,
  request: Extract<IoRequestWire, { kind: 'callService' }>,
  scope: KernelAnswerScope,
): Promise<IoAnswerWire> {
  const { service, method, args, key, caller, site } = request;
  const identity = caller !== undefined ? { principal: caller.principal, ...(caller.role !== undefined ? { role: caller.role } : {}) } : {};
  const orbital = site?.orbital ?? scope.orbital;
  const onMessage = site?.emit.onMessage;
  const message = (payload: EventPayload): void => {
    if (site === undefined || onMessage === undefined) return;
    ports.deliverLive({ orbital, trait: site.trait, event: onMessage }, payload, scope.originClientId);
  };
  const host = site !== undefined ? ports.servicePorts({ orbital, trait: site.trait }, scope.user, message) : undefined;
  const call = async (signal?: AbortSignal, outsideRequest?: true): Promise<JsonValue> => {
    const context: ServiceCallContext | undefined =
      caller !== undefined || signal !== undefined || host !== undefined || outsideRequest !== undefined
        ? { ...identity, ...(host !== undefined ? { host } : {}), ...(signal !== undefined ? { signal } : {}), ...(outsideRequest !== undefined ? { outsideRequest } : {}) }
        : undefined;
    const result = await ports.callService(service, method, serviceParams(args), context);
    return result === null ? null : toJson(result);
  };
  const deferred = site?.followOn === true ? ports.deferCallOutcome() : undefined;
  if (site !== undefined && deferred !== undefined) {
    startDeferredCall(deferred, site, key, call, { ports, orbital, scope });
    return { kind: 'serviceDeferred' };
  }
  const run = async (): Promise<IoAnswerWire> => {
    if (key === undefined) return { kind: 'service', result: { ok: await call() } };
    const outcome = await ports.inFlightCalls.run(key, (signal) => untilAborted(signal, call(signal)));
    return outcome.cancelled ? { kind: 'serviceCancelled' } : { kind: 'service', result: { ok: outcome.value } };
  };
  try {
    return await (scope.outsideEventQueue !== undefined ? scope.outsideEventQueue(run) : run());
  } catch (error) {
    return { kind: 'service', result: { error: failureMessage(error) } };
  }
}

/** A follow-on step's call: started, not awaited; its outcome event goes to the host as a dispatch of its own. */
function startDeferredCall(
  defer: (call: DeferredCallOutcome) => void,
  site: CallSiteWire,
  key: string | undefined,
  call: (signal?: AbortSignal, outsideRequest?: true) => Promise<JsonValue>,
  context: { ports: KernelHostPorts; orbital: string; scope: KernelAnswerScope },
): void {
  const { ports, orbital, scope } = context;
  const deliver = (event: string, payload: EventPayload | undefined): void =>
    defer({
      orbital,
      traitName: site.trait,
      event,
      payload,
      entityId: scope.entityId,
      originClientId: scope.originClientId,
      user: scope.user,
      locale: scope.locale,
    });
  const outcome = key === undefined
    ? call(undefined, true).then((value) => ({ cancelled: false as const, value }))
    : ports.inFlightCalls.run(key, (signal) => untilAborted(signal, call(signal, true)));
  void outcome.then(
    (settled) => {
      if (settled.cancelled) {
        if (site.emit.cancelled !== undefined && key !== undefined) deliver(site.emit.cancelled, { key });
      } else if (site.emit.success !== undefined) {
        deliver(site.emit.success, settled.value === null ? undefined : toEventPayload(settled.value));
      }
    },
    (error: unknown) => {
      if (site.emit.failure !== undefined) deliver(site.emit.failure, { error: failureMessage(error) });
    },
  );
}

function toEventPayload(value: JsonValue): EventPayload | undefined {
  return isJsonObject(value) ? value : undefined;
}

async function substrate(
  ports: KernelHostPorts,
  request: Extract<IoRequestWire, { kind: 'substrate' }>,
  scope: KernelAnswerScope,
): Promise<IoAnswerWire> {
  const handler = ports.programEffect();
  const failure = (message: string, errors: JsonValue[] = []): IoAnswerWire => {
    const detail: SubstrateFailureWire = { message, errors };
    return { kind: 'substrate', result: { error: detail } };
  };
  if (handler === undefined) return failure(`no program host configured for ${request.op}`);
  const { isProgramEffect } = await import('@almadar/integrations/program');
  if (!isProgramEffect(request.op)) return failure(`no program host configured for ${request.op}`);
  try {
    const user = scope.user;
    const outcome = await handler(request.op, request.args, user !== undefined ? { principal: user.id, ...(user.role !== undefined ? { role: user.role } : {}) } : undefined);
    if (outcome.ok) return { kind: 'substrate', result: { ok: toJson(outcome.result) } };
    return failure(outcome.error, (outcome.errors ?? []).map((issue) => toJson(issuePayload(issue))));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Answer one request of the kernel; a thrown adapter error becomes the request's declared failure. */
export async function answerRequest(ports: KernelHostPorts, request: IoRequestWire, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const { persistence } = ports;
  switch (request.kind) {
    case 'readRow':
      return {
        kind: 'row',
        result: await settle(async () => {
          const row = await persistence.getById(request.entityType, request.id);
          return row === null ? null : toJson(row);
        }),
      };
    case 'listRows':
      return {
        kind: 'rows',
        result: await settle(async () => (await persistence.list(request.entityType)).map(toJson)),
      };
    case 'createRow':
      return {
        kind: 'row',
        result: await settle(async () => {
          const data = rowOf(request.data);
          const { id } = await persistence.create(request.entityType, data);
          return toJson((await persistence.getById(request.entityType, id)) ?? { ...data, id });
        }),
      };
    case 'writeRow':
      return { kind: 'row', result: await settle(() => writeRow(persistence, request.entityType, request.id, request.data)) };
    case 'deleteRow':
      return {
        kind: 'deleted',
        result: await settle(async () => {
          await persistence.delete(request.entityType, request.id);
          return null;
        }),
      };
    case 'callService':
      return callService(ports, request, scope);
    case 'cancelCall':
      ports.inFlightCalls.cancel(request.key);
      return { kind: 'cancelled', result: { ok: null } };
    case 'substrate':
      return substrate(ports, request, scope);
  }
}
