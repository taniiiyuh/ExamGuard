"""
ExamGuard desktop monitor (Windows)

While an exam is running it:
  * closes blocklisted programs (Word, Excel, PDF readers, Notepad, ...)
  * blocks screenshots (PrintScreen, Win+Shift+S) and closes Snipping Tool / Game Bar
  * switches the microphone OFF (Windows privacy setting) for the whole exam and
    reports any program that still records from it (e.g. Gemini Live in Chrome)
  * logs which program the student switched to (program NAME only, never
    window titles, so private document names / chats are not recorded)
  * sends every event to the same Google Sheet the Chrome extension uses

Chrome starts this program by itself (Native Messaging) when an exam starts and
it exits when the exam ends, so nothing runs in the background between exams.
Use --always to run it by hand and enforce for as long as it is running (testing).

Setup:   pip install psutil
         python install_host.py <extension-id>     (one time per computer)
Keep this file, native_host.bat, install_host.py and config.js in the same folder.

Tell students exactly what is logged before the exam.
"""
import argparse
import ctypes
import getpass
import json
import os
import queue
import re
import struct
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

try:
    import psutil
except ImportError:
    sys.exit("Missing dependency. Open a terminal and run:  pip install psutil")

if os.name != "nt":
    sys.exit("This monitor only works on Windows.")

import winreg

# ----------------------------------------------------------------------------
# SETTINGS
# ----------------------------------------------------------------------------
POLL_SECONDS = 1.0            # how often processes / the active window are checked
HEARTBEAT_TIMEOUT = 60        # seconds without a signal from the extension = "lost"
MAX_SESSION_MINUTES = 240     # safety: stop enforcing after this long
LOG_FOCUS_CHANGES = True      # log which program the student switched to
SHOW_POPUP = True             # tell the student when something was closed
BLOCK_MICROPHONE = True       # switch the microphone off during the exam (restored afterwards)
MIC_REPEAT_SECONDS = 10       # while a program keeps recording, report it this often
BLOCK_SCREENSHOTS = True      # swallow screenshot keys during the exam

# Programs that are closed on sight. Keys MUST be lower-case process names.
# Add or remove entries as you like (Task Manager -> Details tab shows the names).
BLOCKLIST = {
    "winword.exe": "Microsoft Word",
    "excel.exe": "Microsoft Excel",
    "powerpnt.exe": "Microsoft PowerPoint",
    "onenote.exe": "OneNote",
    "notepad.exe": "Notepad",
    "wordpad.exe": "WordPad",
    "acrord32.exe": "Adobe Reader",
    "acrobat.exe": "Adobe Acrobat",
    "sumatrapdf.exe": "SumatraPDF",
    "foxitpdfreader.exe": "Foxit Reader",
    "foxitreader.exe": "Foxit Reader",
    # Desktop AI apps (check the real names on your machines and add more)
    "chatgpt.exe": "ChatGPT app",
    "claude.exe": "Claude app",
    # Other browsers: the extension only runs in Chrome, so these are a way around it.
    # Edge is NOT blocked by default; add "msedge.exe": "Microsoft Edge" if you want that.
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "opera.exe": "Opera",
    "vivaldi.exe": "Vivaldi",
    # Screenshot / screen-capture tools
    "snippingtool.exe": "Snipping Tool",
    "screenclippinghost.exe": "Snipping Tool (screen clip)",
    "screensketch.exe": "Snip & Sketch",
    "gamebar.exe": "Xbox Game Bar",
}

# Programs that are normal during an exam and are not written to the log.
IGNORE_FOCUS = {
    "chrome.exe", "msedge.exe", "explorer.exe", "searchhost.exe",
    "shellexperiencehost.exe", "startmenuexperiencehost.exe", "lockapp.exe",
    "python.exe", "pythonw.exe", "exam_monitor.exe",
}

# Filled in from config.js at startup.
WEBHOOK_URL = ""
WEBHOOK_SECRET = ""


