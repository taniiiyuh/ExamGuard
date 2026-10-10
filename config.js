/*
 * ExamGuard configuration - edit BEFORE you package / deploy the extension.
 * Students never see a settings screen, so they cannot change these values.
 * (A student CAN still read this file from the installed extension folder,
 *  so never put anything in here that must stay secret from students.)
 */
const EXAM_CONFIG = {
  // The student link of your Google Form, e.g.
  // "https://docs.google.com/forms/d/e/1FAIpQLSxxxxxxxx/viewform"
  // Use the full docs.google.com link (not forms.gle). Leave "" to guard ANY
  // Google Form a student opens.
  formUrl: "",

  // Warnings before the exam is ENDED for good.
  maxWarnings: 3,

  // Block copy / cut / paste / drag-drop / text selection on the form page.
  blockClipboard: true,

  // Block F12, Ctrl+Shift+I/J/C, Ctrl+U (counted as a violation), Ctrl+S, Ctrl+P.
  blockDevtoolsShortcuts: true,

  // OPTIONAL teacher override (hash made with make-passcode-hash.html).
  // Leave "" for a fully final ending with no way back.
  passcodeSha256: "0c27eabc01b70cdfff13ac2b37d7c0de02fa9508979798b49252145b3ff14427",

  /* ---------------- site / activity logging ---------------- */

  // Google Apps Script web-app URL that writes to YOUR private Google Sheet
  // (script is in README.md). Leave "" to keep logs on the student's device only.
  // Paste the URL of your NEW deployment here.
  webhookUrl: "https://script.google.com/macros/s/AKfycbwb4N_ZFXwzecPT9IkDSVnOWi_AoYVqTE2HetW6G_JgZdZVr79Kd8oOilVD0-smWmaf/exec",

  // Must match SECRET in the Apps Script. Rows with a wrong secret are rejected.
  // Use a long random string (e.g. 30+ characters).
  webhookSecret: "kT9x-Pq27-mWb4-ZrL8-Hd5v-Ns3c",

  // How much of a visited link is recorded (only during an active exam):
  //   "domain" = site only                    chat.openai.com
  //   "path"   = site + page, NO ?query       chat.openai.com/c/abc
  //   "full"   = the whole link incl. ?query  (can expose search terms/tokens)
  urlDetail: "path",

  // Also record the page title (e.g. "how to solve x - Google Search").
  logPageTitles: true,

  /* ---------------- tuning ---------------- */

  // Several events fired by one action count as ONE warning within this window.
  countCooldownMs: 2500,

  // How long the browser must stay unfocused before it counts as leaving.
  focusLossGraceMs: 900
};
