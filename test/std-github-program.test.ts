// std-github on the kernel against a pinned GitHub: GraphQL queries and the Actions run/job lists, each answering
// its result or its failure (with the status a caller retries on), never neither.
import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-github');

interface Sent { method: string; url: string; body: string; authorization: string }
type Reply = { status: number; body: string } | 'unreachable';

function github(replies: Reply[]) {
  const sent: Sent[] = [];
  return {
    sent,
    http: {
      secrets: memorySecrets({ GITHUB_TOKEN: 'ghp-test' }),
      fetch: async (url: URL, init: PinnedInit) => {
        sent.push({
          method: init.method,
          url: url.href,
          body: init.body === undefined ? '' : new TextDecoder().decode(init.body),
          authorization: init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '',
        });
        const reply = replies.shift();
        if (reply === undefined) throw new Error(`unexpected request ${url.href}`);
        if (reply === 'unreachable') throw new Error('connect ECONNREFUSED');
        return new Response(reply.body, { status: reply.status, headers: [['content-type', 'application/json']] });
      },
      resolve: async (host: string) => ({ literal: true, addresses: [host] }),
    },
  };
}

describe.skipIf(KERNEL_DIR === undefined)('std-github on the kernel', () => {
  const open = async (transport: ReturnType<typeof github>): Promise<KernelProgram> =>
    KernelProgram.open(await resolveProgramFile(atom, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: transport.http });
  const answer = async (p: KernelProgram, event: string, payload: EventPayload, answers: string[]) => {
    const run = await p.dispatch('GithubOrbital', event, payload);
    const found = run.emits.filter((e) => answers.includes(e.event));
    if (found.length !== 1) throw new Error(`${event}: ${found.length} answers (${run.error ?? JSON.stringify(run.rejections)})`);
    return { event: found[0].event, payload: found[0].payload };
  };
  const GRAPHQL = ['GITHUB_GRAPHQL_ANSWERED', 'GITHUB_GRAPHQL_FAILED'];
  const RUNS = ['GITHUB_RUNS', 'GITHUB_LIST_RUNS_FAILED'];
  const JOBS = ['GITHUB_RUN_JOBS', 'GITHUB_LIST_RUN_JOBS_FAILED'];

  it('a GraphQL query posts {query, variables} to /graphql with the token and answers the reply body as text', async () => {
    const reply = '{"data":{"viewer":{"login":"octo"}}}';
    const t = github([{ status: 200, body: reply }]);
    const p = await open(t);
    try {
      expect(await answer(p, 'GITHUB_GRAPHQL', { query: 'query($n: Int!) { viewer { login } }', variables: '{"n":3}' }, GRAPHQL)).toEqual({ event: 'GITHUB_GRAPHQL_ANSWERED', payload: { body: reply } });
      expect(t.sent).toEqual([{ method: 'POST', url: 'https://api.github.com/graphql', body: '{"query":"query($n: Int!) { viewer { login } }","variables":{"n":3}}', authorization: 'Bearer ghp-test' }]);
    } finally {
      p.close();
    }
  });

  it('control: a query without variables sends an empty variables object', async () => {
    const t = github([{ status: 200, body: '{"data":{}}' }]);
    const p = await open(t);
    try {
      await answer(p, 'GITHUB_GRAPHQL', { query: '{ viewer { login } }' }, GRAPHQL);
      expect(t.sent[0].body).toBe('{"query":"{ viewer { login } }","variables":{}}');
    } finally {
      p.close();
    }
  });

  it('a GraphQL errors list in a 200 reply is still an answer: the caller reads data and errors itself', async () => {
    const reply = '{"data":null,"errors":[{"message":"Something went wrong"}]}';
    const p = await open(github([{ status: 200, body: reply }]));
    try {
      expect(await answer(p, 'GITHUB_GRAPHQL', { query: '{ x }' }, GRAPHQL)).toEqual({ event: 'GITHUB_GRAPHQL_ANSWERED', payload: { body: reply } });
    } finally {
      p.close();
    }
  });

  it('edge: a gateway error fails with its status and GitHub\'s reason phrase; an unreachable GitHub fails with status 0', async () => {
    const p = await open(github([{ status: 502, body: '<html>Unicorn</html>' }, 'unreachable']));
    try {
      expect(await answer(p, 'GITHUB_GRAPHQL', { query: '{ x }' }, GRAPHQL)).toEqual({ event: 'GITHUB_GRAPHQL_FAILED', payload: { status: 502, code: 'SERVICE_ERROR', message: 'GitHub API request failed: Bad Gateway' } });
      expect(await answer(p, 'GITHUB_GRAPHQL', { query: '{ x }' }, GRAPHQL)).toMatchObject({ event: 'GITHUB_GRAPHQL_FAILED', payload: { status: 0, code: 'NETWORK_ERROR' } });
    } finally {
      p.close();
    }
  });

  it('control: a refused token fails AUTH_ERROR with GitHub\'s message', async () => {
    const p = await open(github([{ status: 401, body: '{"message":"Bad credentials"}' }]));
    try {
      expect(await answer(p, 'GITHUB_GRAPHQL', { query: '{ x }' }, GRAPHQL)).toEqual({ event: 'GITHUB_GRAPHQL_FAILED', payload: { status: 401, code: 'AUTH_ERROR', message: 'GitHub API authentication failed: Bad credentials' } });
    } finally {
      p.close();
    }
  });

  it('listing a repository\'s workflow runs answers the runs for that repository, a null conclusion kept null', async () => {
    const t = github([{ status: 200, body: JSON.stringify({ total_count: 2, workflow_runs: [
      { id: 11, name: 'CI', status: 'in_progress', conclusion: null, created_at: '2026-10-19T01:00:00Z', html_url: 'https://github.com/a/b/actions/runs/11', head_branch: 'main' },
      { id: 10, name: 'CI', status: 'completed', conclusion: 'success', created_at: '2026-10-18T01:00:00Z', html_url: 'https://github.com/a/b/actions/runs/10', head_branch: 'main' },
    ] }) }]);
    const p = await open(t);
    try {
      expect(await answer(p, 'GITHUB_LIST_RUNS', { owner: 'a', repo: 'b', per_page: 2 }, RUNS)).toEqual({ event: 'GITHUB_RUNS', payload: { owner: 'a', repo: 'b', runs: [
        { id: 11, name: 'CI', status: 'in_progress', conclusion: null, created_at: '2026-10-19T01:00:00Z', html_url: 'https://github.com/a/b/actions/runs/11' },
        { id: 10, name: 'CI', status: 'completed', conclusion: 'success', created_at: '2026-10-18T01:00:00Z', html_url: 'https://github.com/a/b/actions/runs/10' },
      ] } });
      expect(t.sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://api.github.com/repos/a/b/actions/runs?per_page=2']);
    } finally {
      p.close();
    }
  });

  it('edge: a failed run list says which repository it was for', async () => {
    const p = await open(github([{ status: 404, body: '{"message":"Not Found"}' }]));
    try {
      expect(await answer(p, 'GITHUB_LIST_RUNS', { owner: 'a', repo: 'gone' }, RUNS)).toEqual({ event: 'GITHUB_LIST_RUNS_FAILED', payload: { owner: 'a', repo: 'gone', code: 'SERVICE_ERROR', message: 'GitHub API request failed: Not Found' } });
    } finally {
      p.close();
    }
  });

  it('control: each run list answers the repository it was asked for', async () => {
    const body = (id: number) => JSON.stringify({ total_count: 1, workflow_runs: [{ id, name: 'CI', status: 'completed', conclusion: 'failure', created_at: '2026-10-19T01:00:00Z', html_url: `https://github.com/x/${id}` }] });
    const p = await open(github([{ status: 200, body: body(1) }, { status: 200, body: body(2) }]));
    try {
      const first = await answer(p, 'GITHUB_LIST_RUNS', { owner: 'x', repo: 'one', per_page: 1 }, RUNS);
      const second = await answer(p, 'GITHUB_LIST_RUNS', { owner: 'x', repo: 'two', per_page: 1 }, RUNS);
      expect([first.payload?.repo, second.payload?.repo]).toEqual(['one', 'two']);
    } finally {
      p.close();
    }
  });

  it('listing a run\'s jobs answers the jobs with the repository and run they belong to', async () => {
    const t = github([{ status: 200, body: JSON.stringify({ total_count: 2, jobs: [
      { id: 7, name: 'build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/a/b/actions/runs/10/job/7', steps: [] },
      { id: 8, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/10/job/8', steps: [] },
    ] }) }]);
    const p = await open(t);
    try {
      expect(await answer(p, 'GITHUB_LIST_RUN_JOBS', { owner: 'a', repo: 'b', runId: 10 }, JOBS)).toEqual({ event: 'GITHUB_RUN_JOBS', payload: { owner: 'a', repo: 'b', runId: 10, jobs: [
        { id: 7, name: 'build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/a/b/actions/runs/10/job/7' },
        { id: 8, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/a/b/actions/runs/10/job/8' },
      ] } });
      expect(t.sent.map((s) => s.url)).toEqual(['https://api.github.com/repos/a/b/actions/runs/10/jobs']);
    } finally {
      p.close();
    }
  });

  it('control: an unreachable GitHub fails the job list for that run', async () => {
    const p = await open(github(['unreachable']));
    try {
      expect(await answer(p, 'GITHUB_LIST_RUN_JOBS', { owner: 'a', repo: 'b', runId: 10 }, JOBS)).toMatchObject({ event: 'GITHUB_LIST_RUN_JOBS_FAILED', payload: { owner: 'a', repo: 'b', runId: 10, code: 'NETWORK_ERROR' } });
    } finally {
      p.close();
    }
  });

  const BILLING = ['GITHUB_BILLING_USAGE_ANSWERED', 'GITHUB_BILLING_USAGE_FAILED'];
  const item = { product: 'actions', sku: 'Actions Linux', quantity: 10, unitType: 'Minutes', grossAmount: 0.08, discountAmount: 0.08, netAmount: 0, repositoryName: 'a' };

  it('billing usage reads the org path with the month and answers the usage items', async () => {
    const t = github([{ status: 200, body: JSON.stringify({ usageItems: [item] }) }]);
    const p = await open(t);
    try {
      expect(await answer(p, 'GITHUB_BILLING_USAGE', { account: 'acme', kind: 'org', year: 2026, month: 10 }, BILLING)).toEqual({ event: 'GITHUB_BILLING_USAGE_ANSWERED', payload: { account: 'acme', kind: 'org', year: 2026, month: 10, items: [item] } });
      const url = new URL(t.sent[0].url);
      expect([t.sent.length, url.origin + url.pathname, url.searchParams.get('year'), url.searchParams.get('month')]).toEqual([1, 'https://api.github.com/organizations/acme/settings/billing/usage', '2026', '10']);
    } finally {
      p.close();
    }
  });

  it('control: a user account reads the users path, and a report without usageItems has none', async () => {
    const t = github([{ status: 200, body: '{}' }]);
    const p = await open(t);
    try {
      expect((await answer(p, 'GITHUB_BILLING_USAGE', { account: 'octo', kind: 'user', year: 2026, month: 1 }, BILLING)).payload).toMatchObject({ items: [] });
      const url = new URL(t.sent[0].url);
      expect([url.pathname, url.searchParams.get('year'), url.searchParams.get('month')]).toEqual(['/users/octo/settings/billing/usage', '2026', '1']);
    } finally {
      p.close();
    }
  });

  it('edge: a 404 fails with GitHub\'s message, a body that is not JSON fails PARSE_ERROR', async () => {
    const p = await open(github([{ status: 404, body: '{"message":"Not Found"}' }, { status: 200, body: '<html>maintenance</html>' }]));
    try {
      expect(await answer(p, 'GITHUB_BILLING_USAGE', { account: 'acme', kind: 'org', year: 2026, month: 10 }, BILLING)).toEqual({ event: 'GITHUB_BILLING_USAGE_FAILED', payload: { account: 'acme', kind: 'org', status: 404, code: 'SERVICE_ERROR', message: 'GitHub API request failed: Not Found' } });
      expect((await answer(p, 'GITHUB_BILLING_USAGE', { account: 'octo', kind: 'user', year: 2026, month: 10 }, BILLING)).payload).toMatchObject({ account: 'octo', status: 200, code: 'PARSE_ERROR' });
    } finally {
      p.close();
    }
  });
});

