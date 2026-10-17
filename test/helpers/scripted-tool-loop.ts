import type { EventPayload, ServiceHostPorts } from '@almadar/core';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ToolMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolTurn = { message: ToolMessage; finishReason: string; usage: null };
export type ToolRequest = { messages: ReadonlyArray<ToolMessage>; tools?: ReadonlyArray<{ function: { name: string } }> };
export interface ScriptedModel {
  callWithTools(options: ToolRequest): Promise<ToolTurn>;
}
export type ToolSpec = { event: string } | { read: string };

const MAX_STEPS = 8;

function toolName(tool: ToolSpec): string {
  return 'read' in tool ? `read__${tool.read}` : tool.event.split('.').join('__');
}

function payloadOf(raw: string): EventPayload {
  const parsed: EventPayload = JSON.parse(raw);
  return parsed;
}

async function answer(host: ServiceHostPorts, call: ToolCall): Promise<string> {
  const name = call.function.name;
  if (name.startsWith('read__')) {
    return JSON.stringify({ rows: await host.read(name.slice('read__'.length)) });
  }
  const parts = name.split('__');
  const event = parts[parts.length - 1];
  const trait = parts[parts.length - 2];
  const input = host.inputs().find((i) => i.event === event && i.trait === trait && (parts.length < 3 || i.orbital === parts[0]));
  if (input === undefined) return JSON.stringify({ error: `unknown tool ${name}` });
  try {
    const response = await host.dispatchInput(input.orbital, { targetTrait: input.trait, event: input.event, payload: payloadOf(call.function.arguments) });
    const failed = response.effectResults?.find((r) => r.success === false);
    if (!response.success || failed !== undefined) return JSON.stringify({ error: failed?.error ?? 'denied' });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ error: `denied: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** Drives a scripted model over the lent host ports: each requested tool call is answered through the ports, as the signed-in caller. */
export async function runScriptedToolLoop(
  model: ScriptedModel,
  host: ServiceHostPorts,
  request: { messages: ReadonlyArray<ToolMessage>; tools: ReadonlyArray<ToolSpec> },
): Promise<{ reply: string; steps: ToolMessage[] }> {
  const messages: ToolMessage[] = [...request.messages];
  const defs = request.tools.map((tool) => ({ function: { name: toolName(tool) } }));
  const steps: ToolMessage[] = [];
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const turn = await model.callWithTools({ messages: [...messages], tools: defs });
    messages.push(turn.message);
    steps.push(turn.message);
    const calls = turn.message.tool_calls;
    if (calls === undefined || calls.length === 0) return { reply: turn.message.content ?? '', steps };
    for (const call of calls) {
      const result: ToolMessage = { role: 'tool', content: await answer(host, call), tool_call_id: call.id };
      messages.push(result);
      steps.push(result);
    }
  }
  throw new Error(`the scripted model did not reply within ${MAX_STEPS} steps`);
}
