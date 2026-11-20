; installer.nsh — The Curator's additions to electron-builder's NSIS installer
; (electron-builder.yml `nsis.include`). Macros only; electron-builder's own
; templates (app-builder-lib 26.15.3, templates/nsis) decide where each runs.
;
; 1. customWelcomePage — a Welcome page, so the installer reads
;    Welcome (Next) -> installing -> Finish ("Run The Curator", ticked).
; 2. customInstallMode — install for THIS user only. The assisted installer
;    would otherwise offer "Anyone who uses this computer", which needs an
;    administrator. Forcing the current user skips that page entirely.
; 3. The data guard (customInit / customUnInit / customUnInstall) — the
;    knowledge base lives in %LOCALAPPDATA%\TheCurator (the app's in
;    %LOCALAPPDATA%\TheCurator\App). The uninstaller deletes $INSTDIR
;    recursively, so it refuses to run, and the installer refuses to install,
;    when $INSTDIR is that folder or inside it, or is not a folder of its own
;    under the per-user programs folder. A normal install
;    (%LOCALAPPDATA%\Programs\The Curator) never trips it; a hand-typed /D=
;    pointing at the data folder does.

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Leaves "1" in $R9 when $INSTDIR is unsafe to install into or delete, else "0".
!macro curatorCheckInstDir
  StrCpy $R9 "0"
  ; The data folder itself, or anything inside it (prefix, case-insensitive).
  StrCpy $R8 "$LOCALAPPDATA\TheCurator"
  StrLen $R7 $R8
  StrCpy $R6 "$INSTDIR" $R7
  ${if} $R6 == $R8
    StrCpy $R9 "1"
  ${endif}
  ; Folders that hold other things: never a target of a recursive delete.
  ${if} "$INSTDIR" == "$LOCALAPPDATA"
  ${orIf} "$INSTDIR" == "$LOCALAPPDATA\Programs"
  ${orIf} "$INSTDIR" == "$PROFILE"
  ${orIf} "$INSTDIR" == "$DOCUMENTS"
  ${orIf} "$INSTDIR" == "$DESKTOP"
  ${orIf} "$INSTDIR" == "$APPDATA"
  ${orIf} "$INSTDIR" == "$WINDIR"
    StrCpy $R9 "1"
  ${endif}
  ; A drive root such as C:\ (three characters ending in a backslash).
  StrLen $R7 "$INSTDIR"
  ${if} $R7 <= 3
    StrCpy $R9 "1"
  ${endif}
!macroend

!macro customInit
  !insertmacro curatorCheckInstDir
  ${if} $R9 == "1"
    MessageBox MB_OK|MB_ICONSTOP "The Curator cannot be installed in $INSTDIR, because that folder holds other files (your knowledge base, or other programs).$\r$\n$\r$\nRun the installer again without choosing a folder." /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInit
  !insertmacro curatorCheckInstDir
  ${if} $R9 == "1"
    MessageBox MB_OK|MB_ICONSTOP "Nothing was removed: $INSTDIR is not The Curator's own program folder, and removing it could delete your knowledge base or other files." /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstall
  ; Checked again right before electron-builder removes $INSTDIR.
  !insertmacro curatorCheckInstDir
  ${if} $R9 == "1"
    Abort "Nothing was removed: $INSTDIR is not The Curator's own program folder."
  ${endif}
!macroend
