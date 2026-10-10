// A running Xenia's guest memory. Xenia reserves the Xbox 360's 4 GB virtual address space as one block of its
// own (by default at host 0x1_0000_0000), so guest address g is host base + g. The base is found by looking for
// the game's executable image, which a 360 title loads at 0x82000000 (an "MZ"/"PE" header).
import { readFileSync } from 'node:fs';
import { findProcesses, ProcessMemory, ProcessInfo } from './win32.js';

export const IMAGE_BASE = 0x82000000;
const GUEST_SIZE = 0x1_0000_0000n;

export type ValueType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'u64' | 's64' | 'f32' | 'f64' | 'vec3' | 'vec4';
export const SIZES: Record<ValueType, number> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, u64: 8, s64: 8, f32: 4, f64: 8, vec3: 12, vec4: 16 };

/** Decodes one big-endian value. */
export function decode(b: Buffer, off: number, t: ValueType): number | string | number[] {
  switch (t) {
    case 'u8': return b.readUInt8(off);
    case 's8': return b.readInt8(off);
    case 'u16': return b.readUInt16BE(off);
    case 's16': return b.readInt16BE(off);
    case 'u32': return b.readUInt32BE(off);
    case 's32': return b.readInt32BE(off);
    case 'u64': return b.readBigUInt64BE(off).toString();
    case 's64': return b.readBigInt64BE(off).toString();
    case 'f32': return b.readFloatBE(off);
    case 'f64': return b.readDoubleBE(off);
    case 'vec3': return [0, 1, 2].map(i => b.readFloatBE(off + 4 * i));
    case 'vec4': return [0, 1, 2, 3].map(i => b.readFloatBE(off + 4 * i));
  }
}

/** Encodes one big-endian value from a number (or a list of floats for vectors). */
export function encode(t: ValueType, v: number | string | number[]): Buffer {
  const b = Buffer.alloc(SIZES[t]);
  const n = (x: unknown) => Number(x);
  switch (t) {
    case 'u8': b.writeUInt8(n(v) & 0xff); break;
    case 's8': b.writeInt8(n(v)); break;
    case 'u16': b.writeUInt16BE(n(v) & 0xffff); break;
    case 's16': b.writeInt16BE(n(v)); break;
    case 'u32': b.writeUInt32BE(n(v) >>> 0); break;
    case 's32': b.writeInt32BE(n(v)); break;
    case 'u64': b.writeBigUInt64BE(BigInt(v as string)); break;
    case 's64': b.writeBigInt64BE(BigInt(v as string)); break;
    case 'f32': b.writeFloatBE(n(v)); break;
    case 'f64': b.writeDoubleBE(n(v)); break;
    case 'vec3': case 'vec4': {
      const a = v as number[];
      if (!Array.isArray(a) || a.length !== SIZES[t] / 4) throw new Error(`${t} needs ${SIZES[t] / 4} numbers`);
      a.forEach((x, i) => b.writeFloatBE(x, 4 * i));
    }
  }
  return b;
}

/** "DE AD ?? EF" -> bytes and a mask. */
export function parsePattern(p: string): { bytes: number[]; mask: boolean[] } {
  const parts = p.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('empty pattern');
  const bytes: number[] = [], mask: boolean[] = [];
  for (const s of parts) {
    if (s === '??' || s === '?') { bytes.push(0); mask.push(false); continue; }
    if (!/^[0-9a-fA-F]{2}$/.test(s)) throw new Error(`bad pattern byte "${s}"`);
    bytes.push(parseInt(s, 16)); mask.push(true);
  }
  return { bytes, mask };
}