def load_config(path):
    """Reuse webhookUrl / webhookSecret from the extension's config.js."""
    global WEBHOOK_URL, WEBHOOK_SECRET
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        print(f"[!] Could not read {path}. Events will only be printed here.")
        return

    def grab(key):
        m = re.search(r'^\s*' + key + r'\s*:\s*"([^"]*)"', text, re.M)
        return m.group(1) if m else ""

    WEBHOOK_URL = grab("webhookUrl")
    WEBHOOK_SECRET = grab("webhookSecret")
    if not WEBHOOK_URL:
        print("[!] webhookUrl is empty in config.js. Events will only be printed here.")


# ----------------------------------------------------------------------------
# Logging to the Google Sheet (same columns as the extension)
# ----------------------------------------------------------------------------
send_queue = queue.Queue()


def sender():
    while True:
        row = send_queue.get()
        body = json.dumps(row).encode("utf-8")
        for _ in range(3):
            try:
                req = urllib.request.Request(
                    WEBHOOK_URL, data=body, method="POST",
                    headers={"Content-Type": "text/plain"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    r.read()
                break
            except Exception:
                time.sleep(3)
        send_queue.task_done()


def flush_and_exit(timeout=15):
    """Give the last log rows a chance to reach the sheet, then quit."""
    mic_restore()
    end = time.time() + timeout
    while send_queue.unfinished_tasks and time.time() < end:
        time.sleep(0.2)
    os._exit(0)


def log(type_, detail, site=""):
    row = {
        "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "student": session.student,
        "form": session.form,
        "type": type_,
        "detail": detail,
        "counted": False,
        "warnings": 0,
        "site": site,
        "title": "",
        "url": "",
        "awaySec": 0,
        "secret": WEBHOOK_SECRET,
    }
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {type_}: {detail}")
    if WEBHOOK_URL:
        send_queue.put(row)


# ----------------------------------------------------------------------------
# Exam session state (driven by the extension)
# ----------------------------------------------------------------------------
class Session:
    def __init__(self, always):
        self.always = always
        self.lock = threading.Lock()
        self.active = always
        self.student = getpass.getuser()
        self.form = ""
        self.started = time.time()
        self.last_beat = time.time()
        self.lost = False

    def handle(self, msg):
        if self.always:
            return
        action = msg.get("action")
        now = time.time()
        with self.lock:
            if action == "end":
                if self.active:
                    self.active = False
                    log("MONITOR_END", "Exam ended - desktop monitoring paused")
                return
            if action not in ("start", "beat"):
                return
            if action == "start" or not self.active:
                self.active = True
                self.started = now
                self.lost = False
                self.student = msg.get("student") or self.student
                self.form = msg.get("form") or ""
                log("MONITOR_START", "Desktop monitoring started")
            self.last_beat = now
            if self.lost:
                self.lost = False
                log("EXTENSION_BACK", "Signal from the ExamGuard extension is back")

    def tick(self):
        if self.always or not self.active:
            return
        now = time.time()
        with self.lock:
            if now - self.started > MAX_SESSION_MINUTES * 60:
                self.active = False
                log("MONITOR_END", "Session timed out - desktop monitoring paused")
                return
            if not self.lost and now - self.last_beat > HEARTBEAT_TIMEOUT:
                self.lost = True
                log("EXTENSION_LOST",
                    "No signal from the ExamGuard extension (disabled or browser closed?) - still enforcing")


session = None


# ----------------------------------------------------------------------------
# Native messaging (Chrome <-> this program over stdin)
# ----------------------------------------------------------------------------
def read_native_message():
    """One message = 4-byte length + JSON. Returns None when Chrome closed the pipe."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    if n > 65536:
        return None
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        return None
    return json.loads(data.decode("utf-8"))


def native_reader():
    while True:
        try:
            msg = read_native_message()
        except Exception:
            msg = None
        if msg is None:
            # Chrome closed, the extension was disabled/removed, or Chrome crashed.
            with session.lock:
                was_active = session.active
                session.active = False
            if was_active:
                log("MONITOR_END", "Chrome closed the connection during the exam - desktop monitoring stopped")
            flush_and_exit()
        session.handle(msg)
        if msg.get("action") == "end":
            flush_and_exit()


# ----------------------------------------------------------------------------
# Messages back to Chrome (monitor -> extension)
# ----------------------------------------------------------------------------
_native_out = None
_out_lock = threading.Lock()


def send_native(obj):
    """Send one message to the extension (4-byte length + JSON). False if that is not possible."""
    if _native_out is None:
        return False
    data = json.dumps(obj).encode("utf-8")
    try:
        with _out_lock:
            _native_out.write(struct.pack("<I", len(data)) + data)
            _native_out.flush()
        return True
    except Exception:
        return False


# ----------------------------------------------------------------------------
# Microphone: switched off for the exam + any program still recording is reported
# ----------------------------------------------------------------------------
# Windows Settings > Privacy > Microphone keeps two switches ("apps" and "desktop
# apps", Chrome is a desktop app). Both are set to Deny while the exam runs and put
# back to what they were afterwards. Windows also records which program is recording
# right now (LastUsedTimeStop = 0), which is how Gemini Live in Chrome is caught.
MIC_KEY = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
MIC_SWITCHES = (MIC_KEY, MIC_KEY + r"\NonPackaged")
MIC_SAVED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mic_restore.json")
mic_blocked = False
mic_reported = {}   # program -> when it was last reported


def _read_switch(path):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            return winreg.QueryValueEx(k, "Value")[0]
    except OSError:
        return None


def _write_switch(path, value):
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as k:
            if value is None:
                try:
                    winreg.DeleteValue(k, "Value")
                except OSError:
                    pass
            else:
                winreg.SetValueEx(k, "Value", 0, winreg.REG_SZ, value)
        return True
    except OSError:
        return False


def mic_block():
    """Keep the microphone off while the exam runs (and switch it off again if someone turns it on)."""
    global mic_blocked
    if not BLOCK_MICROPHONE:
        return
    if not mic_blocked:
        saved = {p: _read_switch(p) for p in MIC_SWITCHES}
        try:   # kept on disk so a crash cannot leave the microphone off for good
            with open(MIC_SAVED, "w", encoding="utf-8") as f:
                json.dump(saved, f)
        except OSError:
            pass
        for p in MIC_SWITCHES:
            _write_switch(p, "Deny")
        mic_blocked = True
        log("MIC_BLOCKED", "Microphone switched off for the exam")
        return
    off = [p for p in MIC_SWITCHES if _read_switch(p) != "Deny"]
    if off:
        for p in off:
            _write_switch(p, "Deny")
        log("MIC_TAMPER", "Microphone was switched back on - switched off again")


def mic_restore():
    """Put the microphone switches back to what they were before the exam."""
    global mic_blocked
    try:
        with open(MIC_SAVED, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return
    for p in MIC_SWITCHES:
        _write_switch(p, saved.get(p))
    try:
        os.remove(MIC_SAVED)
    except OSError:
        pass
    if mic_blocked:
        mic_blocked = False
        log("MIC_RESTORED", "Microphone switched back to its previous setting")


def _subkeys(path):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            i = 0
            while True:
                try:
                    yield winreg.EnumKey(k, i)
                except OSError:
                    return
                i += 1
    except OSError:
        return


def mic_users():
    """Names of the programs that are recording from the microphone right now."""
    found = set()
    running = None
    for base in (MIC_KEY, MIC_KEY + r"\NonPackaged"):
        desktop = base.endswith("NonPackaged")
        for name in _subkeys(base):
            if name == "NonPackaged":
                continue
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + name) as k:
                    start = winreg.QueryValueEx(k, "LastUsedTimeStart")[0]
                    stop = winreg.QueryValueEx(k, "LastUsedTimeStop")[0]
            except OSError:
                continue
            if not start or stop:
                continue
            app = name.replace("#", "\\").split("\\")[-1]
            if desktop:   # ignore stale entries of programs that are not running any more
                if running is None:
                    running = {(p.info["name"] or "").lower() for p in psutil.process_iter(["name"])}
                if app.lower() not in running:
                    continue
            found.add(app)
    return found


def mic_check():
    users = mic_users()
    now = time.time()
    for app in [a for a in mic_reported if a not in users]:
        del mic_reported[app]
    for app in users:
        if now - mic_reported.get(app, 0) < MIC_REPEAT_SECONDS:
            continue
        mic_reported[app] = now
        # Normally the extension counts it as a warning (and logs it); on its own we log it here.
        if session.always or not send_native({"type": "MIC_IN_USE", "app": app}):
            log("MIC_IN_USE", f"{app} is using the microphone", site=app)


# ----------------------------------------------------------------------------
# Screenshots: the keys are swallowed while the exam runs, capture tools are closed
# ----------------------------------------------------------------------------
# A low-level keyboard hook (the same thing hotkey programs use) swallows PrintScreen,
# Alt+PrintScreen, Win+PrintScreen and Win+Shift+S. It records nothing else: no other
# key is read or stored. Snipping Tool / Snip & Sketch / Game Bar are in BLOCKLIST.
from ctypes import wintypes

_u32 = ctypes.windll.user32
HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
_KEYDOWNS = (0x0100, 0x0104)          # WM_KEYDOWN, WM_SYSKEYDOWN
VK_SNAPSHOT, VK_S = 0x2C, 0x53
shot_events = queue.Queue()
_hook_proc = None
_last_shot = 0.0


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


def _down(vk):
    return bool(_u32.GetAsyncKeyState(vk) & 0x8000)


def _keyboard_hook(n_code, w_param, l_param):
    if n_code == 0 and session is not None and session.active:
        vk = ctypes.cast(l_param, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents.vkCode
        win = _down(0x5B) or _down(0x5C)
        name = None
        if vk == VK_SNAPSHOT:
            name = ("Win+" if win else "Alt+" if _down(0x12) else "") + "PrintScreen"
        elif vk == VK_S and win and _down(0x10):
            name = "Win+Shift+S"
        if name:
            if w_param in _KEYDOWNS:
                shot_events.put(name)
            return 1                   # swallow the key (down and up)
    return _u32.CallNextHookEx(None, n_code, w_param, l_param)


def _hook_thread():
    global _hook_proc
    k32 = ctypes.windll.kernel32
    _u32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    _u32.CallNextHookEx.restype = ctypes.c_ssize_t
    _u32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wintypes.DWORD]
    _u32.SetWindowsHookExW.restype = ctypes.c_void_p
    _u32.GetAsyncKeyState.restype = ctypes.c_short
    k32.GetModuleHandleW.restype = ctypes.c_void_p
    _hook_proc = HOOKPROC(_keyboard_hook)          # keep a reference or it is garbage collected
    if not _u32.SetWindowsHookExW(13, _hook_proc, k32.GetModuleHandleW(None), 0):   # 13 = WH_KEYBOARD_LL
        print("[!] Could not install the screenshot key block.")
        return
    msg = wintypes.MSG()
    while _u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        _u32.TranslateMessage(ctypes.byref(msg))
        _u32.DispatchMessageW(ctypes.byref(msg))


def shot_check():
    """Report blocked screenshot keys (the extension counts them as a warning)."""
    global _last_shot
    names = []
    while True:
        try:
            names.append(shot_events.get_nowait())
        except queue.Empty:
            break
    if not names or time.time() - _last_shot < 3:
        return
    _last_shot = time.time()
    if session.always or not send_native({"type": "SCREENSHOT_KEY", "key": names[0]}):
        log("SCREENSHOT_KEY", f"Blocked {names[0]}")
    notify("Screenshots are not allowed during the exam.")


# ----------------------------------------------------------------------------
# Student-facing popup
# ----------------------------------------------------------------------------
_popup_open = threading.Event()
_last_popup = 0.0


def notify(text):
    global _last_popup
    if not SHOW_POPUP or _popup_open.is_set() or time.time() - _last_popup < 5:
        return
    _last_popup = time.time()

    def run():
        _popup_open.set()
        try:
            # 0x30 = warning icon, 0x40000 = always on top
            ctypes.windll.user32.MessageBoxW(0, text, "ExamGuard", 0x30 | 0x40000)
        finally:
            _popup_open.clear()

    threading.Thread(target=run, daemon=True).start()


# ----------------------------------------------------------------------------
# Enforcement
# ----------------------------------------------------------------------------
handled = {}   # (pid, create_time) -> time first seen, so each launch is logged once


def scan_blocklist():
    for p in psutil.process_iter(["pid", "name", "create_time"]):
        try:
            exe = p.info["name"] or ""
            label = BLOCKLIST.get(exe.lower())
            if not label:
                continue
            key = (p.info["pid"], p.info["create_time"])
            closed = True
            try:
                p.kill()
            except psutil.NoSuchProcess:
                pass
            except psutil.AccessDenied:
                closed = False
            if key not in handled:
                handled[key] = time.time()
                log("BLOCKED_APP", f"{'Closed' if closed else 'COULD NOT close'} {label} ({exe})", site=exe)
                notify(f"{label} is not allowed during the exam and was closed.")
        except psutil.Error:
            continue
    cutoff = time.time() - 3600
    for k in [k for k, t in handled.items() if t < cutoff]:
        del handled[k]


def foreground_process_name():
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    try:
        return psutil.Process(pid.value).name()
    except psutil.Error:
        return None


class FocusTracker:
    """Logs the program in front, once it has been there for 2 checks in a row."""

    def __init__(self):
        self.cand, self.n, self.logged = None, 0, None

    def reset(self):
        self.cand, self.n, self.logged = None, 0, None

    def update(self):
        name = foreground_process_name()
        if name == self.cand:
            self.n += 1
        else:
            self.cand, self.n = name, 1
        if self.n < 2 or not name or name == self.logged:
            return
        self.logged = name
        low = name.lower()
        if low in IGNORE_FOCUS or low in BLOCKLIST:
            return
        log("APP_FOCUS", f"Switched to {name}", site=name)


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    global session, _native_out
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="ExamGuard desktop monitor")
    ap.add_argument("--always", action="store_true",
                    help="run by hand and enforce the whole time (testing, no extension needed)")
    ap.add_argument("--config", default=os.path.join(here, "config.js"),
                    help="path to the extension's config.js")
    # Chrome adds "chrome-extension://<id>/" (and --parent-window=N) to the command line.
    args, extra = ap.parse_known_args()
    native = any(a.startswith("chrome-extension://") for a in extra)

    if native:
        # stdout is the message channel to Chrome: anything else printed there would
        # break it, so send every print() to a log file instead.
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.__stdout__.fileno(), os.O_BINARY)
        _native_out = sys.__stdout__.buffer     # the real channel to Chrome (see send_native)
        try:
            sys.stdout = sys.stderr = open(os.path.join(here, "exam_monitor.log"), "w", encoding="utf-8", buffering=1)
        except OSError:
            sys.stdout = sys.stderr = open(os.devnull, "w")
    elif not args.always:
        sys.exit("This program is started by the ExamGuard Chrome extension.\n"
                 "Install it once with:  python install_host.py <extension-id>\n"
                 "(To test by hand, run:  python exam_monitor.py --always)")

    load_config(args.config)
    session = Session(args.always)
    mic_restore()   # undo a microphone switch-off left behind by a crashed run

    if WEBHOOK_URL:
        threading.Thread(target=sender, daemon=True).start()
    if native:
        threading.Thread(target=native_reader, daemon=True).start()
    if BLOCK_SCREENSHOTS:
        threading.Thread(target=_hook_thread, daemon=True).start()

    print("=" * 62)
    print(" ExamGuard desktop monitor")
    print("=" * 62)
    print(" During an exam this program:")
    print("   - closes these programs: " + ", ".join(sorted(set(BLOCKLIST.values()))))
    print("   - records the NAME of the program you switch to (no titles)")
    print("   - switches the microphone off and reports programs that still use it")
    print("   - blocks the screenshot keys (it reads no other keys)")
    print("   - sends those events to your teacher")
    print(" Mode: " + ("always on" if args.always else "started by the Chrome extension"))
    print(" Press Ctrl+C to stop.")
    print("=" * 62)

    focus = FocusTracker()
    try:
        while True:
            session.tick()
            if session.active:
                mic_block()
                scan_blocklist()
                mic_check()
                shot_check()
                if LOG_FOCUS_CHANGES:
                    focus.update()
            else:
                focus.reset()
                if mic_blocked:
                    mic_restore()
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        mic_restore()


if __name__ == "__main__":
    main()
