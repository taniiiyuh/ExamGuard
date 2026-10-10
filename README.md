# ExamGuard - Google Forms exam lockdown (Chrome extension)

Keeps a student inside their Google Form during an exam. The moment they try to leave, they are dragged back, shown a warning, and after too many violations the exam is **ended for good** and the form is blocked for that student.

## What it does

| Violation | Response |
|---|---|
| Opens a new tab (Ctrl+T, link, etc.) | Tab is **closed**, student pulled back, warning |
| Switches to another existing tab | Pulled back to the exam tab, warning |
| Opens a new browser window (incl. Ctrl+N) | Window is **closed**, warning |
| Types / navigates to another site in the exam tab | Exam tab is **restored** to the form, warning |
| Switches to another app (Word, PDF reader, notes, desktop AI app) or Alt-Tabs | Detected, Chrome re-focused, warning |
| Minimises the window / leaves full-screen | Detected, full-screen restored, warning |
| Closes the exam tab/window or restarts Chrome | Exam reopened, warning |
| F12 / Ctrl+Shift+I/J/C / Ctrl+U | Blocked and counted as a violation |
| Copy / paste / right-click / print / save | Blocked and logged |

Every row above also records **which site/page** the student tried to open (see the log section below).

Warnings 1..N-1 show a full-screen warning card (with a 5-second countdown before the student can continue). The last warning before the limit says **FINAL WARNING**. At warning **N** (`maxWarnings`, default 3) the exam **ends automatically**: the student is released from full-screen, an "Your exam has ended" screen replaces the form, and the form stays blocked for them - reloading, reopening the link or restarting Chrome does not bring it back. The ending is logged (and sent to your Google Sheet if you set it up) as `EXAM_TERMINATED`.

The session starts automatically when the student opens the form and ends when they submit it. Multi-section forms are supported: clicking **Next** does not end the session; only the final "response recorded" page does.

## Setup (5 minutes to test)

