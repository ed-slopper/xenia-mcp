// Data watchpoints on guest memory, through the native helper native/xwatch.exe (a debugger that sets a
// hardware data breakpoint on the field's host address), and the mapping of the hits back to guest functions.
//
// The mapping uses Xenia's own indirection table: for every guest function address `a`, the 32-bit word at
// HOST address `a` (little-endian) is the host address of that function's JIT code (or of a resolve thunk while
// it has not been compiled yet). A hit's instruction address is then inside the compiled function whose code
// starts nearest below it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { XeniaSession } from './xenia.js';
import type { Fn } from './gta4.js';

export interface WatchHit { rip: bigint; count: number; fn: Fn | null; guest: number | null; }
export interface WatchResult { total: number; threads: number; hits: WatchHit[]; compiled: number; }

/** The helper: XWATCH_EXE, or native/xwatch.exe next to the package. */
export function xwatchPath(): string {
  if (process.env.XWATCH_EXE) return process.env.XWATCH_EXE;
  const here = dirname(fileURLToPath(import.meta.url));            // dist/src
  return join(here, '..', '..', 'native', 'xwatch.exe');
}

export function watch(session: XeniaSession, guest: number, length: number, mode: 'w' | 'rw', ms: number,
                      fns: Fn[]): WatchResult {
  const exe = xwatchPath();
  if (!existsSync(exe)) throw new Error(`watch helper not found at ${exe} (build native/xwatch.c, see README)`);
  if (guest % length !== 0) throw new Error(`the address must be aligned to the length (${length})`);
  const host = session.base + BigInt(guest);
  const out = execFileSync(exe, [String(session.proc.pid), host.toString(16), String(length), mode, String(ms)],
    { encoding: 'utf8', windowsHide: true, timeout: ms + 30000 });
  const raw: { rip: bigint; count: number }[] = [];
  let total = 0, threads = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^hit ([0-9a-f]+) (\d+)$/i.exec(line);
    if (m) raw.push({ rip: BigInt('0x' + m[1]), count: Number(m[2]) });
    const t = /^total (\d+)$/.exec(line); if (t) total = Number(t[1]);
    const th = /^threads (\d+)$/.exec(line); if (th) threads = Number(th[1]);
  }
  const map = jitMap(session, fns);
  const hits = raw.map(h => {
    const f = map.lookup(h.rip);
    return { rip: h.rip, count: h.count, fn: f, guest: f ? f.address : null };
  }).sort((a, b) => b.count - a.count);
  return { total, threads, hits, compiled: map.size };
}

/** Host code start -> guest function, for every indexed function Xenia has compiled. */
function jitMap(session: XeniaSession, fns: Fn[]) {
  const entries: { code: number; fn: Fn }[] = [];
  if (fns.length) {
    const lo = (fns[0].address & ~0xfff) >>> 0, hi = fns[fns.length - 1].address + 4;
    const pages = session.mem.readPages(BigInt(lo), hi - lo);
    const word = (a: number): number | null => {
      const p = pages[(a - lo) >> 12];
      return p ? p.readUInt32LE((a - lo) & 0xfff) : null;
    };
    const values = new Map<number, number>();
    const raw: { code: number; fn: Fn }[] = [];
    for (const f of fns) {
      const v = word(f.address);
      if (v === null || v === 0) continue;
      raw.push({ code: v, fn: f });
      values.set(v, (values.get(v) ?? 0) + 1);
    }
    // Functions not compiled yet all point at the same resolve thunk.
    let thunk = -1, most = 0;
    for (const [v, n] of values) if (n > most) { most = n; thunk = v; }
    for (const e of raw) if (e.code !== thunk) entries.push(e);
    entries.sort((a, b) => a.code - b.code);
  }
  return {
    size: entries.length,
    lookup(rip: bigint): Fn | null {
      if (rip > 0xffffffffn) return null;
      const r = Number(rip);
      let lo = 0, hi = entries.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].code <= r) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best >= 0 ? entries[best].fn : null;
    },
  };
}
