/* ExamGuard - background service worker */
importScripts("config.js");

const CFG = EXAM_CONFIG;

// Local desktop monitor (exam_monitor.py). Chrome starts it through Native Messaging
// when an exam starts and it exits when the exam ends (see install_host.py).
// Set monitorHost: "" in config.js to turn this off.
const MONITOR_HOST = CFG.monitorHost === undefined ? "com.examguard.monitor" : CFG.monitorHost;
let monitorPort = null;
let monitorErrAt = 0;
let lastBeatAt = 0;

// Connecting is what launches the program. An open native port also keeps this
// service worker alive for the whole exam.
function connectMonitor() {
  if (monitorPort) return monitorPort;
  let port;
  try { port = chrome.runtime.connectNative(MONITOR_HOST); }
  catch (e) { reportMonitorProblem(String(e)); return null; }
  monitorPort = port;
  // The monitor tells us when a program (e.g. Chrome's Gemini Live) is recording
  // from the microphone during the exam.
  port.onMessage.addListener((m) => {
    if (!m) return;
    if (m.type === "SCREENSHOT_KEY") {          // screenshot key blocked by the desktop monitor
      fire(async () => {
        const s = await getSession();
        if (s.active) await applyViolation("SCREENSHOT", `Screenshot shortcut blocked (${clip(m.key, 30)})`);
      });
      return;
    }
    if (m.type !== "MIC_IN_USE") return;
    const app = clip(m.app, 60);
    fire(async () => {
      const s = await getSession();
      if (!s.active) return;
      await applyViolation("MIC_USED", `Microphone in use by ${app}`, {
        page: { site: clip(m.app, 100), title: "", url: "" }
      });
    });
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    if (monitorPort === port) monitorPort = null;
    if (err && !port.ending) reportMonitorProblem(err);
  });
  return port;
}

// Host missing / crashed / not installed: log it once in a while so the teacher sees it.
function reportMonitorProblem(err) {
  if (Date.now() - monitorErrAt < 5 * 60 * 1000) return;
  monitorErrAt = Date.now();
  fire(async () => {
    const s = await getSession();
    if (!s.active) return;
    await record(s, "MONITOR_UNAVAILABLE", "Desktop monitor not running: " + clip(err, 120));
  });
}

function notifyMonitor(action, s) {
  if (!MONITOR_HOST) return;
  const msg = { action, student: (s && s.student) || "", form: (s && s.formUrl) || "" };
  if (action === "end") {
    const port = monitorPort;
    if (!port) return;
    port.ending = true;
    monitorPort = null;                       // the next exam gets a fresh process
    try { port.postMessage(msg); } catch {}
    // The monitor sends its last log rows and quits by itself; this is only a safety net.
    setTimeout(() => { try { port.disconnect(); } catch {} }, 20000);
    return;
  }
  const port = connectMonitor();              // "start" / "beat": launch it if it is not running
  if (!port) return;
  try { port.postMessage(msg); } catch {}
}

const SESSION_KEY = "examSession";
const FORM_PATH_RE = /^\/(u\/\d+\/)?forms\//;

const MESSAGES = {
  NEW_TAB: "You tried to open a new tab.",
  TAB_SWITCH: "You switched to another tab.",
  NEW_WINDOW: "You tried to open a new browser window.",
  OTHER_WINDOW: "You switched to another browser window.",
  NAVIGATED_AWAY: "You tried to leave the exam page.",
  LEFT_BROWSER: "You left the exam (another app, window or the address bar was used).",
  PAGE_HIDDEN: "The exam page was hidden or minimised.",
  EXAM_TAB_CLOSED: "You closed the exam tab.",
  FULLSCREEN_EXIT: "You exited full-screen mode.",
  DEVTOOLS: "You tried to open developer tools or view the page source.",
  RESTART: "The browser was closed or restarted during the exam.",
  SCREENSHOT: "Screenshots are not allowed during the exam.",
  MIC_USED: "The microphone was used. Voice assistants (such as Gemini Live) are not allowed during the exam."
};

let suppressUntil = 0;   // ignore our own tab/window creation
let fsSettleUntil = 0;   // ignore bounds events while entering full-screen

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession() {
  const o = await chrome.storage.local.get(SESSION_KEY);
  return o[SESSION_KEY] || { active: false };
}
const setSession = (s) => chrome.storage.local.set({ [SESSION_KEY]: s });

// Run async work strictly one-at-a-time so storage read/modify/write never races.
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error("[ExamGuard]", e));
  return p;
}
const fire = (fn) => serial(fn).catch(() => {});

