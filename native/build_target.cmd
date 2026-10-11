@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>nul
cl /nologo /O2 xwatch_target.c /Fe:xwatch_target.exe
