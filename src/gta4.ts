// GTA IV (TU8) knowledge from the large-steal-car-4 repo: its function index (rust/docs/function-index/functions.csv)
// and, if extracted, the whole-exe decompiled C (<dir>/<system>/<ADDR>.c).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Fn { address: number; size: number; cls: string; name: string; system: string; from: string; callers: number; status: string; }

export class Gta4Index {
  private fns: Fn[] = [];
  private decomp = new Map<number, string>();

  constructor(readonly repo?: string, readonly decompDir?: string) {
    const csv = repo ? join(repo, 'rust', 'docs', 'function-index', 'functions.csv') : '';
    if (csv && existsSync(csv)) {
      const lines = readFileSync(csv, 'utf8').split(/\r?\n/);
      const head = parseCsvLine(lines[0]);
      const col = (n: string) => head.indexOf(n);
      for (const line of lines.slice(1)) {
        if (!line) continue;
        const c = parseCsvLine(line);
        this.fns.push({
          address: parseInt(c[col('address')], 16), size: Number(c[col('size')]), cls: c[col('class')], name: c[col('name')],
          system: c[col('system')], from: c[col('system_from')], callers: Number(c[col('callers')]), status: c[col('status')],
        });
      }
      this.fns.sort((a, b) => a.address - b.address);
    }
    if (decompDir && existsSync(decompDir)) {
      for (const sys of readdirSync(decompDir, { withFileTypes: true })) {
        if (!sys.isDirectory()) continue;
        for (const f of readdirSync(join(decompDir, sys.name))) {
          const m = /^([0-9A-F]{8})\.c$/i.exec(f);
          if (m) this.decomp.set(parseInt(m[1], 16), join(decompDir, sys.name, f));
        }
      }
    }
  }

  describe(): string {
    return `${this.fns.length} functions indexed${this.repo ? ` (${this.repo})` : ' (set GTA4_REPO)'}, ` +
      `${this.decomp.size} decompiled${this.decompDir ? ` (${this.decompDir})` : ' (set GTA4_DECOMP_DIR)'}`;
  }

  /** Every indexed function, by address. */
  all(): Fn[] { return this.fns; }

  /** The function holding `addr`. */
  at(addr: number): Fn | null {
    let lo = 0, hi = this.fns.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.fns[mid].address <= addr) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const f = best >= 0 ? this.fns[best] : null;
    return f && addr < f.address + f.size ? f : null;
  }

  search(text: string, limit: number): Fn[] {
    const t = text.toLowerCase();
    return this.fns.filter(f => f.name.toLowerCase().includes(t) || f.cls.toLowerCase().includes(t)).slice(0, limit);
  }

  decompiled(addr: number): string | null {
    const p = this.decomp.get(addr);
    return p ? readFileSync(p, 'utf8') : null;
  }
}

export function fnLine(f: Fn): string {
  const label = f.name || f.cls || '(unnamed)';
  return `0x${f.address.toString(16).toUpperCase()} +${f.size} ${label} [${f.system || 'no system'}${f.from ? ` by ${f.from}` : ''}] ${f.callers} callers, ${f.status}`;
}

function parseCsvLine(s: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
