// Windows process memory access through koffi (no native build): open a process, read, write and walk its
// committed regions.
import koffi from 'koffi';
import { execFileSync } from 'node:child_process';

const kernel32 = koffi.load('kernel32.dll');

const PROCESS_VM_READ = 0x0010;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_QUERY_INFORMATION = 0x0400;
export const MEM_COMMIT = 0x1000;

const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uint64',
  AllocationBase: 'uint64',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  RegionSize: 'uint64',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
});

const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
const ReadProcessMemory = kernel32.func(
  'bool __stdcall ReadProcessMemory(void *h, uint64_t addr, void *buf, size_t size, _Out_ size_t *done)');
const WriteProcessMemory = kernel32.func(
  'bool __stdcall WriteProcessMemory(void *h, uint64_t addr, void *buf, size_t size, _Out_ size_t *done)');
const VirtualQueryEx = kernel32.func(
  'size_t __stdcall VirtualQueryEx(void *h, uint64_t addr, _Out_ MEMORY_BASIC_INFORMATION *info, size_t size)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

export interface ProcessInfo { pid: number; name: string; }

/** Running processes whose image name matches `pattern` (case-insensitive), from tasklist. */
export function findProcesses(pattern: RegExp): ProcessInfo[] {
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const list: ProcessInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m && pattern.test(m[1])) list.push({ name: m[1], pid: Number(m[2]) });
  }
  return list;
}

export interface Region { base: bigint; size: bigint; protect: number; }

export class ProcessMemory {
  private handle: unknown;

  constructor(readonly pid: number, writable = true) {
    const access = PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | (writable ? PROCESS_VM_WRITE | PROCESS_VM_OPERATION : 0);
    this.handle = OpenProcess(access, false, pid);
    if (!this.handle) throw new Error(`OpenProcess(${pid}) failed: error ${GetLastError()}`);
  }

  close(): void {
    if (this.handle) CloseHandle(this.handle);
    this.handle = null;
  }

  /** Reads `size` bytes at host address `addr`; throws when any of it cannot be read. */
  read(addr: bigint, size: number): Buffer {
    const buf = Buffer.alloc(size);
    const done = [0];
    if (!ReadProcessMemory(this.handle, addr, buf, size, done) || done[0] !== size) {
      throw new Error(`cannot read ${size} bytes at host 0x${addr.toString(16)} (error ${GetLastError()})`);
    }
    return buf;
  }

  /** Reads what can be read, page by page; unreadable pages come back as null. */
  readPages(addr: bigint, size: number): (Buffer | null)[] {
    const pages: (Buffer | null)[] = [];
    for (let off = 0; off < size; off += 0x1000) {
      const n = Math.min(0x1000, size - off);
      try { pages.push(this.read(addr + BigInt(off), n)); } catch { pages.push(null); }
    }
    return pages;
  }

  write(addr: bigint, data: Buffer): void {
    const done = [0];
    if (!WriteProcessMemory(this.handle, addr, data, data.length, done) || done[0] !== data.length) {
      throw new Error(`cannot write ${data.length} bytes at host 0x${addr.toString(16)} (error ${GetLastError()})`);
    }
  }

  /** The region holding `addr`, or null past the end of the address space. */
  query(addr: bigint): (Region & { state: number }) | null {
    const info: Record<string, bigint | number> = {};
    if (!VirtualQueryEx(this.handle, addr, info, koffi.sizeof(MEMORY_BASIC_INFORMATION))) return null;
    return { base: BigInt(info.BaseAddress), size: BigInt(info.RegionSize), protect: Number(info.Protect), state: Number(info.State) };
  }

  /** Committed regions from `lo` to `hi`. */
  regions(lo: bigint, hi: bigint): Region[] {
    const list: Region[] = [];
    let addr = lo;
    while (addr < hi) {
      const r = this.query(addr);
      if (!r || r.size === 0n) break;
      if (r.state === MEM_COMMIT) list.push({ base: r.base, size: r.size, protect: r.protect });
      addr = r.base + r.size;
    }
    return list;
  }
}
