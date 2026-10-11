// xwatch: a hardware data watchpoint on a running process (built for Xenia, works on any x64 process).
//
//   xwatch <pid> <host address hex> <length 1|2|4|8> <w|rw> <milliseconds>
//
// Attaches as a debugger (the process is NOT killed when xwatch exits), puts the address in DR0 of every
// thread, and for the given time counts each access by the address of the instruction after it (a data
// breakpoint traps after the access). Then it clears DR0 / DR7 in every thread and detaches.
// Output, one line each: "hit <rip hex> <count>", then "total <n>", "threads <n>", "events <n>".
// Every exception that is not our single step is passed back to the process unhandled, so the process's own
// handlers (Xenia's guest memory and MMIO handling) still run.
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_THREADS 1024
#define MAX_RIPS 4096

static DWORD tids[MAX_THREADS];
static HANDLE handles[MAX_THREADS];
static int nthreads;
static unsigned long long rips[MAX_RIPS];
static unsigned long counts[MAX_RIPS];
static int nrips;
static unsigned long long watch_addr;
static DWORD64 dr7_value;

static void add_thread(DWORD tid, HANDLE h) {
  if (nthreads < MAX_THREADS) { tids[nthreads] = tid; handles[nthreads] = h; nthreads++; }
}
static void remove_thread(DWORD tid) {
  for (int i = 0; i < nthreads; i++)
    if (tids[i] == tid) { tids[i] = tids[nthreads - 1]; handles[i] = handles[nthreads - 1]; nthreads--; return; }
}
static HANDLE thread_handle(DWORD tid) {
  for (int i = 0; i < nthreads; i++) if (tids[i] == tid) return handles[i];
  return NULL;
}
// Called only while the process is stopped in a debug event, so every thread is suspended.
static void set_debug_regs(HANDLE h, int on) {
  CONTEXT c;
  memset(&c, 0, sizeof c);
  c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  if (!GetThreadContext(h, &c)) return;
  if (on) { c.Dr0 = watch_addr; c.Dr7 = (c.Dr7 & ~0xF0003ull) | dr7_value; }
  else { c.Dr0 = 0; c.Dr7 &= ~0xF0003ull; }
  c.Dr6 = 0;
  SetThreadContext(h, &c);
}
static void set_all(int on) { for (int i = 0; i < nthreads; i++) set_debug_regs(handles[i], on); }
static void record(unsigned long long rip) {
  for (int i = 0; i < nrips; i++) if (rips[i] == rip) { counts[i]++; return; }
  if (nrips < MAX_RIPS) { rips[nrips] = rip; counts[nrips] = 1; nrips++; }
}

int main(int argc, char **argv) {
  if (argc != 6) {
    fprintf(stderr, "usage: xwatch <pid> <hostaddr hex> <len 1|2|4|8> <w|rw> <ms>\n");
    return 2;
  }
  DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
  watch_addr = _strtoui64(argv[2], NULL, 16);
  int len = atoi(argv[3]);
  int rw = strcmp(argv[4], "rw") == 0;
  DWORD ms = (DWORD)strtoul(argv[5], NULL, 10);
  DWORD64 lenbits = len == 1 ? 0 : len == 2 ? 1 : len == 8 ? 2 : 3;
  if ((len != 1 && len != 2 && len != 4 && len != 8) || (watch_addr % len) != 0) {
    fprintf(stderr, "length must be 1, 2, 4 or 8 and the address aligned to it\n");
    return 2;
  }
  // L0 enable, RW0 = 01 (write) or 11 (read/write), LEN0.
  dr7_value = 1ull | ((rw ? 3ull : 1ull) << 16) | (lenbits << 18);

  if (!DebugActiveProcess(pid)) { fprintf(stderr, "DebugActiveProcess failed: %lu\n", GetLastError()); return 1; }
  DebugSetProcessKillOnExit(FALSE);
  HANDLE hproc = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);

  ULONGLONG start = GetTickCount64();
  int armed = 0, stopping = 0, cleared = 0, done = 0;
  ULONGLONG drain_until = 0;
  unsigned long total = 0, events = 0;
  DEBUG_EVENT ev;
  while (!done) {
    ULONGLONG now = GetTickCount64();
    if (!stopping && armed && now - start >= ms) {
      // Make the process stop once more so the registers can be cleared with every thread suspended.
      stopping = 1;
      DebugBreakProcess(hproc);
    }
    if (cleared && now >= drain_until) break;
    if (!WaitForDebugEvent(&ev, 50)) continue;
    events++;
    DWORD cont = DBG_CONTINUE;
    switch (ev.dwDebugEventCode) {
    case CREATE_PROCESS_DEBUG_EVENT:
      add_thread(ev.dwThreadId, ev.u.CreateProcessInfo.hThread);
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
      break;
    case CREATE_THREAD_DEBUG_EVENT:
      add_thread(ev.dwThreadId, ev.u.CreateThread.hThread);
      if (armed && !stopping && !cleared) set_debug_regs(ev.u.CreateThread.hThread, 1);
      break;
    case EXIT_THREAD_DEBUG_EVENT:
      remove_thread(ev.dwThreadId);
      break;
    case LOAD_DLL_DEBUG_EVENT:
      if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
      break;
    case EXIT_PROCESS_DEBUG_EVENT:
      done = 1;
      break;
    case EXCEPTION_DEBUG_EVENT: {
      DWORD code = ev.u.Exception.ExceptionRecord.ExceptionCode;
      if (code == EXCEPTION_BREAKPOINT && ev.dwThreadId != 0 && !armed) {
        // The attach breakpoint: every existing thread is known now; arm them all.
        set_all(1);
        armed = 1;
        start = GetTickCount64();
      } else if (code == EXCEPTION_BREAKPOINT && stopping && !cleared) {
        // Clear every thread, then keep draining events for a while: traps already raised by other threads
        // are still queued and must be swallowed here, never passed back to the process.
        set_all(0);
        cleared = 1;
        drain_until = GetTickCount64() + 500;
      } else if (code == EXCEPTION_SINGLE_STEP) {
        // Our trap (or one queued before the registers were cleared): always handled here. Xenia does not
        // single-step itself, and an unhandled single step would kill it.
        HANDLE h = thread_handle(ev.dwThreadId);
        CONTEXT c;
        memset(&c, 0, sizeof c);
        c.ContextFlags = CONTEXT_CONTROL | CONTEXT_DEBUG_REGISTERS;
        if (h && GetThreadContext(h, &c)) {
          if ((c.Dr6 & 1) && !cleared) { record(c.Rip); total++; }
          c.Dr6 = 0;
          if (cleared) { c.Dr0 = 0; c.Dr7 &= ~0xF0003ull; }
          c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
          SetThreadContext(h, &c);
        }
      } else if (code == EXCEPTION_BREAKPOINT) {
        // Some other breakpoint (a second attach break): leave it to us, harmless.
      } else {
        cont = DBG_EXCEPTION_NOT_HANDLED;
      }
      break;
    }
    default:
      break;
    }
    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, cont);
  }
  DebugActiveProcessStop(pid);
  for (int i = 0; i < nrips; i++) printf("hit %llx %lu\n", rips[i], counts[i]);
  printf("total %lu\nthreads %d\nevents %lu\n", total, nthreads, events);
  if (hproc) CloseHandle(hproc);
  return 0;
}
