import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PiHost, withoutToolCalls} from '../src/runtime/pi-host.js';
import {Store} from '../src/sessions/store.js';
import type {Config} from '../src/config.js';
const listen = async (s: ReturnType<typeof createServer>) => {await new Promise<void>(r => s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(s.address() as {port:number}).port}`};
const question = '我想讨论一个问题，什么样的人品才是真正的好人品。我想以明朝的张居正为原型，写一部背景是平行宇宙的科幻小说。';
const answer = '好人品可以放在权力与责任的张力里看：张居正推行改革时的担当与他私德上的争议，正好让平行宇宙里的“他”面对另一种选择。';
type Body = {messages: {role: string; content: unknown}[]; tools?: unknown[]; tool_choice?: string};
const call = (id: string, query: string) => ({index: 0, id, type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify({query})}});
// Provider fixture: `mode` decides how badly the model behaves. Discussion-memory
// requests are recognized by their system prompt and always answer with a summary.
async function harness(mode: () => string, limits: Partial<Config['model']['limits']> = {}, initialScopes: string[] = ['knowledge']) {
  const state = mkdtempSync(join(tmpdir(), 'pi-turns-'));
  const id = 'th-' + randomUUID();
  const payloads: Body[] = [];
  let scopes: string[] = initialScopes, tools = 0, n = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const p of req) raw += p;
    const body = JSON.parse(raw) as Body; payloads.push(body); n++;
    const memory = JSON.stringify(body.messages[0]).includes('Summarize the quoted discussion');
    const closing = body.tool_choice === 'none';
    let delta: Record<string, unknown>;
    if (memory) delta = {content: '作者决定：以张居正为原型。未决：平行宇宙规则。'};
    // No tools offered: a stubborn model still hallucinates a call next to its prose.
    else if (!(body.tools ?? []).length) delta = mode() === 'stubborn' ? {content: answer, tool_calls: [call('ghost-' + n, '不存在的工具')]} : {content: answer};
    else if (mode() === 'stubborn') delta = closing ? {content: answer, tool_calls: [call('late-' + n, '仍然想查')]} : {tool_calls: [call('call-' + n, '张居正 ' + n)]};
    else if (mode() === 'parallel' && !closing && n === 1) delta = {tool_calls: Array.from({length: 5}, (_, i) => ({...call('p-' + i, '人物 ' + i), index: i}))};
    else if (mode() === 'one-tool' && !closing && !body.messages.some(m => m.role === 'tool')) delta = {tool_calls: [call('only-' + n, '张居正')]};
    else delta = {content: answer};
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.write('data: ' + JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason: null}]}) + '\n\n');
    res.write('data: ' + JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 120, completion_tokens: 60, total_tokens: 180}}) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const endpoint = await listen(provider);
  const model = {modelId: 'deepseek', displayName: 'DeepSeek', provider: 'deepseek', model: 'deepseek-fixture', endpoint, protocol: 'thinking-v1' as const,
    limits: {maxTurnsPerRequest: 3, maxToolCalls: 3, maxInputTokens: 32000, maxOutputTokens: 1024, maxSessionTokens: 2000000, maxConcurrentSessions: 2, maxDurationMs: 8000, maxToolResultBytes: 24000, ...limits}};
  const story = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/authorize')) res.end(JSON.stringify({sessionId: id, authorId: 'a', bookId: 'b', model, scopes}));
    else {tools++; res.end('{"items":[],"sources":[]}')}
  });
  const config: Config = {state, port: 1, version: 'test', key: 'fixture', token: 't'.repeat(64), storyOrigin: await listen(story), model, models: [{model, key: 'fixture', enabled: true, description: '讨论'}]};
  const host = new PiHost(config, new Store(state));
  await host.create({sessionId: id, authorId: 'a', bookId: 'b', createdAt: new Date().toISOString(), model, scopes: scopes as ('knowledge')[], capability: 'fixture'});
  return {
    host, id, payloads,
    setScopes: (v: string[]) => {scopes = v},
    tools: () => tools,
    async send(text: string, key: string = randomUUID()) {
      await host.accept(id, {text, modelId: 'deepseek'}, key, 'fixture');
      await host.active.get(id)?.done;
      return host.get(id).view.messages.at(-1)!;
    },
    async close() {await host.close(); provider.closeAllConnections(); story.closeAllConnections(); provider.close(); story.close(); rmSync(state, {recursive: true, force: true})},
  };
}

test('a model that keeps calling tools still answers the regression question on the closing turn', async () => {
  const h = await harness(() => 'stubborn');
  try {
    const reply = await h.send(question);
    assert.equal(reply.status, 'completed', reply.errorCode);
    assert.equal(reply.text, answer);
    assert.equal(h.payloads.length, 3, 'exactly maxTurnsPerRequest provider calls');
    const last = h.payloads.at(-1)!;
    assert.equal(last.tool_choice, 'none');
    assert.ok(Array.isArray(last.tools) && last.tools.length > 0, 'tool_choice is only sent together with tool definitions');
    assert.ok(JSON.stringify(last.messages).includes('Stop retrieving'));
    assert.equal(h.tools(), 2, 'tool calls emitted on the closing turn are never executed');
    assert.equal(h.host.get(h.id).view.run?.status, 'completed');
  } finally {await h.close()}
});

test('parallel tool calls beyond the budget are refused softly instead of aborting the reply', async () => {
  const h = await harness(() => 'parallel');
  try {
    const reply = await h.send('请查一下作品里的人物，再回答。');
    assert.equal(reply.status, 'completed', reply.errorCode);
    assert.equal(h.tools(), 3, 'only maxToolCalls lookups reach the story service');
    assert.equal(h.payloads.at(-1)?.tool_choice, 'none', 'the turn after the budget is spent is a closing turn');
  } finally {await h.close()}
});

test('ordinary discussion without data scopes is one call per message, ten rounds in a row', async () => {
  const h = await harness(() => 'stubborn', {}, []);
  try {
    for (let i = 0; i < 10; i++) {
      // Even a model that would love to call tools gets none offered and answers in prose.
      const m = await h.send(i ? `继续第 ${i} 轮：人物的另一种选择` : question, 'k' + i);
      assert.equal(m.status, 'completed', m.errorCode);
    }
    assert.equal(h.payloads.length, 10);
    assert.ok(h.payloads.every(p => !(p.tools ?? []).length && p.tool_choice === undefined));
    assert.equal(h.tools(), 0);
    assert.equal(h.host.get(h.id).view.messages.length, 20);
  } finally {await h.close()}
});

test('discussion-memory summaries do not consume the reply turns', async () => {
  // Small input budget forces compaction; two reply turns remain for tool + answer.
  const h = await harness(() => 'one-tool', {maxTurnsPerRequest: 2, maxInputTokens: 16000});
  try {
    h.setScopes([]);
    for (let i = 0; i < 6; i++) {
      const m = await h.send(`第 ${i} 轮：张居正在平行宇宙里面对改革与私德的冲突。`.repeat(8));
      assert.equal(m.status, 'completed', m.errorCode);
    }
    h.setScopes(['knowledge']);
    const before = h.payloads.length;
    const reply = await h.send('查一下作品资料，再告诉我张居正这个人物应该怎样取舍。'.repeat(4));
    assert.equal(reply.status, 'completed', reply.errorCode);
    const run = h.payloads.slice(before);
    const memory = run.filter(p => JSON.stringify(p.messages[0]).includes('Summarize the quoted discussion'));
    assert.ok(memory.length >= 1, 'the long history was summarized');
    assert.ok(memory.every(p => !JSON.stringify(p.messages).includes('Stop retrieving')), 'summaries never receive the closing instruction');
    assert.equal(h.tools(), 1, 'the reply still had a turn for its lookup');
    assert.equal(run.length - memory.length, 2);
  } finally {await h.close()}
});

test('withoutToolCalls keeps prose and turns toolUse into a normal stop', () => {
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  const message = {role: 'assistant' as const, api: 'openai-completions' as const, provider: 'story2u', model: 'm', usage, timestamp: 0, stopReason: 'toolUse' as const,
    content: [{type: 'text' as const, text: answer}, {type: 'toolCall' as const, id: 'x', name: 'search_knowledge', arguments: {}}]};
  const clean = withoutToolCalls(message);
  assert.equal(clean.stopReason, 'stop');
  assert.deepEqual(clean.content, [{type: 'text', text: answer}]);
  assert.equal(withoutToolCalls(clean), clean);
});