function parse(url) { try { return new URL(url); } catch { return null; } }

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

// What we log about a page the student opened. Query strings are only kept
// when urlDetail is "full" (they can hold tokens / personal data).
function pageInfo(url, title) {
  const u = parse(url || "");
  const web = !!u && /^https?:$/.test(u.protocol);
  let site = "", shown = "";
  if (web) {
    site = u.hostname.replace(/^www\./, "");
    if (CFG.urlDetail === "full") shown = u.href;
    else if (CFG.urlDetail === "path") shown = u.origin + u.pathname;
  } else if (url) {
    site = url.split(/[?#]/)[0];            // chrome://newtab, about:blank ...
  }
  return {
    site: clip(site, 100),
    url: clip(shown, 250),
    title: CFG.logPageTitles ? clip(title, 120) : ""
  };
}

function formId(url) {
  const u = parse(url);
  const m = u && u.pathname.match(/\/forms\/d\/(?:e\/)?([^/]+)/);
  return m ? m[1] : null;
}

function isExamFormUrl(url) {
  const u = parse(url);
  if (!u || u.hostname !== "docs.google.com" || !FORM_PATH_RE.test(u.pathname)) return false;
  if (!/\/(viewform|formResponse)\b/.test(u.pathname)) return false;
  if (CFG.formUrl) return formId(url) === formId(CFG.formUrl);
  return true;
}

// Pages the exam tab is allowed to be on.
function isAllowedExamTabUrl(url) {
  const u = parse(url);
  if (!u) return false;
  if (u.hostname === "accounts.google.com") return true; // sign-in / verification
  return isExamFormUrl(url);
}

async function getEmail() {
  try {
    const i = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return i.email || "unknown";
  } catch { return "unknown"; }
}

async function sha256(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function passcodeOk(p) {
  return !!CFG.passcodeSha256 && (await sha256(p || "")) === CFG.passcodeSha256.trim().toLowerCase();
}

function viewOf(s, active = true) {
  return {
    active: !!(s.active && active),
    canReinstate: !!CFG.passcodeSha256,
    warnings: s.warnings || 0,
    max: CFG.maxWarnings,
    noticeId: s.noticeId || 0,
    ackId: s.ackId || 0,
    noticeText: s.noticeText || "",
    blockClipboard: CFG.blockClipboard,
    blockDevtools: CFG.blockDevtoolsShortcuts
  };
}

function blockedView(reason) {
  return {
    active: false, blocked: true, reason: reason || "",
    warnings: CFG.maxWarnings, max: CFG.maxWarnings,
    canReinstate: !!CFG.passcodeSha256,
    blockClipboard: CFG.blockClipboard, blockDevtools: CFG.blockDevtoolsShortcuts
  };
}

async function getTerminated() {
  const { terminatedForms = {} } = await chrome.storage.local.get("terminatedForms");
  return terminatedForms;
}

async function isTerminated(url) {
  const id = formId(url);
  return !!(id && (await getTerminated())[id]);
}

async function pushState(s) {
  try { await chrome.tabs.sendMessage(s.examTabId, { type: "STATE", state: viewOf(s) }); } catch {}
}

/* ------------------------------------------------------------------ */
/* logging                                                             */
/* ------------------------------------------------------------------ */
async function record(s, type, detail, counted = false, extra = {}) {
  const entry = {
    time: new Date().toISOString(),
    student: s.student || "unknown",
    form: s.formUrl || "",
    type, detail, counted,
    warnings: s.warnings || 0,
    site: extra.site || "",
    title: extra.title || "",
    url: extra.url || "",
    awaySec: extra.awaySec || 0
  };
  const { examLog = [] } = await chrome.storage.local.get("examLog");
  examLog.push(entry);
  await chrome.storage.local.set({ examLog: examLog.slice(-300) });
  if (CFG.webhookUrl) {
    fetch(CFG.webhookUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...entry, secret: CFG.webhookSecret || "" })
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */
async function goFullscreen(windowId) {
  if (!CFG.requireFullscreen) return;
  fsSettleUntil = Date.now() + 2500;
  try { await chrome.windows.update(windowId, { state: "fullscreen" }); } catch {}
}

async function maybeStart(tabId, url) {
  if (!isExamFormUrl(url) || /\/formResponse/.test(url)) return;
  if (await isTerminated(url)) return; // exam already ended for this form
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const s = {
    active: true,
    examTabId: tabId, formUrl: url, lastGoodUrl: url,
    warnings: 0, lastCountAt: 0, noticeId: 0, ackId: 0, noticeText: "",
    startedAt: Date.now(), student: await getEmail()
  };
  await setSession(s);
  await record(s, "SESSION_START", "Exam mode started");
  notifyMonitor("start", s);
  await goFullscreen(tab.windowId);
  await pushState(s);
}

async function endSession(s, type, detail) {
  await record(s, type, detail, false);
  notifyMonitor("end", s);
  const tabId = s.examTabId;
  await setSession({ active: false });
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { state: "maximized" });
  } catch {}
  try { await chrome.tabs.sendMessage(tabId, { type: "STATE", state: { active: false } }); } catch {}
}

async function reopenExamTab(s) {
  suppressUntil = Date.now() + 3000;
  let win;
  try {
    win = await chrome.windows.create({
      url: s.lastGoodUrl, focused: true,
      state: CFG.requireFullscreen ? "fullscreen" : "maximized"
    });
  } catch {
    win = await chrome.windows.create({ url: s.lastGoodUrl, focused: true });
  }
  const tabs = await chrome.tabs.query({ windowId: win.id });
  if (tabs[0]) { s.examTabId = tabs[0].id; await setSession(s); }
}

/* ------------------------------------------------------------------ */
/* violation handling                                                  */
/* ------------------------------------------------------------------ */

// Drag the student back to the exam (focus window, activate exam tab, restore URL).
async function enforce(s) {
  let tab;
  try { tab = await chrome.tabs.get(s.examTabId); }
  catch { return reopenExamTab(s); }
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (CFG.requireFullscreen) {
      fsSettleUntil = Date.now() + 2000;
      await chrome.windows.update(tab.windowId, { state: "fullscreen" });
    }
  } catch (e) { console.warn("[ExamGuard] enforce:", e); }
  if (tab.url && !isAllowedExamTabUrl(tab.url)) {
    // Go back in history first (keeps the section/answers the student was on),
    // then fall back to reloading the last form page if that didn't work.
    let wentBack = false;
    try { await chrome.tabs.goBack(tab.id); wentBack = true; } catch {}
    if (wentBack) {
      await sleep(1500);
      try {
        const t2 = await chrome.tabs.get(tab.id);
        if (t2.url && isAllowedExamTabUrl(t2.url)) return;
      } catch { return; }
    }
    try { await chrome.tabs.update(tab.id, { url: s.lastGoodUrl }); } catch {}
  }
}

// Reached the warning limit: end the exam for good and block the form.
async function terminateExam(s, type) {
  const id = formId(s.formUrl) || "unknown";
  const terminated = await getTerminated();
  terminated[id] = {
    time: new Date().toISOString(),
    student: s.student || "unknown",
    reason: MESSAGES[type] || "Too many rule violations.",
    url: s.lastGoodUrl
  };
  await chrome.storage.local.set({ terminatedForms: terminated });
  await record(s, "EXAM_TERMINATED",
    `Reached ${CFG.maxWarnings} warnings - exam ended and form blocked`, false);
  notifyMonitor("end", s);

  const tabId = s.examTabId;
  await setSession({ active: false });       // release the browser
  await enforce(s);                          // one last pull-back so the student sees the notice
  try {
    const t = await chrome.tabs.get(s.examTabId);
    await chrome.windows.update(t.windowId, { state: "maximized" });
  } catch {}
  try {
    await chrome.tabs.sendMessage(s.examTabId || tabId, {
      type: "STATE", state: blockedView(terminated[id].reason)
    });
  } catch {}
}

async function applyViolation(type, detail, opts = {}) {
  const s = await getSession();
  if (!s.active) return;
  let counted = false;
  const now = Date.now();
  if (!opts.logOnly && now - (s.lastCountAt || 0) > CFG.countCooldownMs) {
    counted = true;
    s.warnings = (s.warnings || 0) + 1;
    s.lastCountAt = now;
    s.noticeId = (s.noticeId || 0) + 1;
    s.noticeText = MESSAGES[type] || "Suspicious activity was detected.";
  }
  if (opts.awayFrom && !s.awaySince) s.awaySince = opts.awayFrom;
  await setSession(s);
  await record(s, type, detail, counted, opts.page);
  if (counted && s.warnings >= CFG.maxWarnings) return terminateExam(s, type);
  if (!opts.logOnly) await enforce(s);
  await pushState(s);
}

async function examWindowId(s) {
  try { return (await chrome.tabs.get(s.examTabId)).windowId; } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* browser event listeners                                             */
/* ------------------------------------------------------------------ */

// Exam tab navigation + auto-start / auto-end
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== "complete") return;
  fire(async () => {
    const s = await getSession();
    const url = info.url || tab.url;
    if (!url) return;
    if (!s.active) return maybeStart(tabId, url);
    if (tabId !== s.examTabId) return;

    // NOTE: /formResponse is ALSO the URL of every "Next" section in a
    // multi-page form, so the URL alone never ends the session. The content
    // script detects the real confirmation page and sends "SUBMITTED".
    if (isAllowedExamTabUrl(url)) {
      if (isExamFormUrl(url) && !/\/formResponse/.test(url) && s.lastGoodUrl !== url) {
        s.lastGoodUrl = url; await setSession(s);
      }
      return pushState(s);
    }
    const page = pageInfo(url, tab.title);
    await applyViolation("NAVIGATED_AWAY", `Exam tab tried to open ${page.site}`, { page });
  });
});

