/**
 * The host half of the kernel path: the I/O the kernel asks for, answered with the runtime's own
 * adapters. Persistence goes through the `PersistenceAdapter` (`@almadar/db`), `call-service` through the
 * injected provider (or the mock / integrations default the JS stage uses), substrate operators through
 * the program host. Nothing here decides an execution step.
 */
import {
  credentialStatusConnected,
  isAgentPortOperator,
  isJsonObject,
  QueryDeclinedError,
  runAgentPort,
  WriteDeclinedError,
  type EntityRow,
  type EventPayload,
  type HttpStreamEvent,
  type JsonValue,
  type OnDeviceModelPorts,
  type PersistenceAdapter,
  type ServiceHostPorts,
  type ServiceParams,
  type UserContext,
} from '@almadar/core';
import { issuePayload } from '../effects/EffectExecutor.js';
import { untilAborted, type InFlightCalls } from '../effects/in-flight-calls.js';
import type { EffectHandlers, ServiceCallContext } from '../types.js';
import { readPageFacts } from '../effects/page-facts.js';
import { embedOnDevice, OnDeviceModelFailure, promptOnDevice } from '../effects/on-device-model.js';
import { base64Standard, checkOAuthReply, sendBeaconRequest, sendHttp, streamHttp, systemRandom, type CredentialAdminPort, type Exchange, type HttpPorts } from './http-exchange.js';
import type { CallSiteWire, IoAnswerWire, IoRequestWire, Settled, SubstrateFailureWire } from './wire.js';
import type { OsCompletionPort, OsHostPort } from './os-port.js';
import { TabHostFailure, type BrowserTabPort } from './tab-port.js';

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
  /** The `http` effect's ports (kernel builder, secrets, egress); absent, an `http` ask fails as unavailable. */
  http?: HttpPorts;
  /** The on-device model and embedder; absent, a `browser/prompt` or `browser/embed` ask fails `unconfigured`. */
  onDevice?: OnDeviceModelPorts;
  /** The browser's tabs for the `browser/tab-*` effects; absent, a tab ask fails `unavailable`. */
  tabs?: BrowserTabPort;
  /** The `os` effect's host (Node: `createNodeOsHost` from `@almadar/runtime/kernelOsNode`); absent, every `os` ask is denied, as the native host does with none. */
  os?: OsHostPort;
  /** What the kernel decides about a deferred `os` call (which ops defer, the event an outcome fires); absent, every `os` ask is answered in place. */
  osCompletions?: OsCompletionPort;
  /** The host clock in epoch milliseconds, answering the kernel's `clock` ask; absent, the system clock. */
  now?: () => number;
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

