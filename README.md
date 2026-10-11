# xenia-mcp

An MCP server that lets an AI assistant read and write the memory of a game running in
[Xenia](https://xenia.jp/) (the Xbox 360 emulator), with GTA IV helpers for the
large-steal-car-4 port: any address can be looked up in the port's function index and decompiled C.

It works with a stock Xenia: no patched build. Xenia reserves the 360's 4 GB guest address space as one block
of its own memory (normally at host `0x1_0000_0000`), so guest address `g` is `base + g`. The server attaches
to the Xenia process with the Windows debugging APIs (ReadProcessMemory / WriteProcessMemory) and finds the
base by looking for the game's executable image, which a 360 title loads at `0x82000000`.

It can also watch a guest address with a hardware data breakpoint (`xenia_watch`): the small native helper
`native/xwatch.exe` attaches to Xenia as a debugger for the time asked, counts every access to the field,
and detaches again. Each access is named by the guest function that made it, through Xenia's own
indirection table (at host address `a`, the 32-bit word is the host address of guest function `a`'s compiled
code). Code breakpoints, registers and stepping are still to come.

```
AI assistant  <-- stdio (MCP) -->  xenia-mcp (Node)  <-- ReadProcessMemory -->  xenia_canary.exe
```

## Setup

Needs Windows, Node.js 18 or later, and Xenia (Canary) with your own copy of the game.

```bash
npm install
npm run build
```

Add it to Claude Code (in the folder you work from):

```bash
claude mcp add xenia --env GTA4_REPO="D:/code/modding/gta 4/agent 5" --env GTA4_DECOMP_DIR="D:/path/to/dcout8" --env XENIA_MCP_IMAGE="D:/path/to/image.bin" -- node "D:/code/modding/gta 4/xenia-mcp/dist/src/index.js"
```

All three variables are optional:

| Variable | What for |
|---|---|
| `GTA4_REPO` | the large-steal-car-4 checkout: addresses are named from `rust/docs/function-index/functions.csv` |
| `GTA4_DECOMP_DIR` | the extracted `decompiled-tu8-exe.zip` (`dcout8/<system>/<ADDR>.c`): `gta4_decompiled` |
| `XENIA_MCP_IMAGE` | an executable image to compare with the running one (the TU8 `image.bin`): `xenia_connect` says whether the game in Xenia is that build |

Then start Xenia, load the game, and ask the assistant to connect.

## Tools

| Tool | What it does |
|---|---|
| `xenia_connect` | attach to the first `xenia*` process (or a pid) and find the guest memory |
| `xenia_status`, `xenia_disconnect` | the session, its snapshots and frozen values |
| `xenia_read_memory` | hex dump |
| `xenia_read_values` | big-endian u8 to u64, f32, f64, vec3, vec4; values that point into the executable are named |
| `xenia_write_memory`, `xenia_write_value` | raw bytes or one value |
| `xenia_read_string` | ASCII or big-endian UTF-16 |
| `xenia_follow_pointers` | a chain of 32-bit pointers and offsets |
| `xenia_find_pattern` | bytes with `??` wildcards over the committed memory of a range |
| `xenia_regions` | committed guest regions |
| `xenia_snapshot`, `xenia_diff` | remember a block, then list the words that changed |
| `xenia_freeze`, `xenia_unfreeze` | hold a value |
| `gta4_lookup` | the TU8 function holding an address, or functions by name or class |
| `gta4_decompiled` | the decompiled C of the function holding an address |
| `xenia_watch` | a data watchpoint: every read and write (or only writes) of a guest address for a few seconds, counted by the guest function that made it |

Example, checking the port's entity fade (board row R20a) against the game: find an entity, then
`xenia_read_values` on its `+0x63` byte a few times as it comes on screen: 0, 16, 32 ... 255.

## Tests

```bash
npm run build
node dist/test/run.js <image file> [large-steal-car-4 checkout]
```

The tests start `test/fake-xenia.ts`, which maps an image and a data page where Xenia keeps them, and run every
part against it, the MCP server included (over stdio, as an assistant would).

## License

MIT.

## The watch helper

`xenia_watch` needs `native/xwatch.exe` (or set `XWATCH_EXE`). Build it with the Visual Studio Build Tools
(`native/build.cmd` calls `vcvars64.bat`, then `cl /O2 xwatch.c`). It uses DR0 of every thread, so only one
watch at a time, and the game runs slowly while it is attached. Every single-step trap is handled by the helper
and never passed back to Xenia: an unhandled one kills Xenia. `native/xwatch_target.c` is a test program to
attach to and detach from many times (`build_target.cmd`).

A guest address only names the function once Xenia has compiled it; hits from Xenia's own host code (the
kernel, the GPU) show without a name.