// New tab -> close it
chrome.tabs.onCreated.addListener((tab) => {
  if (Date.now() < suppressUntil) return;
  fire(async () => {
    const s = await getSession();
    if (!s.active || tab.id === s.examTabId) return;
    const page = pageInfo(tab.pendingUrl || tab.url || "", tab.title);
    chrome.tabs.remove(tab.id).catch(() => {});
    await applyViolation("NEW_TAB", "Opened a new tab", { page });
  });
});

// Switch to another existing tab -> pull back
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (Date.now() < suppressUntil) return;
  fire(async () => {
    const s = await getSession();
    if (!s.active || tabId === s.examTabId) return;
    let page;
    try { const t = await chrome.tabs.get(tabId); page = pageInfo(t.url || t.pendingUrl, t.title); } catch {}
    await applyViolation("TAB_SWITCH", "Switched to another tab", { page });
  });
});

// New browser window -> close it
chrome.windows.onCreated.addListener((win) => {
  if (Date.now() < suppressUntil) return;
  fire(async () => {
    const s = await getSession();
    if (!s.active) return;
    const wid = await examWindowId(s);
    if (wid === null || win.id === wid) return;
    let page;
    try {
      const w = await chrome.windows.get(win.id, { populate: true });
      const t = w.tabs && w.tabs[0];
      if (t) page = pageInfo(t.pendingUrl || t.url, t.title);
    } catch {}
    chrome.windows.remove(win.id).catch(() => {});
    await applyViolation("NEW_WINDOW", "Opened a new browser window", { page });
  });
});

