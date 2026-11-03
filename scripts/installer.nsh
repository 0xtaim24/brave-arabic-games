!define BRAVE_PROCESS_SCRIPT "${__FILEDIR__}\installer-process.ps1"

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\brave-process.ps1 "${BRAVE_PROCESS_SCRIPT}"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\brave-process.ps1" -InstallDir "$INSTDIR"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please close the brave Arabic game tool and retry." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    # Legacy uninstallers killed every brave.exe, including the user's browser.
    # Use this release's path-aware uninstaller for the in-place upgrade too.
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      File /oname=$PLUGINSDIR\brave-safe-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
      ClearErrors
      CopyFiles /SILENT "$PLUGINSDIR\brave-safe-uninstaller.exe" "$INSTDIR\${UNINSTALL_FILENAME}"
      ${If} ${Errors}
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !endif
!macroend
