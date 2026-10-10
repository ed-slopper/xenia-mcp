// A stand-in for Xenia in the tests: maps guest memory where Xenia does (host 0x1_0000_0000 + guest address),
// puts an executable image at guest 0x82000000 and a data page at 0x40000000, then waits to be read.
// Usage: node fake-xenia.js <image file>
import koffi from 'koffi';
import { readFileSync } from 'node:fs';

const kernel32 = koffi.load('kernel32.dll');
const VirtualAlloc = kernel32.func('uint64_t __stdcall VirtualAlloc(uint64_t addr, size_t size, uint32_t type, uint32_t protect)');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(uint64_t dst, void *src, size_t size)');
const MEM_COMMIT_RESERVE = 0x3000, PAGE_READWRITE = 0x04;
const BASE = 0x1_0000_0000n;

function map(guest: number, data: Buffer): void {
  const at = BASE + BigInt(guest);
  const got = VirtualAlloc(at, data.length, MEM_COMMIT_RESERVE, PAGE_READWRITE);
  if (BigInt(got) !== at) throw new Error(`VirtualAlloc at 0x${at.toString(16)} gave 0x${BigInt(got).toString(16)}`);
  RtlMoveMemory(at, data, data.length);
}

const image = readFileSync(process.argv[2]).subarray(0, 0x900000);
map(0x82000000, Buffer.from(image));
const page = Buffer.alloc(0x2000);
page.writeUInt32BE(0xDEADBEEF, 0x10);
page.writeFloatBE(1.5, 0x20);
page.writeUInt32BE(0x40000100, 0x30);       // a pointer to 0x40000100
page.writeUInt32BE(0x82140000, 0x100 + 8);  // +8 there: a pointer into code
Buffer.from('Liberty City\0', 'latin1').copy(page, 0x200);
map(0x40000000, page);
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
