/**
 * ServerBridge - Client-Server Trait Communication
 *
 * Bridges the client EventBus with the server OrbitalRuntime:
 * 1. Forwards specified events from client to server
 * 2. Receives events from server (via polling or WebSocket)
 * 3. Puts server events onto client EventBus
 *
 * This enables cross-orbital communication between client and server traits.
 *
 * @example
 * ```typescript
 * import { ServerBridge } from '@kflow-builder/shared/runtime';
 * import { useEventBus } from './hooks/useEventBus';
 *
 * // In your app initialization
 * const eventBus = useEventBus();
 * const bridge = new ServerBridge({
 *   eventBus,
 *   serverUrl: '/api/orbitals',
 *   // Events to forward from client to server
 *   forwardEvents: ['ORDER_PLACED', 'PAYMENT_COMPLETED'],
 * });
 *
 * bridge.connect();
 *
 * // Now when client emits ORDER_PLACED, server traits receive it
 * eventBus.emit('ORDER_PLACED', { orderId: '123' });
 * ```
 *
 * @packageDocumentation
 */

import type { IEventBus, RuntimeEvent } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface ServerBridgeConfig {
  /** Client EventBus to bridge */
  eventBus: IEventBus;
  /** Base URL for orbital server API */
  serverUrl: string;
  /** Events to forward from client to server */
  forwardEvents?: string[];
  /** Forward all events matching pattern (e.g., 'Order*', '*') */
  forwardPattern?: string;
  /** Target orbital for forwarded events (or 'broadcast' for all) */
  targetOrbital?: string;
  /** Enable WebSocket for real-time server events */
  useWebSocket?: boolean;
  /** Polling interval in ms (if not using WebSocket) */
  pollInterval?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom fetch function (for testing or custom auth) */
  fetch?: typeof fetch;
}

export interface ServerBridgeState {
  connected: boolean;
  lastError?: string;
  eventsForwarded: number;
  eventsReceived: number;
}

// ============================================================================
// ServerBridge
// ============================================================================

/**
 * Bridges client EventBus with server OrbitalRuntime
 */
export class ServerBridge {
  private config: ServerBridgeConfig;
  private state: ServerBridgeState = {
    connected: false,
    eventsForwarded: 0,
    eventsReceived: 0,
  };
  private unsubscribes: Array<() => void> = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private ws?: WebSocket;
  private fetchFn: typeof fetch;

  constructor(config: ServerBridgeConfig) {
    this.config = {
      pollInterval: 5000,
      ...config,
    };
    this.fetchFn = config.fetch || fetch.bind(globalThis);
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Connect the bridge - start forwarding events
   */
  connect(): void {
    if (this.state.connected) {
      this.log("warn", "Already connected");
      return;
    }

    this.log("info", "Connecting bridge...");

    // Subscribe to events to forward
    this.setupEventForwarding();

    // Set up server -> client channel
    if (this.config.useWebSocket) {
      this.setupWebSocket();
    } else if (this.config.pollInterval && this.config.pollInterval > 0) {
      this.setupPolling();
    }

    this.state.connected = true;
    this.log("info", "Bridge connected");
  }

  /**
   * Disconnect the bridge
   */
  disconnect(): void {
    // Clean up event subscriptions
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];

    // Clean up polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Clean up WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.state.connected = false;
    this.log("info", "Bridge disconnected");
  }

  /**
   * Get current bridge state
   */
  getState(): ServerBridgeState {
    return { ...this.state };
  }

  // ==========================================================================
  // Event Forwarding (Client -> Server)
  // ==========================================================================

  private setupEventForwarding(): void {
    const { eventBus, forwardEvents, forwardPattern } = this.config;

    if (forwardEvents && forwardEvents.length > 0) {
      // Forward specific events
      for (const eventType of forwardEvents) {
        const unsub = eventBus.on(eventType, (event: RuntimeEvent) => {
          this.forwardToServer(event);
        });
        this.unsubscribes.push(unsub);
      }
    } else if (forwardPattern) {
      // Forward events matching pattern
      if (forwardPattern === "*") {
        // Forward all events
        const unsub = eventBus.on("*", (event: RuntimeEvent) => {
          // Don't forward internal events
          if (
            !event.type.startsWith("UI:") &&
            !event.type.startsWith("BRIDGE:")
          ) {
            this.forwardToServer(event);
          }
        });
        this.unsubscribes.push(unsub);
      } else {
        // Pattern matching (simple prefix match)
        const prefix = forwardPattern.replace("*", "");
        const unsub = eventBus.on("*", (event: RuntimeEvent) => {
          if (event.type.startsWith(prefix)) {
            this.forwardToServer(event);
          }
        });
        this.unsubscribes.push(unsub);
      }
    }
  }

