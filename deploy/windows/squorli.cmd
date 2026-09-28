@rem Squorli Server: the management command (deploy/windows/AGENTS.md). Everything on one line: cmd.exe reads a batch
@rem file again after every command, and "squorli update" replaces this file while it runs; a line is parsed as a whole.
@rem "call exit /b" with the doubled percent signs reads the exit code after the program ended; a plain "exit /b" loses
@rem it when PowerShell is the caller.
@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\squorli.ps1" %* & call exit /b %%ERRORLEVEL%%
