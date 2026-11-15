/* Antigravity — Subagents module for automatic-funicular.
 *
 * Provides a subagent catalog, creation, and messaging UI that mounts into
 * any DOM element via window.__agySubagentsMount(el).
 *
 * Communicates with native Android through window.Android.subagent* methods
 * (exposed via @JavascriptInterface on AndroidBridge).
 *
 * All state is kept in localStorage and mirrored to native. No existing
 * functionality is modified — this is purely additive.
 */

(function () {
  "use strict";

  if (window.__agySubagentsReady) return;
  window.__agySubagentsReady = true;

  var STORAGE_KEY = "agy_subagents";
  var POLL_INTERVAL_MS = 2000;

  /* ------------------------------------------------------------- helpers */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>\"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }

  function T(pl, en) {
    try {
      var l = (document.documentElement.getAttribute("data-agy-language") || "pl").toLowerCase();
      return l.indexOf("pl") === 0 ? pl : en;
    } catch (e) { return en; }
  }

  function storageGet(key, def) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? def : JSON.parse(raw);
    } catch (e) { return def; }
  }

  function storageSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ------------------------------------------------------------- state */

  var types = [];
  var instances = [];
  var selectedAgentId = null;
  var mountEl = null;
  var mounted = false;
  var pollTimer = null;

  function loadTypes() {
    try {
      var raw = window.Android && typeof window.Android.subagentListTypes === "function"
        ? window.Android.subagentListTypes()
        : "[]";
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) types = parsed;
    } catch (e) {
      types = [];
    }
  }

  function loadInstances() {
    try {
      var raw = window.Android && typeof window.Android.subagentListInstances === "function"
        ? window.Android.subagentListInstances()
        : "[]";
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) instances = parsed;
    } catch (e) {
      instances = [];
    }
  }

  function createAgent(typeId) {
    if (!window.Android || typeof window.Android.subagentCreate !== "function") return null;
    var id = window.Android.subagentCreate(typeId);
    if (id) {
      loadInstances();
      render();
    }
    return id;
  }

  function terminateAgent(id) {
    if (!window.Android || typeof window.Android.subagentTerminate !== "function") return;
    window.Android.subagentTerminate(id);
    if (selectedAgentId === id) selectedAgentId = null;
    loadInstances();
    render();
  }

  function sendMessage(agentId, text) {
    if (!window.Android || typeof window.Android.subagentSendMessage !== "function") return null;
    var raw = window.Android.subagentSendMessage(agentId, text);
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { success: false, content: "", error: "invalid response" };
    }
  }

  function findType(id) {
    for (var i = 0; i < types.length; i++) {
      if (types[i].id === id) return types[i];
    }
    return null;
  }

  function findInstance(id) {
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].id === id) return instances[i];
    }
    return null;
  }

  /* ------------------------------------------------------------- UI */

  function typeCard(type) {
    var c = document.createElement("div");
    c.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;" +
      "padding:12px 8px;border-radius:14px;cursor:pointer;font:inherit;text-align:center;" +
      "border:1px solid rgba(127,127,127,.22);background:rgba(255,255,255,.02);" +
      "transition:border-color .15s,background .15s";
    c.onmouseenter = function () { c.style.borderColor = "var(--foreground,#eee)"; };
    c.onmouseleave = function () { c.style.borderColor = "rgba(127,127,127,.22)"; };
    c.onclick = function () {
      var id = createAgent(type.id);
      if (id) selectedAgentId = id;
      render();
    };

    var iconWrap = document.createElement("div");
    iconWrap.style.cssText = "width:56px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(127,127,127,.15)";
    var icon = document.createElement("span");
    icon.style.cssText = "font-size:24px";
    icon.textContent = type.id === "code-reviewer" ? "🔍"
      : type.id === "android-debugger" ? "🐛"
      : type.id === "security-auditor" ? "🛡️"
      : type.id === "refactoring-assistant" ? "♻️"
      : type.id === "documentation-writer" ? "📝"
      : "🤖";
    iconWrap.appendChild(icon);
    c.appendChild(iconWrap);

    var lbl = document.createElement("div");
    lbl.style.cssText = "font-size:12.5px;font-weight:600;color:var(--foreground,#eee);margin-top:4px";
    lbl.textContent = T(type.namePl, type.nameEn);
    c.appendChild(lbl);

    var desc = document.createElement("div");
    desc.style.cssText = "font-size:10.5px;color:var(--muted-foreground,#888);line-height:1.3";
    desc.textContent = T(type.promptPl, type.promptEn);
    c.appendChild(desc);

    return c;
  }

  function instanceRow(inst) {
    var type = findType(inst.typeId);
    var selected = selectedAgentId === inst.id;

    var row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
      "padding:8px 12px;border-radius:10px;background:" + (selected ? "rgba(127,127,127,.22)" : "rgba(255,255,255,.02)") + ";" +
      "border:1px solid " + (selected ? "var(--foreground,#eee)" : "transparent") + ";cursor:pointer;" +
      "transition:background .15s,border-color .15s";
    row.onclick = function () { selectedAgentId = inst.id; render(); };

    var info = document.createElement("div");
    info.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1";
    var name = document.createElement("div");
    name.style.cssText = "font-size:13px;font-weight:600;color:var(--foreground,#eee)";
    name.textContent = type ? T(type.namePl, type.nameEn) : inst.typeId;
    info.appendChild(name);
    var meta = document.createElement("div");
    meta.style.cssText = "font-size:10.5px;color:var(--muted-foreground,#888)";
    meta.textContent = "ID: " + inst.id + "  ·  Wiadomości: " + inst.messageCount;
    info.appendChild(meta);
    row.appendChild(info);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px";

    var selBtn = document.createElement("button");
    selBtn.type = "button";
    selBtn.textContent = selected ? T("Wybrany", "Selected") : T("Wybierz", "Select");
    selBtn.style.cssText = "font-size:11px;padding:4px 8px;border-radius:6px;border:none;background:var(--secondary,rgba(255,255,255,.05));color:var(--foreground,#eee);cursor:pointer";
    selBtn.onclick = function (e) { e.stopPropagation(); selectedAgentId = inst.id; render(); };
    actions.appendChild(selBtn);

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "🗑️";
    delBtn.style.cssText = "font-size:12px;padding:4px 8px;border-radius:6px;border:none;background:rgba(239,68,68,.15);color:#ef4444;cursor:pointer";
    delBtn.onclick = function (e) { e.stopPropagation(); terminateAgent(inst.id); };
    actions.appendChild(delBtn);

    row.appendChild(actions);
    return row;
  }

  function chatArea() {
    var container = document.createElement("div");
    container.style.cssText = "flex:1;display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:8px";

    var inst = selectedAgentId ? findInstance(selectedAgentId) : null;
    if (!inst) {
      var empty = document.createElement("div");
      empty.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground,#888);font-style:italic";
      empty.textContent = T("Wybierz agenta z listy powyżej.", "Select an agent from the list above.");
      container.appendChild(empty);
      return container;
    }

    var type = findType(inst.typeId);

    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.12)";
    var icon = document.createElement("span");
    icon.style.cssText = "font-size:18px";
    icon.textContent = type ? (type.id === "code-reviewer" ? "🔍" : type.id === "android-debugger" ? "🐛" : type.id === "security-auditor" ? "🛡️" : type.id === "refactoring-assistant" ? "♻️" : type.id === "documentation-writer" ? "📝" : "🤖") : "🤖";
    header.appendChild(icon);
    var hname = document.createElement("div");
    hname.style.cssText = "font-size:13px;font-weight:600;color:var(--foreground,#eee)";
    hname.textContent = type ? T(type.namePl, type.nameEn) : inst.typeId;
    header.appendChild(hname);
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "font-size:12px;padding:2px 6px;border-radius:6px;border:none;background:transparent;color:var(--muted-foreground,#888);cursor:pointer";
    closeBtn.onclick = function () { selectedAgentId = null; render(); };
    header.appendChild(closeBtn);
    container.appendChild(header);

    var messages = document.createElement("div");
    messages.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:4px";
    container.appendChild(messages);

    var intro = document.createElement("div");
    intro.style.cssText = "padding:8px 12px;border-radius:8px;background:rgba(127,127,127,.08);font-size:12.5px;color:var(--muted-foreground,#888)";
    intro.textContent = T("Agent gotowy. Napisz wiadomość poniżej.", "Agent ready. Type a message below.");
    messages.appendChild(intro);

    var inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex;gap:6px;padding:8px;border-top:1px solid rgba(127,127,127,.18)";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = T("Wiadomość do agenta…", "Message to agent…");
    input.style.cssText = "flex:1;padding:8px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.25);background:rgba(255,255,255,.03);color:var(--foreground,#eee);font:inherit";
    inputRow.appendChild(input);

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = T("Wyślij", "Send");
    sendBtn.style.cssText = "padding:8px 16px;border-radius:8px;border:none;background:var(--foreground,#eee);color:#111;font-weight:600;cursor:pointer";
    sendBtn.onclick = function () {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";

      var own = document.createElement("div");
      own.style.cssText = "align-self:flex-end;max-width:70%;padding:8px 12px;border-radius:8px;background:var(--foreground,#eee);color:#111;font-size:12.5px";
      own.textContent = text;
      messages.appendChild(own);
      messages.scrollTop = messages.scrollHeight;

      var resp = sendMessage(selectedAgentId, text);
      var bubble = document.createElement("div");
      bubble.style.cssText = "align-self:flex-start;max-width:85%;padding:8px 12px;border-radius:8px;background:rgba(127,127,127,.12);color:var(--foreground,#eee);font-size:12.5px";
      if (resp.success) {
        bubble.textContent = resp.content || T("Brak odpowiedzi.", "No response.");
      } else {
        bubble.textContent = T("Błąd: ", "Error: ") + esc(resp.error || "unknown");
        bubble.style.color = "#ef4444";
      }
      messages.appendChild(bubble);
      messages.scrollTop = messages.scrollHeight;
    };
    inputRow.appendChild(sendBtn);

    input.onkeypress = function (e) { if (e.key === "Enter") sendBtn.onclick(); };
    container.appendChild(inputRow);

    return container;
  }

  function render() {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var header = document.createElement("div");
    header.style.cssText = "font-size:18px;font-weight:600;color:var(--foreground,#eee);margin-bottom:12px;display:flex;align-items:center;gap:8px";
    var icon = document.createElement("span");
    icon.style.cssText = "font-size:20px";
    icon.textContent = "🤖";
    header.appendChild(icon);
    var title = document.createElement("span");
    title.textContent = T("Subagenci", "Subagents");
    header.appendChild(title);
    mountEl.appendChild(header);

    var note = document.createElement("div");
    note.style.cssText = "font-size:12.5px;color:var(--muted-foreground,#888);margin-bottom:12px";
    note.textContent = T("Tworzy i zarządza wyspecjalizowanymi agentami AI. Każdy agent ma własny kontekst i może być wywoływany z czatu.", "Creates and manages specialized AI agents. Each agent has its own context and can be invoked from chat.");
    mountEl.appendChild(note);

    /* ---- types ---- */
    var typesCard = document.createElement("div");
    typesCard.style.cssText = "background:rgba(255,255,255,.025);border:1px solid rgba(127,127,127,.18);border-radius:16px;padding:16px;margin-bottom:12px";
    var typesTitle = document.createElement("div");
    typesTitle.style.cssText = "font-size:15px;font-weight:600;color:var(--foreground,#eee);margin-bottom:8px";
    typesTitle.textContent = T("Rodzaje agentów", "Agent types");
    typesCard.appendChild(typesTitle);

    var grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px";
    for (var i = 0; i < types.length; i++) {
      grid.appendChild(typeCard(types[i]));
    }
    typesCard.appendChild(grid);
    mountEl.appendChild(typesCard);

    /* ---- instances ---- */
    var instCard = document.createElement("div");
    instCard.style.cssText = "background:rgba(255,255,255,.025);border:1px solid rgba(127,127,127,.18);border-radius:16px;padding:16px";
    var instTitle = document.createElement("div");
    instTitle.style.cssText = "font-size:15px;font-weight:600;color:var(--foreground,#eee);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center";
    instTitle.textContent = T("Aktywni agenci", "Active agents");
    instCard.appendChild(instTitle);

    var list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto";
    if (instances.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "padding:8px;color:var(--muted-foreground,#888);font-style:italic";
      empty.textContent = T("Brak aktywnych agentów.", "No active agents.");
      list.appendChild(empty);
    } else {
      for (var i = 0; i < instances.length; i++) {
        list.appendChild(instanceRow(instances[i]));
      }
    }
    instCard.appendChild(list);
    mountEl.appendChild(instCard);

    /* ---- chat ---- */
    mountEl.appendChild(chatArea());
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      loadInstances();
      if (mounted) render();
    }, POLL_INTERVAL_MS);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ------------------------------------------------------------- mount */

  window.__agySubagentsMount = function (el) {
    if (!el) return;
    if (el.getAttribute("data-subagents-mounted") === "1") { render(); return; }
    el.setAttribute("data-subagents-mounted", "1");
    el.style.cssText = "padding:4px 4px 24px;max-width:700px;box-sizing:border-box";
    mountEl = el;
    mounted = true;

    loadTypes();
    loadInstances();
    render();
    startPoll();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { loadTypes(); loadInstances(); render(); });
    } else {
      loadTypes();
      loadInstances();
      render();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      loadTypes();
      loadInstances();
    });
  } else {
    loadTypes();
    loadInstances();
  }
})();