async function settle<T>(work: () => Promise<T>): Promise<Settled<T, string>> {
  try {
    return { ok: await work() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
  if (isAgentPortOperator(request.op)) {
    const lent = ports.servicePorts({ orbital: scope.orbital, trait: '' }, scope.user, () => {});
    try {
      const outcome = await runAgentPort(request.op, request.args, lent);
      if (outcome.ok) return { kind: 'substrate', result: { ok: toJson(outcome.result) } };
      return failure(outcome.error, (outcome.errors ?? []).map((issue) => ({ code: issue.code, message: issue.message })));
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
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

const HTTP_UNAVAILABLE = 'HTTP_KERNEL_UNAVAILABLE: this host was given no http ports';

type HttpAsk = Extract<IoRequestWire, { kind: 'http' | 'httpStream' }>;

function httpAnswer(exchange: Exchange): IoAnswerWire {
  return { kind: 'http', result: exchange.kind === 'reply' ? { ok: exchange.response } : { error: exchange.failure } };
}

/** `http` / `httpStream`: the built request sent as asked; keyed, a `cancel-call` aborts it. */
async function http(ports: KernelHostPorts, request: HttpAsk, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const exchangePorts = ports.http;
  if (exchangePorts === undefined) return { kind: 'http', result: { error: { kind: 'failed', message: HTTP_UNAVAILABLE } } };
  const { key, site } = request;
  const orbital = site?.orbital ?? scope.orbital;
  const onMessage = site?.emit.onMessage;
  const onEvent = (event: HttpStreamEvent): void => {
    if (site === undefined || onMessage === undefined) return;
    ports.deliverLive({ orbital, trait: site.trait, event: onMessage }, { ...event }, scope.originClientId);
  };
  const send = (signal?: AbortSignal): Promise<Exchange> =>
    request.kind === 'httpStream'
      ? streamHttp(exchangePorts, request.request, { framing: request.framing, key: key ?? null }, onEvent, signal)
      : sendHttp(exchangePorts, request.request, signal, request.delayMs);
  const run = async (): Promise<IoAnswerWire> => {
    if (key === undefined) return httpAnswer(await send());
    const outcome = await ports.inFlightCalls.run(key, (signal) => untilAborted(signal, send(signal)));
    return outcome.cancelled ? { kind: 'serviceCancelled' } : httpAnswer(outcome.value);
  };
  try {
    return await (scope.outsideEventQueue !== undefined ? scope.outsideEventQueue(run) : run());
  } catch (error) {
    return { kind: 'http', result: { error: { kind: 'failed', message: failureMessage(error) } } };
  }
}

/** `httpBeacon`: the built request taken by the host's beacon port; keyed, a `cancel-call` stops the wait only. */
async function httpBeacon(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'httpBeacon' }>, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const exchangePorts = ports.http;
  if (exchangePorts === undefined) return { kind: 'httpBeacon', result: { ok: { via: 'unavailable', message: HTTP_UNAVAILABLE } } };
  const { key } = request;
  const send = async (signal?: AbortSignal): Promise<IoAnswerWire> => ({ kind: 'httpBeacon', result: await sendBeaconRequest(exchangePorts, request.request, signal) });
  const run = async (): Promise<IoAnswerWire> => {
    if (key === undefined) return send();
    const outcome = await ports.inFlightCalls.run(key, (signal) => untilAborted(signal, send(signal)));
    return outcome.cancelled ? { kind: 'serviceCancelled' } : outcome.value;
  };
  try {
    return await (scope.outsideEventQueue !== undefined ? scope.outsideEventQueue(run) : run());
  } catch (error) {
    return { kind: 'httpBeacon', result: { error: { kind: 'failed', message: failureMessage(error) } } };
  }
}

/** `prompt` / `embed`: the host's on-device model or embedder; keyed, a `cancel-call` aborts the ask and a late reply is dropped. */
async function onDeviceModel(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'prompt' | 'embed' }>, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const { key } = request;
  const ask = async (signal?: AbortSignal): Promise<IoAnswerWire> =>
    request.kind === 'prompt'
      ? { kind: 'prompt', result: { ok: await promptOnDevice(ports.onDevice, request.text, request.schema, key ?? null, signal) } }
      : { kind: 'embed', result: { ok: await embedOnDevice(ports.onDevice, request.texts, key ?? null, signal) } };
  const run = async (): Promise<IoAnswerWire> => {
    if (key === undefined) return ask();
    const outcome = await ports.inFlightCalls.run(key, (signal) => untilAborted(signal, ask(signal)));
    return outcome.cancelled ? { kind: 'serviceCancelled' } : outcome.value;
  };
  try {
    return await (scope.outsideEventQueue !== undefined ? scope.outsideEventQueue(run) : run());
  } catch (error) {
    const failure = error instanceof OnDeviceModelFailure ? { kind: error.kind, message: error.message } : { kind: 'failed' as const, message: failureMessage(error) };
    return request.kind === 'prompt' ? { kind: 'prompt', result: { error: failure } } : { kind: 'embed', result: { error: failure } };
  }
}

const NO_TAB_HOST = 'browser/tab: no host answers browser tabs';

/**
 * `tab`: one raw ask of a `browser/tab-*` effect handed to the host's tab port, which performs it and holds no
 * decision. Keyed, a `cancel-call` aborts the ask and a late reply is dropped. A watch's elements are dispatched to the
 * declared input its ask names, as the user the watch was started by.
 */
async function tab(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'tab' }>, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const { ask, key } = request;
  const port = ports.tabs;
  if (port === undefined) return { kind: 'tab', result: { error: { kind: 'unavailable', message: NO_TAB_HOST } } };
  const deliver = (payload: EventPayload): void => {
    if (ask.kind !== 'watch') return;
    const target = ask.deliver;
    const lent = ports.servicePorts({ orbital: target.orbital, trait: target.trait }, scope.user, () => {});
    void lent.dispatchInput(target.orbital, { targetTrait: target.trait, event: target.event, payload });
  };
  const perform = async (signal?: AbortSignal): Promise<IoAnswerWire> => {
    try {
      return { kind: 'tab', result: { ok: await port.perform(ask, { ...(signal !== undefined ? { signal } : {}), deliver }) } };
    } catch (error) {
      if (error instanceof TabHostFailure) return { kind: 'tab', result: { error: { kind: error.kind, message: error.message } } };
      return { kind: 'tab', result: { error: { kind: 'failed', message: failureMessage(error) } } };
    }
  };
  const run = async (): Promise<IoAnswerWire> => {
    if (key === undefined) return perform();
    const outcome = await ports.inFlightCalls.run(key, (signal) => untilAborted(signal, perform(signal)));
    return outcome.cancelled ? { kind: 'serviceCancelled' } : outcome.value;
  };
  return scope.outsideEventQueue !== undefined ? scope.outsideEventQueue(run) : run();
}

/** `pageFacts`: the requested facts read from the page this host runs in; no window or document is `available: false`. */
async function pageFacts(request: Extract<IoRequestWire, { kind: 'pageFacts' }>): Promise<IoAnswerWire> {
  return { kind: 'pageFacts', result: await settle(async () => readPageFacts(request.fields)) };
}

/**
 * `os`: the raw ask handed to the host's `os` port; the grants and every answer shape are the port's. A keyed ask of a
 * completion-deferring op under a declared route is started and answered `serviceDeferred` when the host can run its
 * outcome as a dispatch of its own (EXEC-QUEUE-10); its completion event is the kernel's.
 */
async function osAnswer(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'os' }>, scope: KernelAnswerScope): Promise<IoAnswerWire> {
  const { os } = ports;
  if (os === undefined) return { kind: 'os', result: { error: { kind: 'denied', message: `${request.op}: no os host configured` } } };
  const { op, args, key, site } = request;
  const completions = ports.osCompletions;
  const sink = ports.deferCallOutcome();
  if (key !== undefined && site !== undefined && completions !== undefined && sink !== undefined && os.defer !== undefined && completions.defers(op)) {
    const orbital = site.orbital ?? scope.orbital;
    const started = os.defer(op, args, key, (outcome) => {
      const fired = completions.event(site, key, outcome);
      if (fired === null) return;
      sink({
        orbital,
        traitName: site.trait,
        event: fired.event,
        payload: isJsonObject(fired.payload) ? fired.payload : undefined,
        entityId: site.entityId,
        originClientId: scope.originClientId,
        user: scope.user,
        locale: scope.locale,
      });
    });
    return 'error' in started ? { kind: 'os', result: started } : { kind: 'serviceDeferred' };
  }
  return { kind: 'os', result: await os.answer(op, args) };
}

async function secret(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'secret' }>): Promise<IoAnswerWire> {
  const store = ports.http?.secrets;
  if (store === undefined) return { kind: 'secret', result: { error: HTTP_UNAVAILABLE } };
  return { kind: 'secret', result: await settle(async () => (await store.get(request.name, request.principal)) ?? null) };
}