// Focus left the exam window (other app such as Word/PDF/AI app, or another window)
chrome.windows.onFocusChanged.addListener((winId) => {
  if (Date.now() < suppressUntil) return;
  const t0 = Date.now();
  fire(async () => {
    const s = await getSession();
    if (!s.active) return;
    if (winId === chrome.windows.WINDOW_ID_NONE) {
      await sleep(CFG.focusLossGraceMs);
      let w;
      try { w = await chrome.windows.getLastFocused(); } catch { return; }
      if (w.focused) return;
      // Chrome cannot see WHICH app took focus - only that it left.
      await applyViolation("LEFT_BROWSER", "Browser lost focus (switched to another app or window)", {
        awayFrom: t0,
        page: { site: "Outside Chrome (app name not visible to Chrome)", title: "", url: "" }
      });
      return;
    }
    if (s.awaySince) {                     // focus is back: log how long they were away
      const sec = Math.round((Date.now() - s.awaySince) / 1000);
      s.awaySince = 0;
      await setSession(s);
      await record(s, "RETURNED", `Back in Chrome after ${sec}s outside it`, false, { awaySec: sec });
    }
    const wid = await examWindowId(s);
    if (wid !== null && winId !== wid) {
      let page;
      try {
        const [t] = await chrome.tabs.query({ windowId: winId, active: true });
        if (t) page = pageInfo(t.url, t.title);
      } catch {}
      await applyViolation("OTHER_WINDOW", "Focused another browser window", { page });
    }
  });
});

// Left full-screen (F11 etc.)
chrome.windows.onBoundsChanged.addListener((win) => {
  if (!CFG.requireFullscreen || Date.now() < fsSettleUntil || Date.now() < suppressUntil) return;
  fire(async () => {
    const s = await getSession();
    if (!s.active || (await examWindowId(s)) !== win.id) return;
    const w = await chrome.windows.get(win.id);
    if (w.state !== "fullscreen") await applyViolation("FULLSCREEN_EXIT", "Exited full-screen mode");
  });
});