1. Edit `config.js` - paste your form's student link into `formUrl` (full `docs.google.com/forms/d/e/.../viewform` link, or leave it empty to guard every Google Form) and set `maxWarnings`.
2. Chrome -> `chrome://extensions` -> turn on **Developer mode** -> **Load unpacked** -> choose this folder.
3. Open your form link. Full-screen starts, the "Exam mode" pill appears, and violations are enforced.
   (Don't test while editing the form - only `/viewform` pages trigger a session.)

## Site / activity log in YOUR private Google Sheet

While an exam is running, every violation is logged together with **what the student opened**:

| Sheet column | Example |
|---|---|
| Time, Student (Chrome profile email), Form | when / who / which exam |
| Type | `NEW_TAB`, `TAB_SWITCH`, `NAVIGATED_AWAY`, `NEW_WINDOW`, `OTHER_WINDOW`, `LEFT_BROWSER`, `RETURNED`, ... |
| Site | `chat.openai.com` |
| Page title | `ChatGPT` (if `logPageTitles` is on) |
| URL | `chat.openai.com/c/abc` (controlled by `urlDetail`, no `?query` by default) |
| Away (s) | on `RETURNED` rows: how long the student was outside Chrome |

Nothing is recorded when no exam is running.

### Setup (the sheet stays private)

1. Create a **new Google Sheet** while signed in as the teacher. **Do not share it with students.** Only you (and anyone you add) can open it.
2. Extensions -> Apps Script, delete the starter code, paste this, and change `SECRET`:

```js
const SHEET_NAME = "ExamLog";
const SECRET = "PASTE-A-LONG-RANDOM-STRING-HERE";   // same value as webhookSecret in config.js
const HEADERS = ["Time","Student","Type","Site","Page title","URL","Detail",
                 "Counted","Warnings","Away (s)","Form"];

// Stops a page title like "=IMPORTXML(...)" from running as a formula in your sheet.
function clean(v, max) {
  let s = String(v == null ? "" : v).slice(0, max || 300);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return ContentService.createTextOutput("denied");
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
      if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); sh.setFrozenRows(1); }
      sh.appendRow([
        clean(d.time, 40), clean(d.student, 120), clean(d.type, 40),
        clean(d.site, 120), clean(d.title, 150), clean(d.url, 260),
        clean(d.detail, 300), d.counted === true, Number(d.warnings) || 0,
        Number(d.awaySec) || 0, clean(d.form, 260)
      ]);
    } finally { lock.releaseLock(); }
    return ContentService.createTextOutput("ok");
  } catch (err) {
    return ContentService.createTextOutput("error");
  }
}

// Visiting the URL in a browser shows nothing - the data is only in your sheet.
function doGet() { return ContentService.createTextOutput("ok"); }
```

3. Deploy -> **New deployment** -> Web app -> Execute as **Me**, Who has access **Anyone** -> copy the URL.
4. In `config.js` set `webhookUrl` (the URL) and `webhookSecret` (the same secret). Reload the extension.

**Who can read the data?** Only people the sheet is shared with. The web app can only *add* rows; it never returns data, so having its URL does not let anyone read the log.

**Who can write fake rows?** The URL and secret live inside the extension files, which a technical student could read. The secret keeps random outsiders out but not a determined student. Treat the sheet as strong evidence, not proof, and keep the old (pre-secret) deployment URL turned off: Deploy -> Manage deployments -> archive it.

## Desktop monitor (Windows, optional) - started by Chrome

`exam_monitor.py` closes blocklisted programs (Word, PDF readers, Notepad, desktop AI apps, other browsers) and logs the NAME of the program the student switched to, to the same Google Sheet. **Chrome starts it by itself (Native Messaging) when the exam starts and it exits when the exam ends** - nothing runs in the background between exams, and students never run anything.

One-time setup per computer:

1. Install Python and `pip install psutil`.
2. Put `exam_monitor.py`, `native_host.bat`, `install_host.py` and `config.js` in one folder (do not move it afterwards).
3. Load the extension, copy its ID from `chrome://extensions`, then run: `python install_host.py <extension-id>` (current user, no admin needed; add `--all-users` as Administrator for every user). Undo with `python install_host.py --uninstall`.

Microphone (voice assistants such as Gemini Live in Chrome):
- While the exam runs, the monitor switches the Windows microphone privacy settings (apps + desktop apps) to **Deny** and puts them back to their previous value when the exam ends. It re-applies the block if the student turns it back on (`MIC_TAMPER`).
- If a program still records from the microphone, the monitor tells the extension, which counts it as a warning (`MIC_USED`, the program name goes to the sheet) and repeats every `MIC_REPEAT_SECONDS` while it continues.
- If the monitor is killed, `mic_restore.json` (next to the script) remembers the old settings and they are restored the next time the monitor starts. Set `BLOCK_MICROPHONE = False` in `exam_monitor.py` to turn this off.
- This does **not** stop the typed Gemini panel in Chrome. To remove Gemini in Chrome completely, disable it with Chrome policy on the exam computers (Admin console, or check `chrome://policy` for the Gemini setting).

Screenshots:
- While the exam runs, the monitor swallows PrintScreen, Alt+PrintScreen, Win+PrintScreen and Win+Shift+S (a keyboard hook that reads no other keys), closes Snipping Tool / Snip & Sketch / Xbox Game Bar (`BLOCKLIST`), and the extension counts the attempt as a warning (`SCREENSHOT`). Set `BLOCK_SCREENSHOTS = False` in `exam_monitor.py` to turn the key block off.
- Without the monitor, the extension can only see PrintScreen after the fact: it wipes the clipboard and counts a warning.
- A photo of the screen with a phone cannot be detected by any software.

Notes:
- Only the extension with that ID may start the monitor (`allowed_origins`); there is no open local port any more.
- The unpacked extension ID depends on the folder it was loaded from. For many computers use a force-installed extension (fixed ID) or add a `key` to `manifest.json`.
- If the extension is disabled/removed or Chrome is closed during an exam, Chrome stops the monitor too. The sheet then shows `MONITOR_END` ("Chrome closed the connection during the exam"). If the host is missing or fails to start, the extension logs `MONITOR_UNAVAILABLE`.
- Debugging: the monitor writes `exam_monitor.log` next to the script. `start_monitor.bat` / `--always` are for manual testing only.
- Set `monitorHost: ""` in `config.js` to turn the desktop monitor off.

## IMPORTANT: what a browser extension cannot do

A Chrome extension controls **Chrome only**. Be realistic about these gaps:

- **Other desktop apps (Word, PDF viewers, notes, ChatGPT/Gemini desktop apps)**: Chrome only tells the extension that it *lost focus* - **never which app** took it. The log shows `Outside Chrome` with the time away, but not the app name. To capture app names you need software installed on the computer itself (the optional desktop monitor above, Safe Exam Browser, a managed-device/endpoint tool, or a classroom monitoring product). The extension also cannot stop the app from opening. For true prevention use **Safe Exam Browser** (free, safeexambrowser.org; Windows/macOS/iOS) or managed Chromebooks (below).
- **Second device (phone, another laptop)**: cannot be detected by software. Use physical invigilation or a webcam proctor.
- **Student can disable/remove the extension** unless it is force-installed by an admin.
- **Focus-stealing rules**: on Windows/macOS the OS may refuse to bring Chrome to the front; the violation is still logged and the warning shows when they return.

## Recommended hardening (Google Workspace for Education admin)

In the Admin console (Devices -> Chrome -> Settings -> Users & browsers) for the exam students' OU:

1. **Force-install** ExamGuard (publish it as an unlisted/private Chrome Web Store item, or self-host) so students cannot remove it.
2. **Incognito mode: disallowed** (otherwise an incognito window bypasses the extension).
3. **Developer tools: disallowed** and **guest mode: disabled**.
4. **Block all other extensions** except an allow-list (stops AI/side-panel extensions).
5. Disable Chrome's built-in AI / side-panel features for those users where the policy is available.
6. On **managed Chromebooks**, also enable **Locked mode** on the Google Form quiz (Settings -> Make this a quiz -> Locked mode). It is the strongest lock because it is enforced by ChromeOS itself - use it together with this extension for logging and warnings.

## When a student's exam is ended

- The block is stored in that Chrome profile, per form. It only applies to the form that was ended - other forms still work normally.
- **Final by default.** Without a passcode there is no way back for the student. Their unsubmitted answers are **not** saved to your form results (Google Forms only records submitted forms), so check the log and decide what to do (e.g. let them retake it).
- **Optional teacher override.** To reinstate someone ended by mistake, open `make-passcode-hash.html`, make a hash of a long passcode, and paste it into `passcodeSha256` in `config.js`. The "Exam ended" screen then shows a small **Teacher / proctor only** box: type the passcode and click **Reinstate student**. Five wrong passcodes block attempts for 60 seconds, and wrong attempts are logged. Leave `passcodeSha256` empty to make endings completely final.
- **Limits of the block.** It lives in the browser: a student can still try another browser, profile, incognito window or device. Force-installing the extension and disabling incognito/other profiles (see below) closes most of that; combine with Google Forms' "Limit to 1 response" for the rest.
- **Testing:** to clear an ended exam on your own machine, remove the extension at `chrome://extensions` and load it again (this clears the stored block).

## Known behaviours to tell your students

- Links inside the form open in a new tab and will be blocked. Embed images/videos instead.
- A native OS file-picker (file-upload questions) takes window focus and may count as a violation.
- Redirecting a student back reloads the form. Turn on response progress / "Save progress" or keep exams one-page-per-section so answers are not lost.
- Chrome reports the signed-in profile email, which is logged with each violation.

## Privacy / consent

ExamGuard only activates on Google Form exam pages and only logs **while an exam is running**. It records the student's Chrome profile email, timestamps, violation types and the **site / page title / link (no query string by default) of anything they open or switch to during the exam** - not screenshots, keystrokes, or general browsing history. Students see an "Activity is logged" notice on the exam page and in the extension popup.

Before the exam, tell students (and, where required, parents) exactly what is logged, who can see it, and how long you keep it. Keep the sheet restricted to the teacher/proctor, and delete old rows when you no longer need them. Check your school's policy on monitoring students.

## Files

`manifest.json` - extension definition - `config.js` - your settings - `background.js` - detection/enforcement/logging - `content.js` - warning / exam-ended screens and in-page guards - `popup.html/js` - status and recent log.
