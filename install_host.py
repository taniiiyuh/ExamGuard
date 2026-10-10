"""
Registers the ExamGuard desktop monitor as a Chrome Native Messaging host (Windows).
Run it ONCE per computer, from the folder that contains exam_monitor.py and native_host.bat.

  python install_host.py <extension-id>                install for the current Windows user
  python install_host.py <extension-id> --all-users    install for everyone (run as Administrator)
  python install_host.py --uninstall                   remove it again

The extension id is shown at chrome://extensions (32 letters, a-p).
Only that extension is allowed to start the monitor.
"""
import argparse
import json
import os
import re
import sys

if os.name != "nt":
    sys.exit("This installer only works on Windows.")
import winreg

HOST = "com.examguard.monitor"
REG_KEY = "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, HOST + ".json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("extension_id", nargs="?")
    ap.add_argument("--all-users", action="store_true", help="write to HKLM instead of HKCU (needs Administrator)")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()
    hive = winreg.HKEY_LOCAL_MACHINE if args.all_users else winreg.HKEY_CURRENT_USER

    if args.uninstall:
        for h in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                winreg.DeleteKey(h, REG_KEY)
            except OSError:
                pass
        if os.path.exists(MANIFEST):
            os.remove(MANIFEST)
        print("ExamGuard monitor unregistered.")
        return

    if not args.extension_id or not re.fullmatch(r"[a-p]{32}", args.extension_id):
        sys.exit("Give the 32-letter extension id from chrome://extensions, e.g.\n"
                 "  python install_host.py abcdefghijklmnopabcdefghijklmnop")
    host_bat = os.path.join(HERE, "native_host.bat")
    if not os.path.exists(host_bat) or not os.path.exists(os.path.join(HERE, "exam_monitor.py")):
        sys.exit("native_host.bat and exam_monitor.py must be in the same folder as this file.")

    manifest = {
        "name": HOST,
        "description": "ExamGuard desktop monitor",
        "path": host_bat,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://" + args.extension_id + "/"],
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    with winreg.CreateKeyEx(hive, REG_KEY, 0, winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)

    print("Done. Chrome can now start the ExamGuard monitor when an exam starts.")
    print("  host manifest:", MANIFEST)
    print("  registry     :", ("HKLM\\" if args.all_users else "HKCU\\") + REG_KEY)
    print("Do not move this folder afterwards (or run this installer again from the new place).")
    print("Make sure psutil is installed:  pip install psutil")


if __name__ == "__main__":
    main()
