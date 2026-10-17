import type * as CoreMock from '@almadar/core/mock';

type CoreMockModule = typeof CoreMock;
type Shape = Record<string, CoreMock.ResponseShapeField>;

const TEST_SERVICE_SHAPES: Record<string, Record<string, Shape>> = {
  'test-svc': { run: { status: 'number', ok: 'boolean', durationMs: 'number' } },
};

/** `@almadar/core/mock` with a test-owned service whose answer shape lives here, not in the installed registry. */
export function withTestService(actual: CoreMockModule): CoreMockModule {
  return {
    ...actual,
    mockServiceAnswer(service, action) {
      const actions = TEST_SERVICE_SHAPES[service];
      if (actions === undefined) return actual.mockServiceAnswer(service, action);
      const shape = actions[action];
      if (shape === undefined) return { ok: false, reason: 'unknown-action', message: `No mock response for action: ${action}` };
      return { ok: true, value: actual.mockFromResponseShape(shape) };
    },
  };
}
