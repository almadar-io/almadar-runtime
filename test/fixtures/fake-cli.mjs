#!/usr/bin/env node
// A replaying command-line program for parity tests, linked into a bin directory under the program's name. That
// directory's fake-cli-table.json maps "<program> <argv joined by spaces>" to the replies to give, in order, each
// { stdout, stderr, code } (the last one repeats); a key ending in "*" answers every call it is a prefix of, when no exact key does; fake-cli-state/ keeps the reply counters and calls.ndjson, the log of
// every call. Read from the link's directory, so the child needs no environment of its own.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const bin = dirname(process.argv[1]);
const state = join(bin, 'fake-cli-state');
mkdirSync(state, { recursive: true });
const table = JSON.parse(readFileSync(join(bin, 'fake-cli-table.json'), 'utf8'));
const key = [basename(process.argv[1]), ...process.argv.slice(2)].join(' ');
appendFileSync(join(state, 'calls.ndjson'), `${JSON.stringify({ key })}\n`);
const prefixKey = Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)));
const replyKey = table[key] !== undefined ? key : prefixKey;
const replies = replyKey === undefined ? undefined : table[replyKey];
if (replies === undefined) { process.stderr.write(`fake-cli: no replies for ${key}\n`); process.exit(97); }
const counter = join(state, createHash('sha256').update(replyKey ?? key).digest('hex'));
const i = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(i + 1));
const reply = replies[Math.min(i, replies.length - 1)];
process.stdout.write(reply.stdout ?? '');
process.stderr.write(reply.stderr ?? '');
process.exit(reply.code ?? 0);
