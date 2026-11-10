@echo off
rem HDL S57: put WebView 106 in (backs up the original first). Plug the panel in by USB first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0s57-webview.ps1" %*
