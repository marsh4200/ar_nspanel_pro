@echo off
rem HDL S57: put the original WebView back. Plug the panel in by USB first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0s57-webview.ps1" -Restore %*
