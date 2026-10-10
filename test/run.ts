// Tests against fake-xenia.js: the session layer directly, then the MCP server end to end over stdio.
// Usage: node dist/test/run.js <image file> [gta4 repo]
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { XeniaSession, findAll, parsePattern, encode, decode } from '../src/xenia.js';

const here = dirname(fileURLToPath(import.meta.url));
const image = process.argv[2] ?? process.env.XENIA_MCP_IMAGE;
if (!image) throw new Error('give the executable image to map (e.g. the TU8 image.bin)');
const repo = process.argv[3] ?? process.env.GTA4_REPO;
let passed = 0;
const check = (name: string, f: () => void) => { f(); passed++; console.log(`ok   ${name}`); };
const checkAsync = async (name: string, f: () => Promise<void>) => { await f(); passed++; console.log(`ok   ${name}`); };

// Pure helpers.
check('pattern parse and search', () => {
  const p = parsePattern('DE ?? BE EF');
  assert.deepEqual(findAll(Buffer.from([0, 0xde, 1, 0xbe, 0xef, 0xde, 2, 0xbe, 0xef]), p, 10), [1, 5]);
});
check('big-endian encode/decode', () => {
  assert.equal(decode(encode('f32', 1.5), 0, 'f32'), 1.5);
  assert.equal(decode(encode('s16', -2), 0, 's16'), -2);
  assert.deepEqual(decode(encode('vec3', [1, 2, 3]), 0, 'vec3'), [1, 2, 3]);
});

const fake = spawn(process.execPath, [join(here, 'fake-xenia.js'), image], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((res, rej) => {
  fake.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('ready')) res(); });
  fake.on('exit', c => rej(new Error(`fake-xenia exited ${c}`)));
});
try {
  const s = XeniaSession.connect({ pid: fake.pid!, image });
  check('finds the guest base', () => assert.equal(s.base, 0x1_0000_0000n));
  check('the image matches the reference', () => assert.match(s.imageCheck, /^(\d+) of \1 sampled/));
  check('reads the image header', () => assert.equal(s.read(0x82000000, 2).toString('latin1'), 'MZ'));
  check('reads values', () => {
    assert.deepEqual(s.readValues(0x40000010, 'u32', 1), [0xdeadbeef]);
    assert.deepEqual(s.readValues(0x40000020, 'f32', 1), [1.5]);
  });
  check('reads a string', () => assert.equal(s.readString(0x40000200, 64, false), 'Liberty City'));
  check('follows pointers', () => {
    const steps = s.followPointers(0x40000030, [8]);
    assert.deepEqual(steps.map(x => x.value), [0x40000100, 0x82140000]);
  });
  check('writes', () => {
    s.write(0x40000040, encode('f32', 255));
    assert.deepEqual(s.readValues(0x40000040, 'f32', 1), [255]);
  });
  check('finds a pattern', () => assert.deepEqual(s.findPattern('DE AD BE EF', 0x40000000, 0x40002000, 10), [0x40000010]));
  check('snapshot and diff', () => {
    s.snapshot('t', 0x40000000, 0x100);
    s.write(0x40000050, encode('u32', 7));
    const d = s.diff('t', 10, false);
    assert.equal(d.count, 1);
    assert.deepEqual(d.changes[0], { addr: 0x40000050, old: 0, now: 7 });
  });
  await checkAsync('freeze holds a value', async () => {
    s.freeze(0x40000060, 'u32', 42, 5);
    s.write(0x40000060, encode('u32', 1));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(s.readValues(0x40000060, 'u32', 1), [42]);
    assert.ok(s.unfreeze(0x40000060));
  });
  check('reports unmapped memory', () => assert.throws(() => s.read(0x50000000, 4), /cannot read/));
  s.close();

  // The MCP server itself, as a client would use it.
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(here, '..', 'src', 'index.js')],
    env: { ...process.env, XENIA_MCP_IMAGE: image, ...(repo ? { GTA4_REPO: repo } : {}) } as Record<string, string>,
  });
  const client = new Client({ name: 'xenia-mcp-test', version: '0' });
  await client.connect(transport);
  const text = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return r.content[0].text;
  };
  await checkAsync('MCP: lists the tools', async () => {
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const t of ['xenia_connect', 'xenia_read_values', 'xenia_find_pattern', 'xenia_diff', 'gta4_lookup']) assert.ok(tools.includes(t), t);
  });
  await checkAsync('MCP: connect', async () => assert.match(await text('xenia_connect', { pid: fake.pid }), /guest memory at host 0x100000000/));
  await checkAsync('MCP: read values', async () => assert.match(await text('xenia_read_values', { address: '0x40000010', type: 'u32' }), /0xDEADBEEF/));
  await checkAsync('MCP: hex dump', async () => assert.match(await text('xenia_read_memory', { address: '0x82000000', size: 16 }), /^82000000  4d 5a/));
  if (repo) {
    await checkAsync('MCP: GTA IV lookup of a pointer target', async () =>
      assert.match(await text('xenia_follow_pointers', { address: '0x40000030', offsets: ['8'] }), /0x82140000 \(/));
  }
  await client.close();
} finally {
  fake.kill();
}
console.log(`${passed} passed`);