  private async forwardToServer(event: RuntimeEvent): Promise<void> {
    const { serverUrl, targetOrbital } = this.config;

    try {
      // Determine which orbital(s) to send to
      if (targetOrbital && targetOrbital !== "broadcast") {
        // Send to specific orbital
        await this.sendEventToOrbital(targetOrbital, event);
      } else {
        // Broadcast to all orbitals
        const orbitals = await this.fetchOrbitals();
        for (const orbital of orbitals) {
          await this.sendEventToOrbital(orbital.name, event);
        }
      }

      this.state.eventsForwarded++;
      this.log("debug", `Forwarded event: ${event.type}`);
    } catch (error) {
      this.state.lastError = String(error);
      this.log("error", `Failed to forward event: ${event.type}`, error);
    }
  }

  private async sendEventToOrbital(
    orbitalName: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const { serverUrl } = this.config;
    const url = `${serverUrl}/${orbitalName}/events`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: event.type,
        payload: event.payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = (await response.json()) as {
      emittedEvents?: Array<{ event: string; payload?: Record<string, unknown> }>;
    };

    // If server emitted events, put them on client EventBus
    if (result.emittedEvents && result.emittedEvents.length > 0) {
      for (const emitted of result.emittedEvents) {
        this.config.eventBus.emit(`SERVER:${emitted.event}`, emitted.payload);
        this.state.eventsReceived++;
      }
    }
  }

  private async fetchOrbitals(): Promise<Array<{ name: string }>> {
    const response = await this.fetchFn(this.config.serverUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch orbitals: ${response.status}`);
    }
    const data = (await response.json()) as { orbitals?: Array<{ name: string }> };
    return data.orbitals || [];
  }

  // ==========================================================================
  // Server -> Client (Polling)
  // ==========================================================================

  private setupPolling(): void {
    // For now, polling is handled by the response to forwarded events
    // A more sophisticated implementation would poll a /events endpoint
    this.log("debug", "Polling mode - events received via forward response");
  }

  // ==========================================================================
  // Server -> Client (WebSocket)
  // ==========================================================================

  private setupWebSocket(): void {
    const { serverUrl } = this.config;

    // Convert HTTP URL to WebSocket URL
    const wsUrl = serverUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/api\/orbitals$/, "/ws/orbitals");

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.log("info", "WebSocket connected");
      };

      this.ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.type === "event") {
            // Server pushed an event - put it on client EventBus
            this.config.eventBus.emit(`SERVER:${data.event}`, data.payload);
            this.state.eventsReceived++;
            this.log("debug", `Received server event: ${data.event}`);
          }
        } catch (error) {
          this.log("error", "Failed to parse WebSocket message", error);
        }
      };

      this.ws.onerror = (error) => {
        this.state.lastError = "WebSocket error";
        this.log("error", "WebSocket error", error);
      };

      this.ws.onclose = () => {
        this.log("info", "WebSocket closed");
        // Could implement reconnection logic here
      };
    } catch (error) {
      this.log("error", "Failed to create WebSocket", error);
    }
  }

  // ==========================================================================
  // Direct Methods
  // ==========================================================================

  /**
   * Send an event directly to a specific orbital (bypassing EventBus)
   */
  async sendEvent(
    orbitalName: string,
    event: string,
    payload?: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    states?: Record<string, string>;
    emittedEvents?: Array<{ event: string; payload?: unknown }>;
    error?: string;
  }> {
    const { serverUrl } = this.config;
    const url = `${serverUrl}/${orbitalName}/events`;

    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, payload }),
      });

      return (await response.json()) as {
        success: boolean;
        states?: Record<string, string>;
        emittedEvents?: Array<{ event: string; payload?: unknown }>;
        error?: string;
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get current state of an orbital's traits
   */
  async getOrbitalState(orbitalName: string): Promise<{
    success: boolean;
    states?: Record<string, string>;
    error?: string;
  }> {
    const { serverUrl } = this.config;
    const url = `${serverUrl}/${orbitalName}`;

    try {
      const response = await this.fetchFn(url);
      const data = (await response.json()) as {
        success: boolean;
        orbital?: { traits: Array<{ name: string; currentState: string }> };
        error?: string;
      };

      if (data.success && data.orbital) {
        const states: Record<string, string> = {};
        for (const trait of data.orbital.traits) {
          states[trait.name] = trait.currentState;
        }
        return { success: true, states };
      }

      return { success: false, error: data.error };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void {
    if (!this.config.debug && level === "debug") return;

    const prefix = "[ServerBridge]";
    const logFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    logFn(prefix, message, data !== undefined ? data : "");
  }
}

/**
 * Create a ServerBridge instance
 */
export function createServerBridge(config: ServerBridgeConfig): ServerBridge {
  return new ServerBridge(config);
}
