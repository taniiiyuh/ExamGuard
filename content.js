/* ExamGuard - content script (runs inside the Google Form page) */
(() => {
  "use strict";
  if (window.top !== window) return;

  let state = null;
  let host = null, shadow = null, bar = null, ov = null, clipStyle = null;
  let shownNotice = -1, shownBlocked = false, pageHidden = false, bound = false;
  let countdownTimer = null, hiddenTimer = null, blurSince = 0, blurReported = false;
  const loadedAt = Date.now();
  const lastSent = {};

  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); }
    catch { return Promise.resolve(null); }
  };
  const sendThrottled = (kind, detail, ms) => {
    const now = Date.now();
    if (now - (lastSent[kind + detail] || 0) < ms) return;
    lastSent[kind + detail] = now;
    send({ type: "EVENT", kind, detail });
  };

  /* ---------------------------- UI ---------------------------- */
  const CSS = `
    .bar{position:fixed;top:8px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;
      font:600 12px/1 system-ui,sans-serif;padding:7px 14px;border-radius:999px;opacity:.9;pointer-events:none}
    .ov{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      background:rgba(8,10,18,.97);font-family:system-ui,sans-serif;pointer-events:auto}
    .ov[hidden]{display:none}
    .card{background:#fff;color:#111827;max-width:460px;width:calc(100% - 40px);border-radius:16px;
      padding:28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .icon{font-size:44px}
    h1{margin:8px 0 6px;font-size:22px;color:#b91c1c}
    p{margin:8px 0;font-size:15px;line-height:1.45}
    .count{display:inline-block;margin-top:6px;background:#fee2e2;color:#991b1b;border-radius:999px;
      padding:5px 12px;font-weight:700;font-size:13px}
    button{margin-top:16px;border:0;border-radius:10px;padding:11px 18px;font-size:15px;font-weight:600;
      background:#2563eb;color:#fff;cursor:pointer}
    button:disabled{background:#9ca3af;cursor:not-allowed}
    button.secondary{background:#6b7280;margin-left:8px}
    .teacher{margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb}
    .small{font-size:12px;color:#6b7280;margin-bottom:6px}
    .teacher input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px}
    .err{color:#b91c1c;font-size:13px;min-height:16px;margin-top:6px}
  `;

  function ensureUI() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;" +
      "z-index:2147483647!important;pointer-events:none!important;visibility:visible!important;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    bar = document.createElement("div"); bar.className = "bar";
    ov = document.createElement("div"); ov.className = "ov"; ov.hidden = true;
    shadow.append(style, bar, ov);
    (document.documentElement || document).appendChild(host);
    shownNotice = -1; shownBlocked = false;
  }

  function card(icon, title, lines, countText) {
    const c = document.createElement("div"); c.className = "card";
    const add = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      e.textContent = text; c.appendChild(e);
    };
    add("div", "icon", icon);
    add("h1", "", title);
    lines.forEach((l) => add("p", "", l));
    if (countText) add("span", "count", countText);
    return c;
  }

  function showWarning() {
    const left = Math.max(0, state.max - state.warnings);
    const c = card("⚠️", "Warning: exam rule violation",
      [state.noticeText,
       left <= 1
         ? "FINAL WARNING: your next violation will end your exam permanently and you will not be able to return to it."
         : `You were returned to the exam. At ${state.max} warnings your exam ends automatically and you cannot return.`],
      `Warning ${state.warnings} of ${state.max}`);
    const btn = document.createElement("button");
    btn.disabled = true;
    let n = 5;
    btn.textContent = `Continue exam (${n})`;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(countdownTimer);
        btn.disabled = false;
        btn.textContent = "I understand - continue exam";
      } else btn.textContent = `Continue exam (${n})`;
    }, 1000);
    const id = state.noticeId;
    btn.onclick = () => { state.ackId = id; send({ type: "ACK", id }); render(); };
    c.appendChild(btn);
    ov.replaceChildren(c);
    ov.hidden = false;
  }

  // Permanent "exam ended" screen. The form stays hidden behind it.
  function showBlocked() {
    const lines = [
      `You reached the maximum of ${state.max} rule violations, so your exam was ended automatically.`,
      "You can no longer open this exam. Your teacher has been notified."
    ];
    if (state.reason) lines.push(`Last violation: ${state.reason}`);
    const c = card("⛔", "Your exam has ended", lines, `Warnings ${state.max} of ${state.max}`);

    if (state.canReinstate) {
      const box = document.createElement("div"); box.className = "teacher";
      const label = document.createElement("div"); label.className = "small";
      label.textContent = "Teacher / proctor only";
      const input = document.createElement("input");
      input.type = "password"; input.placeholder = "Passcode"; input.autocomplete = "off";
      const msg = document.createElement("div"); msg.className = "err";
      const btn = document.createElement("button"); btn.textContent = "Reinstate student";
      const go = async () => {
        if (!input.value) { msg.textContent = "Enter the passcode."; return; }
        btn.disabled = true; msg.textContent = "";
        const r = await send({ type: "TEACHER", action: "reinstate", passcode: input.value });
        input.value = ""; btn.disabled = false;
        if (r && r.ok) location.href = r.url || location.href;
        else msg.textContent = (r && r.error) || "Could not verify. Try again.";
      };
      btn.onclick = go;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      box.append(label, input, msg, btn);
      c.appendChild(box);
    }
    ov.replaceChildren(c);
    ov.hidden = false;
  }

  function hidePage() {
    document.documentElement.style.setProperty("visibility", "hidden", "important");
    pageHidden = true;
  }

  function restorePage() {
    if (pageHidden) { document.documentElement.style.removeProperty("visibility"); pageHidden = false; }
  }

  function renderBlocked() {
    ensureUI();
    bindGuards();
    bar.textContent = "⛔ Exam ended";
    hidePage();
    if (!shownBlocked) { shownBlocked = true; showBlocked(); }
  }

  function render() {
    if (state && state.blocked) return renderBlocked();
    if (!state || !state.active) return teardown();
    ensureUI();
    bindGuards();
    bar.textContent = `🔒 Exam mode • Warnings ${state.warnings}/${state.max} • Activity is logged`;
    shownBlocked = false;
    restorePage();

    if (state.noticeId > state.ackId) {
      if (shownNotice !== state.noticeId) { shownNotice = state.noticeId; showWarning(); }
    } else {
      shownNotice = -1;
      clearInterval(countdownTimer);
      ov.hidden = true;
    }
  }

  function teardown() {
    clearInterval(countdownTimer);
    restorePage();
    shownBlocked = false;
    if (host) { host.remove(); host = null; }
    unbindGuards();
  }

  /* --------------------------- guards -------------------------- */
  function onVisibility() {
    clearTimeout(hiddenTimer);
    if (document.visibilityState !== "hidden") return;
    // Wait so a normal page unload (e.g. submitting the form) is not flagged.
    hiddenTimer = setTimeout(() => {
      if (document.visibilityState === "hidden") send({ type: "EVENT", kind: "PAGE_HIDDEN" });
    }, 500);
  }

  function onContextMenu(e) { e.preventDefault(); }

  function onClipboard(e) {
    if (!state || !state.blockClipboard) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendThrottled("BLOCKED", `Blocked ${e.type}`, 5000);
  }

  function onKey(e) {
    if (!state || !state.blockDevtools) return;
    const c = e.code, ctrl = e.ctrlKey || e.metaKey;
    const dev =
      c === "F12" ||
      (ctrl && e.shiftKey && ["KeyI", "KeyJ", "KeyC"].includes(c)) ||
      (e.metaKey && e.altKey && ["KeyI", "KeyJ", "KeyC", "KeyU"].includes(c)) ||
      (ctrl && c === "KeyU");
    const other = ctrl && ["KeyS", "KeyP"].includes(c);
    if (!dev && !other) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (dev) sendThrottled("DEVTOOLS_KEY", `Pressed ${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Cmd+" : ""}${e.shiftKey ? "Shift+" : ""}${c}`, 3000);
    else sendThrottled("BLOCKED", `Blocked ${c} shortcut`, 5000);
  }

  // PrintScreen only fires keyup in the browser: wipe what it copied, then report it.
  function onKeyUp(e) {
    if (!state || !state.active || e.code !== "PrintScreen") return;
    e.preventDefault();
    try { navigator.clipboard.writeText(" ").catch(() => {}); } catch {}
    sendThrottled("SCREENSHOT", "Pressed PrintScreen", 3000);
  }

  const clipEvents = ["copy", "cut", "paste", "drop", "dragstart"];

  function bindGuards() {
    if (bound) return;
    bound = true;
    document.addEventListener("visibilitychange", onVisibility, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    clipEvents.forEach((n) => document.addEventListener(n, onClipboard, true));
    if (state && state.blockClipboard && !clipStyle) {
      clipStyle = document.createElement("style");
      clipStyle.textContent = "*:not(input):not(textarea){-webkit-user-select:none!important;user-select:none!important}";
      (document.head || document.documentElement).appendChild(clipStyle);
    }
  }

  function unbindGuards() {
    if (!bound) return;
    bound = false;
    document.removeEventListener("visibilitychange", onVisibility, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKeyUp, true);
    clipEvents.forEach((n) => document.removeEventListener(n, onClipboard, true));
    if (clipStyle) { clipStyle.remove(); clipStyle = null; }
  }

  /* ------------------- real submission detection --------------- */
  // /formResponse is also used for every "Next" section. A section page still
  // contains the form's hidden pageHistory field / answer inputs; the final
  // "Your response has been recorded" page does not.
  let submittedSent = false;
  function checkSubmitted() {
    if (submittedSent || !state || !state.active) return;
    if (!/\/formResponse/.test(location.pathname)) return;
    if (document.readyState !== "complete" || Date.now() - loadedAt < 2000) return;
    const confirmation = !!document.querySelector(
      'a[href*="form_confirm"], .freebirdFormviewerViewResponseConfirmationMessage');
    const stillAForm = !!document.querySelector('input[name="pageHistory"], [name^="entry."]');
    if (confirmation || !stillAForm) {
      submittedSent = true;
      send({ type: "SUBMITTED" });
    }
  }

  /* ----------------------- sync with background ---------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "STATE") { state = msg.state; render(); }
  });

  async function sync() {
    const r = await send({ type: "GET_STATE" });
    if (r && r.state) { state = r.state; render(); }
    else if (!(state && state.blocked)) restorePage();
  }

  // Heartbeat: re-sync, restore overlay if someone removed it, detect lost focus.
  setInterval(() => {
    sync();
    if (!state || !state.active) { blurSince = 0; blurReported = false; return; }
    if (host && !host.isConnected) render();
    checkSubmitted();
    if (Date.now() - loadedAt < 4000) return;
    if (document.visibilityState === "visible" && !document.hasFocus()) {
      blurSince = blurSince || Date.now();
      if (!blurReported && Date.now() - blurSince > 1500) {
        blurReported = true;
        send({ type: "EVENT", kind: "FOCUS_LOST" });
      }
    } else { blurSince = 0; blurReported = false; }
  }, 1000);

  // Hide the form until the background says whether it is blocked for this
  // student (prevents a flash of the questions). Fail-safe: show after 1.5 s.
  if (/\/(viewform|formResponse)/.test(location.pathname)) {
    hidePage();
    setTimeout(() => { if (!(state && state.blocked)) restorePage(); }, 1500);
  }
  sync();
})();