async function secretSet(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'secretSet' }>): Promise<IoAnswerWire> {
  const store = ports.http?.secrets;
  if (store === undefined) return { kind: 'secretSet', result: { error: HTTP_UNAVAILABLE } };
  return { kind: 'secretSet', result: await settle(async () => {
    await store.set(request.name, request.value, request.ttlMs, request.principal);
    return null;
  }) };
}

async function secretRotate(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'secretRotate' }>): Promise<IoAnswerWire> {
  const store = ports.http?.secrets;
  if (store === undefined) return { kind: 'secretRotate', result: { error: HTTP_UNAVAILABLE } };
  const rotate = store.rotate;
  if (rotate === undefined) return { kind: 'secretRotate', result: { error: 'this host keeps no rotatable credentials' } };
  return { kind: 'secretRotate', result: await settle(async () => {
    await rotate.call(store, request.name, request.value, request.principal);
    return null;
  }) };
}

/** `random`: CSPRNG bytes (the ports' source, else the platform's), as standard base64. */
function random(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'random' }>): IoAnswerWire {
  const source = ports.http?.random ?? systemRandom;
  try {
    return { kind: 'random', result: { ok: base64Standard(source(request.bytes)) } };
  } catch (error) {
    return { kind: 'random', result: { error: failureMessage(error) } };
  }
}

