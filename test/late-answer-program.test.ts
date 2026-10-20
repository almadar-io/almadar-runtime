// Twin of orbital-server `a_hook_answered_after_a_keyed_completion_reaches_a_caller_that_awaits_it` (EXEC-INBOUND-1,
// awaited answer): a hook whose handler answers after a keyed os/wait. The JS kernel host waits for every ask of the
// delivering dispatch, so the answer arrives with the delivery itself.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const program = fileURLToPath(new URL('./fixtures/late-answer/late-answer.lolo', import.meta.url));

describe.skipIf(KERNEL_DIR === undefined)('a hook answered after a keyed completion', () => {
  it('reaches the caller with the answer the completion produced', async () => {
    const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
    try {
      const answer = await p.deliverInbound('cli-echo', { headers: {}, rawBody: '{}' });
      expect(answer).toEqual({ status: 200, body: '{"ok":true}' });
      const unknown = await p.deliverInbound('nope', { headers: {}, rawBody: '{}' });
      expect(unknown.status).toBe(404);
    } finally {
      p.close();
    }
  }, 20_000);
});
