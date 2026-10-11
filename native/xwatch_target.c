// Test target for xwatch: several threads read and write one variable forever and print its address.
// The watcher must attach, count, detach and leave this process running, any number of times.
#include <windows.h>
#include <stdio.h>

volatile long long watched = 0;

static DWORD WINAPI worker(LPVOID arg) {
  (void)arg;
  for (;;) {
    long long v = watched;      // read
    watched = v + 1;            // write
    Sleep(1);
  }
}

int main(void) {
  printf("%llx\n", (unsigned long long)(size_t)&watched);
  fflush(stdout);
  for (int i = 0; i < 4; i++) CreateThread(NULL, 0, worker, NULL, 0, NULL);
  for (;;) {
    Sleep(200);
    // Keep creating short-lived threads so the watcher also sees threads start and stop.
    HANDLE h = CreateThread(NULL, 0, worker, NULL, CREATE_SUSPENDED, NULL);
    ResumeThread(h);
    Sleep(50);
    TerminateThread(h, 0);
    CloseHandle(h);
  }
}