async function credentialStatus(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'credentialStatus' }>): Promise<IoAnswerWire> {
  const store = ports.http?.secrets;
  if (store === undefined) return { kind: 'credentialStatus', result: { error: HTTP_UNAVAILABLE } };
  return { kind: 'credentialStatus', result: await settle(async () => credentialStatusConnected(await store.get(request.name, request.principal), request.principal)) };
}

async function credentialForget(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'credentialForget' }>): Promise<IoAnswerWire> {
  const store = ports.http?.secrets;
  if (store === undefined) return { kind: 'credentialForget', result: { error: HTTP_UNAVAILABLE } };
  return { kind: 'credentialForget', result: await settle(async () => {
    await store.forget(request.name, request.principal);
    return null;
  }) };
}

async function credentialAdmin<T>(ports: KernelHostPorts, work: (port: CredentialAdminPort) => Promise<T>): Promise<Settled<T, string>> {
  const port = ports.http?.credentials;
  if (port === undefined) return { error: HTTP_UNAVAILABLE };
  return settle(() => work(port));
}

/** `oauth`: what an OAuth flow asks its host to keep, answered by the host's `OAuthPort`. */
async function oauth(ports: KernelHostPorts, request: Extract<IoRequestWire, { kind: 'oauth' }>): Promise<IoAnswerWire> {
  const port = ports.http?.oauth;
  if (port === undefined) return { kind: 'oauth', result: { error: 'this host keeps no OAuth state' } };
  return { kind: 'oauth', result: await settle(async () => checkOAuthReply(await port.answer(request.ask, request.principal))) };
}

function rowData(value: JsonValue): EntityRow {
  if (!isJsonObject(value)) throw new Error('persist: the row is not an object');
  return value;
}

/** A pushed-down query: the adapter runs it where the data lives; a decline leaves nothing read. */
async function queryRows(persistence: PersistenceAdapter, request: Extract<IoRequestWire, { kind: 'queryRows' }>): Promise<IoAnswerWire> {
  const { entityType, query, project } = request;
  try {
    if (project === 'ids') {
      if (!persistence.queryIds) return { kind: 'queryUnsupported', reason: 'no-ids-capability' };
      return { kind: 'idPage', result: { ok: await persistence.queryIds(entityType, query) } };
    }
    if (!persistence.queryPage) return { kind: 'queryUnsupported', reason: 'no-query-capability' };
    return { kind: 'page', result: { ok: await persistence.queryPage(entityType, query) } };
  } catch (error) {
    if (error instanceof QueryDeclinedError) return { kind: 'queryUnsupported', reason: error.reason };
    return { kind: project === 'ids' ? 'idPage' : 'page', result: { error: failureMessage(error) } };
  }
}

