/**
 * Agent Substrate Handlers — Server-Side Only
 *
 * Provides implementations for the effect-position substrate operators:
 * compose/compose-all, compose/compose-children, behavior/instantiate,
 * behavior/call, validate/validate, lolo/emit-body.
 *
 * Used by OrbitalServerRuntime (interpreted path). Wired alongside
 * createOsHandlers — same lazy-import + merge-under-user-handlers pattern.
 *
 * The actual service invocations are injected via the `services` field of
 * AgentSubstrateHandlerContext. @almadar-io/rabit supplies these at runtime;
 * tests can inject mocks. When a service is absent, the handler logs a
 * warning and returns a safe default.
 *
 * NOT exported from the main index.ts because it references Node-only types.
 * Import directly: import { createAgentSubstrateHandlers } from '@almadar/runtime/createAgentSubstrateHandlers';
 *
 * @packageDocumentation
 */

import { createLogger } from '@almadar/logger';
import type { EventPayload, EffectHandlers } from './types.js';
import type { ServiceCallResult, Orbital, TraitConfig } from '@almadar/core';

const log = createLogger('almadar:runtime:substrate-handlers');

export interface SubstrateServices {
    composeAll?: (config: { appName: string; orbitals: Orbital[]; layoutStrategy?: string }) => Promise<ServiceCallResult>;
    composeChildren?: (parentName: string, children: Orbital[]) => Promise<ServiceCallResult>;
    instantiate?: (parentName: string, behavior: string, params?: TraitConfig) => Promise<ServiceCallResult>;
    call?: (behavior: string, method: string, params?: TraitConfig) => Promise<ServiceCallResult>;
    validate?: (orbitalName: string) => Promise<ServiceCallResult>;
    emitBody?: (orbitalName: string, loloSource: string) => Promise<ServiceCallResult>;
}

export interface AgentSubstrateHandlerContext {
    emitEvent: (type: string, payload: EventPayload) => void;
    services: SubstrateServices;
}

export interface AgentSubstrateHandlerResult {
    handlers: Partial<EffectHandlers>;
    cleanup: () => void;
}

export function createAgentSubstrateHandlers(ctx: AgentSubstrateHandlerContext): AgentSubstrateHandlerResult {
    const handlers: Partial<EffectHandlers> = {
        substrateComposeAll: async (config) => {
            if (!ctx.services.composeAll) {
                log.warn('compose-all service not registered');
                return null;
            }
            const result = await ctx.services.composeAll(config);
            ctx.emitEvent('COMPOSED_ALL', { appName: config.appName, orbitalCount: config.orbitals.length });
            return result;
        },

        substrateComposeChildren: async (parentName, children) => {
            if (!ctx.services.composeChildren) {
                log.warn('compose-children service not registered');
                return null;
            }
            const result = await ctx.services.composeChildren(parentName, children);
            ctx.emitEvent('COMPOSED_CHILDREN', { parentName, childCount: children.length });
            return result;
        },

        substrateInstantiate: async (parentName, behavior, params) => {
            if (!ctx.services.instantiate) {
                log.warn('instantiate service not registered');
                return null;
            }
            const result = await ctx.services.instantiate(parentName, behavior, params);
            ctx.emitEvent('BEHAVIOR_INSTANTIATED', { parentName, behavior });
            return result;
        },

        substrateCall: async (behavior, method) => {
            if (!ctx.services.call) {
                log.warn('call service not registered');
                return null;
            }
            const result = await ctx.services.call(behavior, method);
            ctx.emitEvent('BEHAVIOR_CALLED', { behavior, method });
            return result;
        },

        substrateValidate: async (orbitalName) => {
            if (!ctx.services.validate) {
                log.warn('validate service not registered');
                return null;
            }
            const result = await ctx.services.validate(orbitalName);
            ctx.emitEvent('VALIDATED', { orbitalName });
            return result;
        },

        substrateEmitBody: async (orbitalName) => {
            if (!ctx.services.emitBody) {
                log.warn('emit-body service not registered');
                return null;
            }
            const result = await ctx.services.emitBody(orbitalName, '');
            ctx.emitEvent('LOLO_EMITTED', { orbitalName });
            return result;
        },
    };

    return {
        handlers,
        cleanup: () => {},
    };
}
