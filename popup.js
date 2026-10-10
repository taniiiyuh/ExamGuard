const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);

async function refresh() {
  const r = await send({ type: "POPUP_STATUS" });
  const st = $("status");
  if (!r || !r.active) {
    st.textContent = "No exam in progress.";
    st.className = "ok";
  } else {
    st.textContent = `Exam mode active - warnings ${r.warnings}/${r.max}`;
    st.className = "warn";
  }

  const { examLog = [] } = await chrome.storage.local.get("examLog");
  const ul = $("log");
  ul.replaceChildren();
  examLog.slice(-5).reverse().forEach((e) => {
    const li = document.createElement("li");
    li.textContent = `${new Date(e.time).toLocaleTimeString()} - ${e.type}${e.site ? " (" + e.site + ")" : ""}`;
    ul.appendChild(li);
  });
}

refresh();