/** Pushed-down writes: one op is a `writeWhere`, a run or a batch is a `writeBatch`. */
export async function writeRows(persistence: PersistenceAdapter, request: Extract<IoRequestWire, { kind: 'writeRows' }>): Promise<IoAnswerWire> {
  const { batch } = request;
  try {
    if (!persistence.writeBatch) return { kind: 'writeUnsupported', reason: 'no-write-capability' };
    return { kind: 'wrote', result: { ok: await persistence.writeBatch(batch) } };
  } catch (error) {
    if (error instanceof WriteDeclinedError) return { kind: 'writeUnsupported', reason: error.reason };
    return { kind: 'wrote', result: { error: failureMessage(error) } };
  }
}

/** Tell the kernel what the adapter pushes down for each entity type, once, before the first dispatch. */
export function declareCapabilities(persistence: PersistenceAdapter, declare: (entityType: string, queryJson: string, writeJson: string) => void, entityTypes: readonly string[]): void {
  for (const entityType of entityTypes) {
    const query = persistence.queryPage ? persistence.queryCapabilities?.(entityType) : undefined;
    const write = persistence.writeWhere || persistence.writeBatch ? persistence.writeCapabilities?.(entityType) : undefined;
    if (query === undefined && write === undefined) continue;
    declare(entityType, JSON.stringify(query ?? null), JSON.stringify(write ?? null));
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
          return row;
        }),
      };
    case 'listRows':
      return {
        kind: 'rows',
        result: await settle(async () => await persistence.list(request.entityType)),
      };
    case 'queryRows':
      return queryRows(persistence, request);
    case 'writeRows':
      return writeRows(persistence, request);
    case 'createRow':
      return {
        kind: 'row',
        result: await settle(async () => {
          const data = rowData(request.data);
          const { id } = await persistence.create(request.entityType, data);
          return (await persistence.getById(request.entityType, id)) ?? { ...data, id };
        }),
      };
    case 'writeRow':
      return {
        kind: 'row',
        result: await settle(async () => {
          const data = rowData(request.data);
          const existing = await persistence.getById(request.entityType, request.id);
          if (existing === null) await persistence.create(request.entityType, { ...data, id: request.id });
          else await persistence.update(request.entityType, request.id, { ...data, id: request.id });
          return (await persistence.getById(request.entityType, request.id)) ?? { ...existing, ...data, id: request.id };
        }),
      };
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
      ports.os?.cancel?.(request.key);
      return { kind: 'cancelled', result: { ok: null } };
    case 'substrate':
      return substrate(ports, request, scope);
    case 'http':
    case 'httpStream':
      return http(ports, request, scope);
    case 'httpBeacon':
      return httpBeacon(ports, request, scope);
    case 'pageFacts':
      return pageFacts(request);
    case 'prompt':
    case 'embed':
      return onDeviceModel(ports, request, scope);
    case 'tab':
      return tab(ports, request, scope);
    case 'secret':
      return secret(ports, request);
    case 'secretSet':
      return secretSet(ports, request);
    case 'secretRotate':
      return secretRotate(ports, request);
    case 'random':
      return random(ports, request);
    case 'os':
      return osAnswer(ports, request, scope);
    case 'clock':
      return { kind: 'clock', result: { ok: (ports.now ?? Date.now)() } };
    case 'deliver':
      return { kind: 'deliver', result: { error: { kind: 'down', id: request.envelope.id } } };
    case 'credentialStatus':
      return credentialStatus(ports, request);
    case 'credentialForget':
      return credentialForget(ports, request);
    case 'credentialStoreList':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.list()) };
    case 'credentialStoreRead':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.read(request.name)) };
    case 'credentialStoreWrite':
      return { kind: request.kind, result: await credentialAdmin(ports, async (port) => { await port.write(request.service, request.name, request.value); return null; }) };
    case 'credentialStoreRemove':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.remove(request.name)) };
    case 'credentialStoreRotate':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.rotate()) };
    case 'credentialModeRead':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.mode()) };
    case 'credentialModeWrite':
      return { kind: request.kind, result: await credentialAdmin(ports, (port) => port.setMode(request.mode)) };
    case 'oauth':
      return oauth(ports, request);
  }
}
