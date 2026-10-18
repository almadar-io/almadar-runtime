/**
 * The content-script side of the browser-tab port: one executor over this page, answering the worker's commands.
 * It imports no runtime beyond the executor, so the page script stays small.
 */
import type { JsonValue } from '@almadar/core';
import type { TabCommand } from '@almadar/core/kernel-wire';
import { createPageExecutor, PageCommandError } from './executor.js';
import type { ChromeRuntimeApi } from './messages.js';

/** The content-script side: one executor over this page, answering the worker's commands. */
export function runPageContentScript(runtime: ChromeRuntimeApi, doc: Document, url: string): void {
  const executor = createPageExecutor(doc);

  const run = async (command: TabCommand): Promise<JsonValue> => {
    switch (command.kind) {
      case 'query': {
        const elements =
          command.waitMs != null
            ? await executor.queryWhenPresent(command.selector, command.fields, command.limit ?? undefined, command.waitMs)
            : executor.query(command.selector, command.fields, command.limit ?? undefined);
        return elements;
      }
      case 'watch':
        executor.watch(command.watchId, command.selector, command.fields, (element) => {
          void runtime.sendMessage({ almadarPage: 'element', watchId: command.watchId, element, url });
        });
        return null;
      case 'unwatch':
        return executor.unwatch(command.watchId);
      case 'apply':
        executor.apply(command);
        return true;
      case 'applyMany':
        return executor.applyMany(command.items);
      case 'act':
        executor.act(command.elementId, command.action, command.text ?? undefined);
        return true;
    }
  };

  runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.almadarPage !== 'command') return;
    run(message.command).then(
      (result) => respond({ result }),
      (err: Error) => respond({ error: { kind: err instanceof PageCommandError ? err.kind : 'failed', message: err.message } }),
    );
    // The reply is sent later: Chrome keeps the channel open when the listener returns true.
    return true;
  });

  void runtime.sendMessage({ almadarPage: 'ready', url });
}
