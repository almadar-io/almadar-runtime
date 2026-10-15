import type { ServerResponse } from 'http';
import type { JsonValue } from '@almadar/core';

export interface SSEEvent<D = JsonValue> {
  type: string;
  data?: D;
  timestamp?: number;
}

export function setupSSE(res: ServerResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function formatSSEEvent<D>(event: SSEEvent<D>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function sendSSEEvent<D>(res: ServerResponse, event: SSEEvent<D>): void {
  res.write(formatSSEEvent(event));
}

export function sendSSEDone(res: ServerResponse): void {
  sendSSEEvent(res, { type: 'done', timestamp: Date.now() });
  res.end();
}

export function closeSSE(res: ServerResponse): void {
  res.end();
}
