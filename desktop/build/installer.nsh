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

; Leaves in $R5 the full, long spelling of the path in $R5: GetFullPathNameW
; resolves `..`, `.` and forward slashes, GetLongPathNameW expands 8.3 short
; names (it needs the path to exist; when either call fails $R5 keeps what it
; had), and one trailing backslash is dropped unless it is a drive root.
; Uses $R2-$R4.
!macro curatorFullPath
  System::Call 'kernel32::GetFullPathNameW(w R5, i ${NSIS_MAX_STRLEN}, w .R4, p 0) i .R3'
  ${if} $R3 > 0
  ${andIf} $R3 < ${NSIS_MAX_STRLEN}
    StrCpy $R5 $R4
  ${endif}
  System::Call 'kernel32::GetLongPathNameW(w R5, w .R4, i ${NSIS_MAX_STRLEN}) i .R3'
  ${if} $R3 > 0
  ${andIf} $R3 < ${NSIS_MAX_STRLEN}
    StrCpy $R5 $R4
  ${endif}
  StrLen $R3 $R5
  StrCpy $R2 $R5 1 -1
  ${if} $R2 == "\"
  ${andIf} $R3 > 3
    IntOp $R3 $R3 - 1
    StrCpy $R5 $R5 $R3
  ${endif}
!macroend

; Leaves "1" in $R9 when $INSTDIR is unsafe to install into or delete, else "0".
; Judged on its FULL, LONG spelling (so `/D=` with `..`, forward slashes or an
; 8.3 name cannot reach the data folder by spelling it differently), and on
; what is IN it: a folder that already holds a knowledge base or the app's
; data is never a program folder, whatever it is called.
!macro curatorCheckInstDir
  StrCpy $R9 "0"
  StrCpy $R5 "$INSTDIR"
  !insertmacro curatorFullPath
  StrCpy $R1 $R5
  StrCpy $R5 "$LOCALAPPDATA\TheCurator"
  !insertmacro curatorFullPath
  StrCpy $R8 $R5
  ; The data folder itself, or anything inside it (prefix, case-insensitive),
  ; on both spellings.
  StrLen $R7 $R8
  StrCpy $R6 $R1 $R7
  ${if} $R6 == $R8
    StrCpy $R9 "1"
  ${endif}
  StrCpy $R8 "$LOCALAPPDATA\TheCurator"
  StrLen $R7 $R8
  StrCpy $R6 "$INSTDIR" $R7
  ${if} $R6 == $R8
    StrCpy $R9 "1"
  ${endif}
  ; Folders that hold other things: never a target of a recursive delete.
  ${if} $R1 == "$LOCALAPPDATA"
  ${orIf} $R1 == "$LOCALAPPDATA\Programs"
  ${orIf} $R1 == "$PROFILE"
  ${orIf} $R1 == "$DOCUMENTS"
  ${orIf} $R1 == "$DESKTOP"
  ${orIf} $R1 == "$APPDATA"
  ${orIf} $R1 == "$WINDIR"
  ${orIf} "$INSTDIR" == "$LOCALAPPDATA"
  ${orIf} "$INSTDIR" == "$LOCALAPPDATA\Programs"
  ${orIf} "$INSTDIR" == "$PROFILE"
  ${orIf} "$INSTDIR" == "$DOCUMENTS"
  ${orIf} "$INSTDIR" == "$DESKTOP"
  ${orIf} "$INSTDIR" == "$APPDATA"
  ${orIf} "$INSTDIR" == "$WINDIR"
    StrCpy $R9 "1"
  ${endif}
  ; What is in it: a knowledge base, the app's settings, or the app's data folder.
  ${if} ${FileExists} "$INSTDIR\domains\*.*"
  ${orIf} ${FileExists} "$INSTDIR\.curator-config.json"
  ${orIf} ${FileExists} "$INSTDIR\App\*.*"
  ${orIf} ${FileExists} "$INSTDIR\App\domains\*.*"
    StrCpy $R9 "1"
  ${endif}
  ; A drive root such as C:\ (three characters ending in a backslash).
  StrLen $R7 "$INSTDIR"
  ${if} $R7 <= 3
    StrCpy $R9 "1"
  ${endif}
  StrLen $R7 $R1
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
