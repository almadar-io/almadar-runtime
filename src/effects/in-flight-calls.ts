/**
 * The in-flight `call-service` registry of ONE running app: a call declared
 * with a `key` registers here for as long as it runs, and `cancel-call` aborts
 * every call running under that key. One instance is shared by every transition of the app.
 */
export type KeyedCallOutcome<T> = { cancelled: true } | { cancelled: false; value: T };

export class InFlightCalls {
  private readonly calls = new Map<string, Set<AbortController>>();

  /** Whether a call started with `key` is still running. */
  inFlight(key: string): boolean {
    return (this.calls.get(key)?.size ?? 0) > 0;
  }

  /**
   * Run `work` registered under `key`, handing it the abort signal; `work` must settle promptly once the
   * signal aborts (see `untilAborted`). The call is cancelled when the signal was aborted by the time
   * `work` settles, whatever it settled with.
   */
  async run<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<KeyedCallOutcome<T>> {
    const controller = new AbortController();
    const running = this.calls.get(key) ?? new Set<AbortController>();
    running.add(controller);
    this.calls.set(key, running);
    try {
      const value = await work(controller.signal);
      return controller.signal.aborted ? { cancelled: true } : { cancelled: false, value };
    } catch (err) {
      if (controller.signal.aborted) return { cancelled: true };
      throw err;
    } finally {
      running.delete(controller);
      if (running.size === 0 && this.calls.get(key) === running) this.calls.delete(key);
    }
  }

  /** Abort every call running under `key`; false (a no-op) when none is. */
  cancel(key: string): boolean {
    const running = this.calls.get(key);
    if (running === undefined || running.size === 0) return false;
    this.calls.delete(key);
    for (const controller of running) controller.abort();
    return true;
  }
}

/** `promise`, or a rejection as soon as `signal` aborts: a provider that ignores the signal is not waited for. */
export function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Error('The call was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('The call was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err: Error) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
