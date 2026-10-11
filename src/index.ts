#!/usr/bin/env node
// xenia-mcp: an MCP server over a running Xenia's guest memory (and GTA IV's function index, when given).
// Environment: XENIA_MCP_IMAGE (a reference executable image to compare the running build with),
// GTA4_REPO (the large-steal-car-4 checkout), GTA4_DECOMP_DIR (the extracted decompiled C).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { XeniaSession, ValueType, SIZES, hexdump, encode, IMAGE_BASE } from './xenia.js';
import { Gta4Index, fnLine } from './gta4.js';
import { watch } from './watch.js';

const server = new McpServer({ name: 'xenia-mcp', version: '0.1.0' });
let session: XeniaSession | null = null;
let gta4: Gta4Index | null = null;

const Addr = z.union([z.number(), z.string()]).describe('Guest address: a number or a hex string like "0x82A9AB94"');
const Type = z.enum(['u8', 's8', 'u16', 's16', 'u32', 's32', 'u64', 's64', 'f32', 'f64', 'vec3', 'vec4']);

function addr(a: number | string): number {
  const n = typeof a === 'number' ? a : Number(a.trim().toLowerCase().startsWith('0x') ? a.trim() : `0x${a.trim()}`);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) throw new Error(`bad address ${a}`);
  return n >>> 0;
}
const hx = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });
function need(): XeniaSession {
  if (!session) throw new Error('not connected: call xenia_connect first');
  return session;
}
function index(): Gta4Index {
  gta4 ??= new Gta4Index(process.env.GTA4_REPO, process.env.GTA4_DECOMP_DIR);
  return gta4;
}
/** "0x823B3DF8 CEntity::vf32 +0x10" for an address in code. */
function where(a: number): string {
  const f = index().at(a);
  return f ? ` (${f.name || f.cls || 'fn'} 0x${f.address.toString(16).toUpperCase()}+0x${(a - f.address).toString(16)})` : '';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;
function tool(name: string, description: string, shape: z.ZodRawShape, run: (args: Args) => string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, { description, inputSchema: shape }, async (args: Args) => {
    try { return ok(run(args)); } catch (e) { return fail(e); }
  });
}

tool('xenia_connect', 'Attach to a running Xenia (the first process named xenia*, or the pid given) and find the guest memory.', {
  pid: z.number().optional().describe('Process id, if not the first xenia* process'),
  name: z.string().optional().describe('Process name regex (default ^xenia)'),
  base: z.string().optional().describe('Host address of guest 0 if auto-detection fails, e.g. "0x100000000"'),
}, a => {
  session?.close();
  session = XeniaSession.connect({ pid: a.pid, name: a.name, base: a.base ? BigInt(a.base) : undefined, image: process.env.XENIA_MCP_IMAGE });
  return `Attached to ${session.proc.name} (pid ${session.proc.pid}); guest memory at host 0x${session.base.toString(16)}; ` +
    `executable image at ${hx(IMAGE_BASE)}. ${session.imageCheck}. ${index().describe()}.`;
});

tool('xenia_status', 'Connection, snapshots and frozen values.', {}, () => {
  if (!session) return `Not connected. ${index().describe()}.`;
  const fz = [...session.freezes.entries()].map(([a, f]) => `${hx(a)} ${f.type}`).join(', ') || 'none';
  return `Attached to ${session.proc.name} (pid ${session.proc.pid}), guest at host 0x${session.base.toString(16)}. ` +
    `Snapshots: ${[...session.snapshots.keys()].join(', ') || 'none'}. Frozen: ${fz}.`;
});

tool('xenia_disconnect', 'Detach (stops every freeze).', {}, () => {
  session?.close();
  session = null;
  return 'Detached.';
});

tool('xenia_read_memory', 'Hex dump of guest memory.', { address: Addr, size: z.number().int().min(1).max(0x10000) }, a => {
  const at = addr(a.address);
  return hexdump(at, need().read(at, a.size));
});