// Exam tab/window closed -> reopen it
chrome.tabs.onRemoved.addListener((tabId) => {
  if (Date.now() < suppressUntil) return;
  fire(async () => {
    const s = await getSession();
    if (!s.active || tabId !== s.examTabId) return;
    await applyViolation("EXAM_TAB_CLOSED", "Closed the exam tab");
  });
});

// Browser restarted mid-exam -> reopen exam and count it
chrome.runtime.onStartup.addListener(() => {
  suppressUntil = Date.now() + 3000;
  fire(async () => {
    const s = await getSession();
    if (!s.active) return;
    await applyViolation("RESTART", "Browser restarted during the exam");
  });
});

/* ------------------------------------------------------------------ */
/* messages from content script and popup                              */
/* ------------------------------------------------------------------ */
async function handleMessage(msg, sender) {
  const s = await getSession();
  const fromExamTab = !!(s.active && sender.tab && sender.tab.id === s.examTabId);

  switch (msg.type) {
    case "GET_STATE": {
      // The content script polls this every second, so it doubles as a heartbeat.
      if (fromExamTab && Date.now() - lastBeatAt > 10000) {
        lastBeatAt = Date.now();
        notifyMonitor("beat", s);
      }
      const id = formId((sender.tab && sender.tab.url) || "");
      const info = id && (await getTerminated())[id];
      if (info) return { state: blockedView(info.reason) };
      return { state: viewOf(s, fromExamTab) };
    }

    case "ACK":
      if (fromExamTab) { s.ackId = Math.max(s.ackId || 0, msg.id | 0); await setSession(s); }
      return { ok: true };

    case "EVENT":
      if (!fromExamTab) return { ok: false };
      if (msg.kind === "PAGE_HIDDEN") await applyViolation("PAGE_HIDDEN", "Exam page was hidden or minimised");
      else if (msg.kind === "FOCUS_LOST") await applyViolation("LEFT_BROWSER", "Exam page lost focus (another window, app or address bar)");
      else if (msg.kind === "SCREENSHOT") await applyViolation("SCREENSHOT", String(msg.detail || "").slice(0, 80));
      else if (msg.kind === "DEVTOOLS_KEY") await applyViolation("DEVTOOLS", String(msg.detail || "").slice(0, 80));
      else if (msg.kind === "BLOCKED") await applyViolation("BLOCKED_ACTION", String(msg.detail || "").slice(0, 80), { logOnly: true });
      return { ok: true };

    case "SUBMITTED":
      if (fromExamTab && /\/formResponse/.test(sender.tab.url || "")) {
        await endSession(s, "SUBMITTED", "Form submitted - exam session ended");
      }
      return { ok: true };

    case "TEACHER": {
      // Optional: lets the teacher reinstate a student who was ended by mistake.
      if (!CFG.passcodeSha256) return { ok: false, error: "Reinstating is disabled." };
      const url = (sender.tab && sender.tab.url) || "";
      const id = formId(url);
      const terminated = await getTerminated();
      const info = id && terminated[id];
      if (!info) return { ok: false, error: "Not available here." };

      const { passGuard = {} } = await chrome.storage.local.get("passGuard");
      const now = Date.now();
      if (now < (passGuard.blockedUntil || 0)) {
        return { ok: false, error: `Too many attempts. Wait ${Math.ceil((passGuard.blockedUntil - now) / 1000)}s.` };
      }
      const stub = { student: info.student, formUrl: url, warnings: 0 };
      if (!(await passcodeOk(msg.passcode))) {
        passGuard.failed = (passGuard.failed || 0) + 1;
        if (passGuard.failed >= 5) { passGuard.blockedUntil = now + 60000; passGuard.failed = 0; }
        await chrome.storage.local.set({ passGuard });
        await record(stub, "BAD_PASSCODE", "Wrong teacher passcode entered");
        return { ok: false, error: "Wrong passcode." };
      }
      await chrome.storage.local.set({ passGuard: {} });
      delete terminated[id];
      await chrome.storage.local.set({ terminatedForms: terminated });
      await record(stub, "TEACHER_REINSTATE", "Teacher reinstated the student");
      return { ok: true, url: info.url || url };
    }

    case "POPUP_STATUS":
      return { active: !!s.active, warnings: s.warnings || 0, max: CFG.maxWarnings };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => handleMessage(msg, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

// The service worker woke up in the middle of an exam (e.g. the browser was
// restarted): bring the desktop monitor back right away.
fire(async () => {
  const s = await getSession();
  if (s.active) notifyMonitor("beat", s);
});