export function findAll(hay: Buffer, pat: { bytes: number[]; mask: boolean[] }, limit: number): number[] {
  const hits: number[] = [];
  const n = pat.bytes.length;
  const first = pat.mask.indexOf(true);
  for (let i = 0; i + n <= hay.length && hits.length < limit; i++) {
    if (first >= 0) {
      i = hay.indexOf(pat.bytes[first], i + first) - first;
      if (i < 0 || i + n > hay.length) break;
    }
    let ok = true;
    for (let k = 0; k < n; k++) if (pat.mask[k] && hay[i + k] !== pat.bytes[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}

export function hexdump(addr: number, b: Buffer): string {
  const lines: string[] = [];
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16);
    const hex = [...row].map(x => x.toString(16).padStart(2, '0')).join(' ');
    const asc = [...row].map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${(addr + o >>> 0).toString(16).toUpperCase().padStart(8, '0')}  ${hex.padEnd(47)}  ${asc}`);
  }
  return lines.join('\n');
}

export interface Snapshot { addr: number; data: Buffer; }

export class XeniaSession {
  readonly snapshots = new Map<string, Snapshot>();
  readonly freezes = new Map<number, { type: ValueType; value: Buffer; timer: NodeJS.Timeout }>();

  private constructor(readonly proc: ProcessInfo, readonly mem: ProcessMemory, readonly base: bigint, readonly imageCheck: string) {}

  /** Attaches to Xenia (or the process given) and finds where the guest's 4 GB sit. */
  static connect(opts: { pid?: number; name?: string; base?: bigint; image?: string }): XeniaSession {
    let proc: ProcessInfo | undefined;
    if (opts.pid) {
      proc = findProcesses(/./).find(p => p.pid === opts.pid) ?? { pid: opts.pid, name: '?' };
    } else {
      const list = findProcesses(new RegExp(opts.name ?? '^xenia', 'i'));
      if (!list.length) throw new Error(`no running process matches ${opts.name ?? 'xenia*'}: start Xenia with the game first`);
      proc = list[0];
    }
    const mem = new ProcessMemory(proc.pid);
    try {
      const base = opts.base ?? XeniaSession.findBase(mem);
      if (base === null) throw new Error('could not find the guest memory: no MZ/PE image at guest 0x82000000 under any 4 GB-aligned host base (is a game running?)');
      return new XeniaSession(proc, mem, base, XeniaSession.checkImage(mem, base, opts.image));
    } catch (e) {
      mem.close();
      throw e;
    }
  }

  /** Tries the default base, then every 4 GB-aligned base up to 1 TB. */
  static findBase(mem: ProcessMemory): bigint | null {
    const looks = (base: bigint) => {
      try {
        const h = mem.read(base + BigInt(IMAGE_BASE), 0x100);
        if (h.toString('latin1', 0, 2) !== 'MZ') return false;
        const pe = h.readUInt32LE(0x3c);
        const sig = mem.read(base + BigInt(IMAGE_BASE + pe), 4);
        return sig.toString('latin1') === 'PE\0\0';
      } catch { return false; }
    };
    for (let k = 1n; k <= 256n; k++) if (looks(k * GUEST_SIZE)) return k * GUEST_SIZE;
    return null;
  }

  /** Compares the loaded image's first pages with a reference image file (e.g. the TU8 image.bin), if given. */
  static checkImage(mem: ProcessMemory, base: bigint, image?: string): string {
    if (!image) return 'no reference image given (set XENIA_MCP_IMAGE to compare the running build with yours)';
    let ref: Buffer;
    try { ref = readFileSync(image); } catch (e) { return `reference image unreadable: ${(e as Error).message}`; }
    let same = 0, total = 0;
    for (const off of [0x0, 0x1000, 0x140000, 0x200000, 0x400000, 0x800000]) {
      if (off + 0x100 > ref.length) continue;
      total++;
      try { if (mem.read(base + BigInt(IMAGE_BASE + off), 0x100).equals(ref.subarray(off, off + 0x100))) same++; } catch { /* unmapped */ }
    }
    return `${same} of ${total} sampled pages match ${image}`;
  }

  close(): void {
    for (const f of this.freezes.values()) clearInterval(f.timer);
    this.freezes.clear();
    this.mem.close();
  }

  private host(addr: number, size: number): bigint {
    if (!Number.isInteger(addr) || addr < 0 || addr + size > 0x1_0000_0000) throw new Error(`guest range 0x${addr.toString(16)} + ${size} is outside 32 bits`);
    return this.base + BigInt(addr);
  }

  read(addr: number, size: number): Buffer {
    return this.mem.read(this.host(addr, size), size);
  }

  write(addr: number, data: Buffer): void {
    this.mem.write(this.host(addr, data.length), data);
  }

  readValues(addr: number, t: ValueType, count: number) {
    const b = this.read(addr, SIZES[t] * count);
    return Array.from({ length: count }, (_, i) => decode(b, i * SIZES[t], t));
  }

  readString(addr: number, max: number, utf16: boolean): string {
    const b = this.read(addr, utf16 ? max * 2 : max);
    if (utf16) {
      let s = '';
      for (let i = 0; i + 1 < b.length; i += 2) {
        const c = b.readUInt16BE(i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    const end = b.indexOf(0);
    return b.toString('latin1', 0, end < 0 ? b.length : end);
  }

  /** Follows 32-bit pointers: read at addr, add the next offset, read again ...; returns each step. */
  followPointers(addr: number, offsets: number[]): { at: number; value: number }[] {
    const steps: { at: number; value: number }[] = [];
    let at = addr;
    for (let i = 0; i <= offsets.length; i++) {
      const value = this.read(at, 4).readUInt32BE(0);
      steps.push({ at, value });
      if (i === offsets.length) break;
      if (!value) throw new Error(`null pointer at 0x${at.toString(16)} (step ${i})`);
      at = (value + offsets[i]) >>> 0;
    }
    return steps;
  }

  /** Committed guest regions between `lo` and `hi`. */
  regions(lo: number, hi: number) {
    return this.mem.regions(this.base + BigInt(lo), this.base + BigInt(hi)).map(r => {
      const start = Number(r.base - this.base), end = Number(r.base + r.size - this.base);
      return { start: Math.max(start, lo), end: Math.min(end, hi), protect: r.protect };
    }).filter(r => r.end > r.start);
  }

  findPattern(pattern: string, lo: number, hi: number, limit: number): number[] {
    const pat = parsePattern(pattern);
    const hits: number[] = [];
    for (const r of this.regions(lo, hi)) {
      for (let a = r.start; a < r.end && hits.length < limit; a += 0x400000) {
        const n = Math.min(0x400000 + pat.bytes.length - 1, r.end - a);
        let chunk: Buffer;
        try { chunk = this.read(a, n); } catch { continue; }
        for (const h of findAll(chunk, pat, limit - hits.length)) hits.push(a + h);
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  snapshot(name: string, addr: number, size: number): void {
    this.snapshots.set(name, { addr, data: this.read(addr, size) });
  }

  /** 32-bit words that changed since the snapshot (or, with `keep`, refresh it). */
  diff(name: string, limit: number, keep: boolean) {
    const s = this.snapshots.get(name);
    if (!s) throw new Error(`no snapshot named "${name}"`);
    const now = this.read(s.addr, s.data.length);
    const changes: { addr: number; old: number; now: number }[] = [];
    let count = 0;
    for (let o = 0; o + 4 <= now.length; o += 4) {
      const a = s.data.readUInt32BE(o), b = now.readUInt32BE(o);
      if (a !== b) { count++; if (changes.length < limit) changes.push({ addr: s.addr + o, old: a, now: b }); }
    }
    if (!keep) this.snapshots.set(name, { addr: s.addr, data: now });
    return { count, changes };
  }

  freeze(addr: number, t: ValueType, v: number | string | number[], everyMs: number): void {
    this.unfreeze(addr);
    const value = encode(t, v);
    this.write(addr, value);
    const timer = setInterval(() => { try { this.write(addr, value); } catch { /* the game freed it */ } }, everyMs);
    this.freezes.set(addr, { type: t, value, timer });
  }

  unfreeze(addr: number): boolean {
    const f = this.freezes.get(addr);
    if (!f) return false;
    clearInterval(f.timer);
    this.freezes.delete(addr);
    return true;
  }
}
