/** The Chrome message surface the tab port's two halves share: types only, no runtime imports. */
import type { JsonValue } from '@almadar/core';
import type { TabCommand, TabFailureKind } from '@almadar/core/kernel-wire';
import type { TabElement } from './executor.js';

export interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
}

export interface ChromeTabsApi {
  query(filter: object): Promise<ChromeTab[]>;
  create(props: { url: string; active: boolean }): Promise<ChromeTab>;
  remove(tab: number): Promise<void>;
  update(tab: number, props: { url?: string; active?: boolean }): Promise<ChromeTab | undefined>;
  captureVisibleTab(windowId: number, options: { format: 'png' | 'jpeg'; quality?: number }): Promise<string>;
  sendMessage(tab: number, message: PageMessage): Promise<PageReply | undefined>;
}

export interface ChromeRuntimeApi {
  sendMessage(message: PageMessage): Promise<PageReply | undefined>;
  onMessage: {
    addListener(listener: (message: PageMessage, sender: { tab?: ChromeTab }, respond: (reply: PageReply) => void) => boolean | void): void;
  };
}

export type PageMessage =
  | { almadarPage: 'ready'; url: string }
  | { almadarPage: 'command'; command: TabCommand }
  | { almadarPage: 'element'; watchId: string; element: TabElement; url: string };

/** What a content script answers a command with: its JSON result, or why it could not. */
export type PageReply = { result: JsonValue } | { error: { kind: TabFailureKind; message: string } };

