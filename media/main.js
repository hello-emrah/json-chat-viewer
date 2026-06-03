(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  // Light index of every conversation in the file (meta only, no events).
  // A conversation's events are fetched from the host on demand and cached.
  let indexData = null;        // { format, formatLabel, conversations: [{ meta, eventCount }] }
  let bundleFormat = "";
  let fileName = "";
  let selectedIdx = 0;
  let currentEvents = null;    // events for selectedIdx; null = loading, [] = none
  const eventCache = new Map();
  const listItemNodes = [];
  let mainPane = null;

  const filters = { thinking: true, tools: true, results: true, system: true, images: true };

  // ---------- utilities ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function fmtNum(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }
  function fmtBytes(n) {
    if (!n) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
    return n + " B";
  }
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  }
  function fmtDateShort(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtDuration(ms) {
    if (!ms || ms < 0) return "";
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ---------- mini markdown ----------
  function codeBlock(lang, code) {
    code = typeof code === "string" ? code : code == null ? "" : JSON.stringify(code, null, 2);
    const l = lang ? `<div class="code-lang">${esc(lang)}</div>` : "";
    return `${l}<pre class="code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
  }
  function inlineMd(text) {
    const toks = [];
    const T = (h) => "" + (toks.push(h) - 1) + "";
    // inline code first
    text = text.replace(/`([^`]+)`/g, (_m, c) => T(`<code>${esc(c)}</code>`));
    // links [text](url) — only allow safe schemes, else keep the text unlinked
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, t, u) => {
      const safe = /^(https?:\/\/|mailto:|\/|\.\/|#)/i.test(u);
      return safe ? T(`<a data-href="${esc(u)}">${esc(t)}</a>`) : T(esc(t));
    });
    text = esc(text);
    text = text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // bare urls
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, p, u) => `${p}<a data-href="${u}">${u}</a>`);
    text = text.replace(/(\d+)/g, (_m, i) => toks[+i]);
    return text;
  }
  function splitRow(line) {
    let s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split(/(?<!\\)\|/).map((c) => inlineMd(c.trim().replace(/\\\|/g, "|")));
  }
  function isBlockStart(line) {
    return (
      /^\s*#{1,6}\s/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*([-*+]|\d+\.)\s+/.test(line) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
      /^\d+$/.test(line)
    );
  }
  function renderMd(src) {
    if (!src) return "";
    const fences = [];
    src = src.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return "" + (fences.push({ lang: (lang || "").trim(), code }) - 1) + "";
    });
    const lines = src.replace(/\r/g, "").split("\n");
    let html = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fm = line.match(/^(\d+)$/);
      if (fm) { const f = fences[+fm[1]]; html += codeBlock(f.lang, f.code); i++; continue; }
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += "<hr/>"; i++; continue; }
      const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { const lv = h[1].length; html += `<h${lv}>${inlineMd(h[2].trim())}</h${lv}>`; i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += `<blockquote>${renderMd(buf.join("\n"))}</blockquote>`;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const header = splitRow(line); i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(splitRow(lines[i])); i++; }
        html += "<table><thead><tr>" + header.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          let item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            item += "\n" + lines[i].trim(); i++;
          }
          items.push(`<li>${inlineMd(item)}</li>`);
        }
        html += (ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>");
        continue;
      }
      const buf = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      html += `<p>${inlineMd(buf.join("\n")).replace(/\n/g, "<br/>")}</p>`;
    }
    return html;
  }

  // ---------- collapsible helper ----------
  function collapsible(summary, innerHtml, open) {
    return `<details class="collapse"${open ? " open" : ""}><summary>${esc(summary)}</summary>${innerHtml}</details>`;
  }
  function pathSpan(p) {
    return `<span class="path" data-path="${esc(p)}">${esc(p)}</span>`;
  }
  function clampPre(text, lang) {
    text = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text, null, 2);
    const lines = text.split("\n");
    const LIMIT = 36;
    if (lines.length <= LIMIT && text.length <= 4000) return codeBlock(lang, text);
    const head = lines.slice(0, LIMIT).join("\n");
    return codeBlock(lang, head) +
      collapsible(`show full (${lines.length} lines)`, codeBlock(lang, text), false);
  }

  // ---------- tool input rendering ----------
  function renderDiff(oldS, newS) {
    const rows = [];
    for (const ln of String(oldS).split("\n")) rows.push(`<div class="row del">- ${esc(ln)}</div>`);
    for (const ln of String(newS).split("\n")) rows.push(`<div class="row add">+ ${esc(ln)}</div>`);
    return `<div class="diff">${rows.join("")}</div>`;
  }
  function kv(label, valueHtml) {
    return `<div class="kv"><span class="k">${esc(label)}: </span>${valueHtml}</div>`;
  }
  function renderToolInput(name, input) {
    if (input == null) return "";
    const obj = typeof input === "object" ? input : { value: input };
    switch (name) {
      case "Bash": {
        let out = "";
        if (obj.command) out += clampPre(obj.command, "bash");
        if (obj.description) out += `<div class="tool-caption">${esc(obj.description)}</div>`;
        if (obj.run_in_background) out += `<div class="tool-caption">(background)</div>`;
        return out;
      }
      case "Read":
        return kv("file", pathSpan(obj.file_path || "")) +
          (obj.offset || obj.limit ? `<div class="tool-caption">lines ${obj.offset || 0}–${(obj.offset || 0) + (obj.limit || 0)}</div>` : "");
      case "Write":
        return kv("file", pathSpan(obj.file_path || "")) +
          (obj.content != null ? collapsible(`content (${String(obj.content).split("\n").length} lines)`, codeBlock("", String(obj.content)), false) : "");
      case "Edit":
        return kv("file", pathSpan(obj.file_path || "")) +
          renderDiff(obj.old_string || "", obj.new_string || "") +
          (obj.replace_all ? `<div class="tool-caption">replace all</div>` : "");
      case "MultiEdit": {
        let out = kv("file", pathSpan(obj.file_path || ""));
        for (const e of (obj.edits || [])) out += renderDiff(e.old_string || "", e.new_string || "");
        return out;
      }
      case "Glob":
        return kv("pattern", `<code>${esc(obj.pattern || "")}</code>`) + (obj.path ? kv("in", pathSpan(obj.path)) : "");
      case "Grep":
        return kv("pattern", `<code>${esc(obj.pattern || "")}</code>`) +
          (obj.path ? kv("in", pathSpan(obj.path)) : "") +
          (obj.glob ? kv("glob", `<code>${esc(obj.glob)}</code>`) : "");
      case "TodoWrite": {
        const todos = obj.todos || [];
        const items = todos.map((t) => {
          const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○";
          return `<li>${mark} ${esc(t.content || t.activeForm || "")}</li>`;
        }).join("");
        return `<ul class="md">${items}</ul>`;
      }
      case "TaskCreate":
      case "TaskUpdate":
      case "Task":
      case "Agent": {
        let out = "";
        if (obj.description) out += kv("task", `<b>${esc(obj.description)}</b>`);
        if (obj.subagent_type) out += kv("agent", esc(obj.subagent_type));
        if (obj.status) out += kv("status", esc(obj.status));
        if (obj.taskId) out += kv("id", `<code>${esc(obj.taskId)}</code>`);
        if (obj.prompt) out += collapsible("prompt", `<div class="md">${renderMd(String(obj.prompt))}</div>`, false);
        return out || `<pre class="code"><code>${esc(JSON.stringify(obj, null, 2))}</code></pre>`;
      }
      case "Skill":
        return kv("skill", `<code>${esc(obj.skill || obj.command || "")}</code>`) + (obj.args ? kv("args", esc(obj.args)) : "");
      case "ToolSearch":
        return kv("query", `<code>${esc(obj.query || "")}</code>`);
      default: {
        // mcp__* and anything else: tidy key/value, JSON for nested
        const keys = Object.keys(obj);
        if (keys.length && keys.length <= 8 && keys.every((k) => typeof obj[k] !== "object" || obj[k] === null)) {
          return keys.map((k) => {
            let v = obj[k];
            v = typeof v === "string" ? esc(v.length > 300 ? v.slice(0, 300) + "…" : v) : esc(JSON.stringify(v));
            return kv(k, `<span>${v}</span>`);
          }).join("");
        }
        return clampPre(JSON.stringify(obj, null, 2), "json");
      }
    }
  }

  // ---------- event rendering ----------
  function assistantName() {
    const f = bundleFormat;
    if (f === "chatgpt-export") return "ChatGPT";
    if (f === "claude-code" || f === "claude-export") return "Claude";
    return "Assistant";
  }
  function roleLabel(ev) {
    switch (ev.kind) {
      case "user": return ev.flavor === "command" ? "command" : ev.flavor === "reminder" ? "system reminder" : ev.flavor === "meta" ? "context" : "You";
      case "assistant": return assistantName();
      case "thinking": return "Thinking";
      case "tool_call": return "Tool";
      case "tool_result": return ev.ok ? "Result" : "Error";
      case "image": return "Image";
      case "system": return ev.isError ? "API error" : "System";
      case "error": return "Error";
      case "mode": return "Mode";
      case "queued": return "Queued";
      case "attachment": return "Context";
      default: return ev.kind;
    }
  }

  function buildEvent(ev) {
    const wrap = el("div", `event ev-${ev.kind} role-${ev.kind}`);
    let bucket = "always";
    if (ev.kind === "thinking") bucket = "thinking";
    else if (ev.kind === "tool_call") bucket = "tools";
    else if (ev.kind === "tool_result") bucket = "results";
    else if (ev.kind === "image") bucket = "images";
    else if (["system", "error", "attachment", "mode", "queued"].includes(ev.kind)) bucket = "system";
    else if (ev.kind === "user" && ev.flavor !== "human") bucket = "system";
    wrap.dataset.bucket = bucket;

    const slim = ["mode", "queued", "attachment"].includes(ev.kind) || (ev.kind === "user" && ev.flavor === "command" && !ev.text.includes("\n"));
    if (slim) wrap.classList.add("slim");

    // role line
    const role = el("div", "role");
    let label = roleLabel(ev);
    let tag = "";
    if (ev.kind === "tool_call") { label = "Tool"; tag = `<span class="tag">${esc(ev.display)}</span>`; }
    if (ev.kind === "tool_result" && ev.forName) tag = `<span class="tag">${esc(ev.forName)}</span>`;
    if (ev.kind === "assistant" && ev.model) tag = `<span class="tag">${esc(ev.model)}</span>`;
    if (ev.kind === "user" && ev.label) tag = `<span class="tag">/${esc(ev.label)}</span>`;
    role.innerHTML = `<span>${esc(label)}</span>${tag}` + (ev.ts ? `<span class="ts">${esc(fmtTime(ev.ts))}</span>` : "");
    wrap.appendChild(role);

    // body
    const body = el("div", "body");
    switch (ev.kind) {
      case "user":
        if (ev.flavor === "reminder" || ev.flavor === "meta") {
          body.innerHTML = collapsible(label + " (click to expand)", `<div class="md">${renderMd(ev.text)}</div>`, false);
        } else {
          body.className = "md";
          body.innerHTML = renderMd(ev.text);
        }
        break;
      case "assistant":
        body.className = "md";
        body.innerHTML = renderMd(ev.text);
        break;
      case "thinking":
        if (ev.redacted) {
          body.innerHTML = `<span class="thinking-redacted">thinking not recorded in this log</span>`;
        } else {
          body.innerHTML = collapsible("show reasoning", `<div class="md">${renderMd(ev.text)}</div>`, false);
        }
        break;
      case "tool_call": {
        const head = el("div", "tool-head");
        head.innerHTML = `<span class="tool-name">${esc(ev.display)}</span>` + (ev.attribution ? `<span class="tool-caption">${esc(ev.attribution)}</span>` : "");
        body.appendChild(head);
        const inp = el("div");
        inp.innerHTML = renderToolInput(ev.name, ev.input);
        body.appendChild(inp);
        break;
      }
      case "tool_result": {
        let inner = "";
        if (ev.text && ev.text.trim()) inner += clampPre(ev.text, "");
        for (const img of ev.images) inner += `<img class="inline-img" src="${img.dataUri}" alt="result image" />`;
        if (!inner) inner = `<span class="thinking-redacted">(no output)</span>`;
        body.innerHTML = inner; // clampPre already truncates long output
        break;
      }
      case "image":
        body.innerHTML = `<img class="inline-img" src="${ev.data.dataUri}" alt="image" />` +
          (ev.data.approxBytes ? `<div class="tool-caption">${esc(ev.data.mediaType)} · ${fmtBytes(ev.data.approxBytes)}</div>` : "");
        break;
      case "system":
      case "error":
        body.className = "md";
        body.innerHTML = renderMd(ev.text);
        break;
      case "mode":
        body.innerHTML = `<span class="tool-caption">mode → ${esc(ev.mode)}</span>`;
        break;
      case "queued":
        body.innerHTML = `<div class="md">${renderMd(ev.text)}</div>`;
        break;
      case "attachment":
        body.innerHTML = `<span class="tool-caption">${esc(ev.label)}</span>` +
          (ev.text ? collapsible("show", clampPre(ev.text, ""), false) : "");
        break;
    }
    wrap.appendChild(body);
    return wrap;
  }

  // ---------- conversation list (sidebar) ----------
  function convoSubtitle(entry) {
    const m = entry.meta;
    const date = fmtDateShort(m.lastTimestamp || m.firstTimestamp);
    if (entry.eventCount === 0) {
      const n = m.messageCount || 0;
      return { date, meta: n ? `${n} messages, blank in export` : "empty in export", empty: true };
    }
    const c = m.counts || {};
    const bits = [];
    if (c.user) bits.push(`${c.user} prompt${c.user === 1 ? "" : "s"}`);
    if (c.assistant) bits.push(`${c.assistant} repl${c.assistant === 1 ? "y" : "ies"}`);
    if (!bits.length && m.messageCount) bits.push(`${m.messageCount} messages`);
    return { date, meta: bits.join(" · "), empty: false };
  }

  function buildSidebar() {
    const list = indexData.conversations;
    const aside = el("aside", "convo-list");

    const head = el("div", "convo-list-head");
    const search = el("input", "convo-search");
    search.type = "search";
    search.placeholder = `Search ${list.length} chats…`;
    const count = el("div", "convo-list-count");
    const setCount = (shown) => {
      count.textContent = shown === list.length ? `${list.length} chats` : `${shown} of ${list.length} chats`;
    };
    setCount(list.length);
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      listItemNodes.forEach((node) => {
        const hit = !q || node.dataset.search.includes(q);
        node.classList.toggle("hidden", !hit);
        if (hit) shown++;
      });
      setCount(shown);
    });
    head.appendChild(search);
    head.appendChild(count);
    aside.appendChild(head);

    const items = el("div", "convo-items");
    listItemNodes.length = 0;
    list.forEach((entry, i) => {
      const title = entry.meta.title || "Untitled";
      const sub = convoSubtitle(entry);
      const item = el("button", "convo-item" + (sub.empty ? " empty" : ""));
      item.dataset.i = String(i);
      item.dataset.search = (title + " " + sub.date).toLowerCase();
      item.innerHTML =
        `<div class="ci-title">${esc(title)}</div>` +
        `<div class="ci-sub">` +
          (sub.date ? `<span class="ci-date">${esc(sub.date)}</span>` : "") +
          (sub.meta ? `<span class="ci-meta${sub.empty ? " ci-empty" : ""}">${esc(sub.meta)}</span>` : "") +
        `</div>`;
      item.addEventListener("click", () => selectConversation(i, true));
      items.appendChild(item);
      listItemNodes.push(item);
    });
    aside.appendChild(items);
    return aside;
  }

  function markActiveItem() {
    listItemNodes.forEach((n) => n.classList.toggle("active", +n.dataset.i === selectedIdx));
  }

  // ---------- header + toolbar ----------
  function renderHeader(entry) {
    const meta = entry.meta;
    const h = el("div", "header");
    const title = meta.title || (indexData && indexData.formatLabel) || "Conversation";
    let metaBits = [];
    if (indexData && indexData.formatLabel) metaBits.push(`<span class="fmt-badge">${esc(indexData.formatLabel)}</span>`);
    if (meta.cwd) metaBits.push(`📁 <code>${esc(meta.cwd)}</code>`);
    if (meta.gitBranch) metaBits.push(`⎇ ${esc(meta.gitBranch)}`);
    if (meta.models && meta.models.length) metaBits.push(`✦ ${esc(meta.models.join(", "))}`);
    if (meta.version) metaBits.push(`v${esc(meta.version)}`);
    if (meta.firstTimestamp) metaBits.push(esc(fmtDate(meta.firstTimestamp)));

    // Counts come straight from meta (computed at parse time), so they're
    // available without shipping the conversation's events to the list.
    const c = meta.counts || {}, tk = meta.tokens || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const stats = [];
    stats.push(`<span class="stat"><b>${c.user || 0}</b> prompts</span>`);
    stats.push(`<span class="stat"><b>${c.assistant || 0}</b> replies</span>`);
    stats.push(`<span class="stat"><b>${c.toolCalls || 0}</b> tool calls</span>`);
    if (c.images) stats.push(`<span class="stat"><b>${c.images}</b> images</span>`);
    if (meta.durationMs) stats.push(`<span class="stat">⏱ <b>${fmtDuration(meta.durationMs)}</b></span>`);
    const totalTok = tk.input + tk.output + tk.cacheRead + tk.cacheCreate;
    if (totalTok) stats.push(`<span class="stat" title="in ${tk.input} · out ${tk.output} · cache read ${tk.cacheRead} · cache write ${tk.cacheCreate}">≈ <b>${fmtNum(totalTok)}</b> tokens</span>`);
    if (c.errors) stats.push(`<span class="stat error"><b>${c.errors}</b> errors</span>`);
    if (meta.parseErrors) stats.push(`<span class="stat" title="lines that failed to parse"><b>${meta.parseErrors}</b> bad lines</span>`);

    const total = indexData ? indexData.conversations.length : 1;
    const position = total > 1 ? `<div class="convo-position">Conversation ${selectedIdx + 1} of ${total}</div>` : "";

    h.innerHTML =
      `<h1>${esc(title)}</h1>` +
      `<div class="filename">${esc(fileName)}</div>` +
      position +
      `<div class="meta-line">${metaBits.join('<span style="opacity:.4">·</span>')}</div>` +
      `<div class="stats">${stats.join("")}</div>`;
    return h;
  }

  function renderToolbar() {
    const bar = el("div", "toolbar");
    const search = el("input", "search");
    search.type = "search";
    search.placeholder = "Search transcript…";
    search.addEventListener("input", () => applySearch(search.value));

    // Filter dropdown
    const defs = [
      ["thinking", "Thinking", "var(--accent-thinking)"],
      ["tools", "Tool calls", "var(--accent-tool)"],
      ["results", "Tool results", "var(--accent-result)"],
      ["images", "Images", "var(--accent-user)"],
      ["system", "System & meta", "var(--accent-system)"],
    ];
    const filterWrap = el("div", "filter");
    const btn = el("button", "filter-btn");
    const refreshLabel = () => {
      const on = defs.filter(([k]) => filters[k]).length;
      const count = on < defs.length ? `<span class="filter-count">${on}/${defs.length}</span>` : "";
      btn.innerHTML = `Filter ${count}<span class="caret">▾</span>`;
    };
    const menu = el("div", "filter-menu");
    menu.innerHTML = `<div class="menu-head">Show in transcript</div>`;
    defs.forEach(([key, label, color]) => {
      const item = el("label", "filter-item");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = filters[key];
      cb.addEventListener("change", () => {
        filters[key] = cb.checked;
        refreshLabel();
        applyFilters();
        savePrefs();
      });
      item.appendChild(cb);
      item.appendChild(document.createTextNode(label));
      const sw = el("span", "swatch");
      sw.style.background = color;
      item.appendChild(sw);
      menu.appendChild(item);
    });
    btn.addEventListener("click", (e) => { e.stopPropagation(); filterWrap.classList.toggle("open"); });
    filterWrap.appendChild(btn);
    filterWrap.appendChild(menu);
    refreshLabel();

    // Actions
    const right = el("div", "right");
    const mkBtn = (html, title, fn) => {
      const b = el("button", "btn");
      b.innerHTML = html;
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    right.appendChild(mkBtn(`<span class="gi">↑</span> Top`, "Jump to the start of the transcript",
      () => window.scrollTo({ top: 0, behavior: "smooth" })));
    right.appendChild(mkBtn(`<span class="gi">↓</span> End`, "Jump to the end of the transcript",
      () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })));
    right.appendChild(el("span", "vsep"));
    right.appendChild(mkBtn(`<span class="gi">▾</span> Expand all`,
      "Open every collapsible block — reasoning, tool input and long output", () => setAllDetails(true)));
    right.appendChild(mkBtn(`<span class="gi">▸</span> Collapse all`,
      "Collapse every block back to a one-line summary", () => setAllDetails(false)));

    bar.appendChild(search);
    bar.appendChild(filterWrap);
    bar.appendChild(right);
    const note = el("div", "count-note");
    note.id = "count-note";
    bar.appendChild(document.createElement("div")).className = "sep";
    bar.appendChild(note);
    return bar;
  }

  function setAllDetails(open) {
    document.querySelectorAll("details.collapse").forEach((d) => (d.open = open));
  }

  function applyFilters() {
    document.querySelectorAll(".event").forEach((node) => {
      const b = node.dataset.bucket;
      let visible = true;
      if (b === "thinking") visible = filters.thinking;
      else if (b === "tools") visible = filters.tools;
      else if (b === "results") visible = filters.results;
      else if (b === "images") visible = filters.images;
      else if (b === "system") visible = filters.system;
      node.dataset.filtered = visible ? "0" : "1";
      updateVisibility(node);
    });
    applySearch(currentQuery);
  }

  let currentQuery = "";
  function applySearch(q) {
    currentQuery = q || "";
    const query = currentQuery.trim().toLowerCase();
    let matches = 0, total = 0;
    document.querySelectorAll(".event").forEach((node) => {
      total++;
      let hit = true;
      if (query) hit = node.textContent.toLowerCase().includes(query);
      node.dataset.search = hit ? "0" : "1";
      if (hit) matches++;
      updateVisibility(node);
    });
    const note = document.getElementById("count-note");
    if (note) note.textContent = query ? `${matches} matching events` : `${total} events`;
  }

  function updateVisibility(node) {
    const hidden = node.dataset.filtered === "1" || node.dataset.search === "1";
    node.classList.toggle("hidden", hidden);
  }

  function savePrefs() {
    vscode.postMessage({ type: "savePrefs", prefs: { filters: { ...filters } } });
  }

  // ---------- render ----------
  function firstNonEmpty() {
    if (!indexData) return 0;
    const i = indexData.conversations.findIndex((c) => c.eventCount > 0);
    return i >= 0 ? i : 0;
  }

  // Build the whole shell: sidebar (if multi) + an empty main pane.
  function renderAll() {
    app.innerHTML = "";
    listItemNodes.length = 0;
    mainPane = null;
    if (!indexData || !indexData.conversations.length) {
      app.appendChild(el("div", "loading", "Parsing…"));
      return;
    }
    const layout = el("div", "layout");
    if (indexData.conversations.length > 1) layout.appendChild(buildSidebar());
    mainPane = el("main", "main-pane");
    layout.appendChild(mainPane);
    app.appendChild(layout);
    // The main pane is filled by selectConversation(), called right after.
  }

  // (Re)build only the main pane for the currently selected conversation.
  function renderMain() {
    if (!mainPane || !indexData) return;
    const entry = indexData.conversations[selectedIdx];
    if (!entry) return;
    currentQuery = "";
    mainPane.innerHTML = "";

    const top = el("div", "topbar");
    top.appendChild(renderHeader(entry));
    top.appendChild(renderToolbar());
    mainPane.appendChild(top);

    const list = el("div", "events");
    if (entry.eventCount === 0) {
      list.appendChild(el("div", "empty-note",
        "This conversation is empty in the export — its messages came back with no text or content.<br/>Nothing was hidden by the viewer; the export itself contains no body for this chat."));
    } else if (currentEvents === null) {
      list.appendChild(el("div", "loading", "Loading conversation…"));
    } else {
      let lastDate = "";
      for (const ev of currentEvents) {
        if (ev.ts) {
          const d = fmtDate(ev.ts);
          if (d && d !== lastDate) {
            lastDate = d;
            const div = el("div", "event slim ev-mode");
            div.dataset.bucket = "always";
            div.innerHTML = `<div class="role"><span>${esc(d)}</span></div>`;
            list.appendChild(div);
          }
        }
        list.appendChild(buildEvent(ev));
      }
    }
    mainPane.appendChild(list);
    if (entry.eventCount > 0 && currentEvents !== null) applyFilters();
  }

  function selectConversation(i, scrollTop) {
    if (!indexData || !indexData.conversations[i]) return;
    selectedIdx = i;
    markActiveItem();
    const entry = indexData.conversations[i];
    if (entry.eventCount === 0) {
      currentEvents = [];
    } else if (eventCache.has(i)) {
      currentEvents = eventCache.get(i);
    } else {
      currentEvents = null; // loading
      vscode.postMessage({ type: "requestConversation", index: i });
    }
    renderMain();
    if (scrollTop) window.scrollTo(0, 0);
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const openFilter = document.querySelector(".filter.open");
    if (openFilter && !openFilter.contains(e.target)) openFilter.classList.remove("open");

    const a = e.target.closest("a[data-href]");
    if (a) { e.preventDefault(); vscode.postMessage({ type: "openExternal", url: a.dataset.href }); return; }
    const p = e.target.closest(".path[data-path]");
    if (p) { e.preventDefault(); vscode.postMessage({ type: "openFile", path: p.dataset.path }); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const f = document.querySelector(".filter.open");
      if (f) f.classList.remove("open");
    }
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "prefs") {
      if (msg.data && msg.data.filters) Object.assign(filters, msg.data.filters);
      if (indexData) renderMain(); // re-apply if we somehow rendered already
    } else if (msg.type === "index") {
      indexData = { format: msg.format, formatLabel: msg.formatLabel, conversations: msg.conversations || [] };
      bundleFormat = msg.format || "";
      fileName = msg.fileName || "";
      eventCache.clear();
      currentEvents = null;
      selectedIdx = firstNonEmpty();
      renderAll();
      selectConversation(selectedIdx, false);
    } else if (msg.type === "conversation") {
      eventCache.set(msg.index, msg.events || []);
      if (msg.index === selectedIdx) {
        currentEvents = msg.events || [];
        renderMain();
      }
    } else if (msg.type === "error") {
      app.innerHTML = `<div class="empty-note">Failed to parse: ${esc(msg.message)}</div>`;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
