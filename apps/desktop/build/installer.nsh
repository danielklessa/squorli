; Additions to electron-builder's NSIS installer (picked up as build/installer.nsh, apps/desktop/AGENTS.md).
;
; The uninstaller removes every registry entry the app writes itself (user's wish, 27 September 2026); electron-builder
; removes only its own install and uninstall keys. Not on an update: the installer of the new version runs the old
; uninstaller with --updated, and the entries must stay.
;   AppUserModelId\com.squorli.desktop  name and icon of the notifications (main/index.ts registerAppId)
;   Classes\squorli                     the squorli:// links (main/deepLinks.ts, setAsDefaultProtocolClient)
;   Run, StartupApproved\Run "Squorli"  start with the system (main/autostartSystem.ts, setLoginItemSettings)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.squorli.desktop"
    DeleteRegKey HKCU "Software\Classes\squorli"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Squorli"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Squorli"
  ${endIf}
!macroend