tool('xenia_read_values', 'Read big-endian values (the 360 is big-endian): u8..u64, f32, f64, vec3, vec4.', {
  address: Addr, type: Type, count: z.number().int().min(1).max(1024).default(1),
}, a => {
  const at = addr(a.address);
  const vals = need().readValues(at, a.type as ValueType, a.count);
  return vals.map((v, i) => {
    const p = at + i * SIZES[a.type as ValueType];
    const extra = a.type === 'u32' && typeof v === 'number' && v >= 0x82000000 && v < 0x83000000 ? where(v) : '';
    return `${hx(p)}: ${Array.isArray(v) ? v.map(x => x.toFixed(4)).join(', ') : typeof v === 'number' && a.type.startsWith('u') ? `${v} (0x${v.toString(16).toUpperCase()})` : v}${extra}`;
  }).join('\n');
});

tool('xenia_write_memory', 'Write raw bytes (hex, e.g. "3F 80 00 00") to guest memory.', { address: Addr, hex: z.string() }, a => {
  const bytes = Buffer.from(a.hex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  if (!bytes.length) throw new Error('no bytes');
  need().write(addr(a.address), bytes);
  return `Wrote ${bytes.length} bytes at ${hx(addr(a.address))}.`;
});

tool('xenia_write_value', 'Write one big-endian value.', {
  address: Addr, type: Type, value: z.union([z.number(), z.string(), z.array(z.number())]),
}, a => {
  need().write(addr(a.address), encode(a.type as ValueType, a.value as number));
  return `Wrote ${a.type} ${JSON.stringify(a.value)} at ${hx(addr(a.address))}.`;
});

tool('xenia_read_string', 'Read a NUL-terminated string (ASCII or big-endian UTF-16).', {
  address: Addr, max: z.number().int().min(1).max(4096).default(256), utf16: z.boolean().default(false),
}, a => JSON.stringify(need().readString(addr(a.address), a.max, a.utf16)));

tool('xenia_follow_pointers', 'Follow a chain of 32-bit pointers: read at address, add offsets[0], read, ...', {
  address: Addr, offsets: z.array(z.union([z.number(), z.string()])).default([]),
}, a => need().followPointers(addr(a.address), a.offsets.map((o: number | string) => addr(o))).map((s, i) => `${i}: [${hx(s.at)}] = ${hx(s.value)}${where(s.value)}`).join('\n'));

tool('xenia_find_pattern', 'Search guest memory for bytes ("DE AD ?? EF", ?? any byte).', {
  pattern: z.string(), start: Addr.default('0x40000000'), end: Addr.default('0xA0000000'), limit: z.number().int().min(1).max(1000).default(50),
}, a => {
  const hits = need().findPattern(a.pattern, addr(a.start), addr(a.end), a.limit);
  return hits.length ? `${hits.length} hit(s):\n${hits.map(h => hx(h) + where(h)).join('\n')}` : 'No hits.';
});

tool('xenia_regions', 'Committed guest memory regions in a range.', { start: Addr.default('0'), end: Addr.default('0xFFFFFFFF') }, a => {
  const rs = need().regions(addr(a.start), addr(a.end));
  return rs.slice(0, 400).map(r => `${hx(r.start)}-${hx(r.end - 1)} ${((r.end - r.start) / 1024).toFixed(0)} KB protect 0x${r.protect.toString(16)}`).join('\n') +
    (rs.length > 400 ? `\n... ${rs.length - 400} more` : '');
});

tool('xenia_snapshot', 'Remember a block of memory under a name, to diff later.', {
  name: z.string(), address: Addr, size: z.number().int().min(4).max(0x1000000),
}, a => {
  need().snapshot(a.name, addr(a.address), a.size);
  return `Snapshot "${a.name}": ${a.size} bytes at ${hx(addr(a.address))}.`;
});

tool('xenia_diff', 'The 32-bit words that changed since a snapshot (the snapshot is then refreshed unless keep is true).', {
  name: z.string(), limit: z.number().int().min(1).max(5000).default(100), keep: z.boolean().default(false),
}, a => {
  const d = need().diff(a.name, a.limit, a.keep);
  return `${d.count} word(s) changed${d.count > d.changes.length ? ` (first ${d.changes.length})` : ''}:\n` +
    d.changes.map(c => `${hx(c.addr)}: ${hx(c.old)} -> ${hx(c.now)}  (f32 ${Buffer.from(c.old.toString(16).padStart(8, '0'), 'hex').readFloatBE(0).toPrecision(6)} -> ${Buffer.from(c.now.toString(16).padStart(8, '0'), 'hex').readFloatBE(0).toPrecision(6)})`).join('\n');
});

tool('xenia_freeze', 'Hold a value: write it now and again every interval (until unfrozen or detached).', {
  address: Addr, type: Type, value: z.union([z.number(), z.string(), z.array(z.number())]), every_ms: z.number().int().min(1).max(10000).default(16),
}, a => {
  need().freeze(addr(a.address), a.type as ValueType, a.value as number, a.every_ms);
  return `Holding ${a.type} ${JSON.stringify(a.value)} at ${hx(addr(a.address))} every ${a.every_ms} ms.`;
});

tool('xenia_unfreeze', 'Stop holding a value.', { address: Addr }, a => need().unfreeze(addr(a.address)) ? 'Released.' : 'Nothing was held there.');

tool('gta4_lookup', 'GTA IV TU8: the function holding an address, or functions whose name or class contains a text.', {
  address: Addr.optional(), text: z.string().optional(), limit: z.number().int().min(1).max(200).default(20),
}, a => {
  if (a.address !== undefined) {
    const f = index().at(addr(a.address));
    return f ? fnLine(f) : `No indexed function holds ${hx(addr(a.address))}. ${index().describe()}.`;
  }
  if (!a.text) throw new Error('give an address or a text');
  const list = index().search(a.text, a.limit);
  return list.length ? list.map(fnLine).join('\n') : 'No match.';
});

tool('gta4_decompiled', 'GTA IV TU8: the decompiled C of the function holding an address.', { address: Addr }, a => {
  const at = addr(a.address);
  const f = index().at(at);
  const src = index().decompiled(f ? f.address : at);
  if (!src) return `No decompiled C for ${hx(at)}. ${index().describe()}.`;
  return (f ? `// ${fnLine(f)}\n` : '') + src;
});

tool('xenia_watch', 'Data watchpoint: count every access (or every write) to a guest address for a while, and name the guest ' +
  'functions that made them. Uses native/xwatch.exe, which attaches to Xenia as a debugger for that time (the game ' +
  'slows while watched) and detaches again; Xenia is not stopped or killed.', {
  address: Addr,
  length: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).default(4)
    .describe('Bytes watched: 1, 2, 4 or 8 (the address must be aligned to it)'),
  mode: z.enum(['rw', 'w']).default('rw').describe('rw: reads and writes; w: writes only'),
  ms: z.number().int().min(100).max(60000).default(2000).describe('How long to watch, in milliseconds'),
}, a => {
  const at = addr(a.address);
  const r = watch(need(), at, a.length, a.mode, a.ms, index().all());
  const lines = r.hits.map(h => {
    const f = h.fn;
    const name = f ? `${f.name || f.cls || 'fn'} ${hx(f.address)}` : '(not an indexed function: host or kernel code)';
    return `${String(h.count).padStart(7)}  host 0x${h.rip.toString(16)}  ${name}`;
  });
  return `${r.total} hits on ${hx(at)} (${a.length} bytes, ${a.mode}) in ${a.ms} ms, ${r.hits.length} sites, ` +
    `${r.threads} threads watched; ${r.compiled} compiled guest functions mapped.\n` + (lines.join('\n') || '(no access)');
});

await server.connect(new StdioServerTransport());
