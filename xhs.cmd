:; script_dir="$(cygpath -aw "$(dirname "$0")")"; export MSYS2_ARG_CONV_EXCL='*'; exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$script_dir\\xhs.ps1" "$@"; exit $?
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0xhs.ps1" %*
exit /b %ERRORLEVEL%
