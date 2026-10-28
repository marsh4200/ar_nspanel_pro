@echo off
rem AR NSPanel Pro - USB setup (restore). Plug the panel in by USB first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ar-panel-usb.ps1" -Restore %*
