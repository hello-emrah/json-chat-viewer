(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  let bundle = null;
  let transcript = null;
  let selectedIdx = 0;
  let fileName = "";
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
    const l = lang ? `<div class="code-lang">${esc(lang)}</div>` : "";
    return `${l}<pre class="code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
  }
  function inlineMd(text) {
    const toks = [];
    const T = (h) => "" + (toks.push(h) - 1) + "";
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
    text = text.replace(/(\d+)/g, (_m, i) => toks[+i]);
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
      /^\d+$/.test(line)
    );
  }
  function renderMd(src) {
    if (!src) return "";
    const fences = [];
    src = src.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return "" + (fences.push({ lang: (lang || "").trim(), code }) - 1) + "";
    });
    const lines = src.replace(/\r/g, "").split("\n");
    let html = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fm = line.match(/^(\d+)$/);
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
    const lines = String(text).split("\n");
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
    const f = bundle && bundle.format;
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

  // ---------- header + toolbar ----------
  function renderHeader(meta) {
    const h = el("div", "header");
    const title = meta.title || (bundle && bundle.formatLabel) || "Conversation";
    let metaBits = [];
    if (bundle && bundle.formatLabel) metaBits.push(`<span class="fmt-badge">${esc(bundle.formatLabel)}</span>`);
    if (meta.cwd) metaBits.push(`📁 <code>${esc(meta.cwd)}</code>`);
    if (meta.gitBranch) metaBits.push(`⎇ ${esc(meta.gitBranch)}`);
    if (meta.models.length) metaBits.push(`✦ ${esc(meta.models.join(", "))}`);
    if (meta.version) metaBits.push(`v${esc(meta.version)}`);
    if (meta.firstTimestamp) metaBits.push(esc(fmtDate(meta.firstTimestamp)));

    // Count from the rendered events so the numbers match what's on screen.
    const ec = { prompts: 0, replies: 0, tools: 0, images: 0 };
    for (const ev of transcript.events) {
      if (ev.kind === "user" && ev.flavor === "human") ec.prompts++;
      else if (ev.kind === "assistant") ec.replies++;
      else if (ev.kind === "tool_call") ec.tools++;
      else if (ev.kind === "image") ec.images++;
      else if (ev.kind === "tool_result") ec.images += ev.images.length;
    }
    const c = meta.counts, tk = meta.tokens;
    const stats = [];
    stats.push(`<span class="stat"><b>${ec.prompts}</b> prompts</span>`);
    stats.push(`<span class="stat"><b>${ec.replies}</b> replies</span>`);
    stats.push(`<span class="stat"><b>${ec.tools}</b> tool calls</span>`);
    if (ec.images) stats.push(`<span class="stat"><b>${ec.images}</b> images</span>`);
    if (meta.durationMs) stats.push(`<span class="stat">⏱ <b>${fmtDuration(meta.durationMs)}</b></span>`);
    const totalTok = tk.input + tk.output + tk.cacheRead + tk.cacheCreate;
    if (totalTok) stats.push(`<span class="stat" title="in ${tk.input} · out ${tk.output} · cache read ${tk.cacheRead} · cache write ${tk.cacheCreate}">≈ <b>${fmtNum(totalTok)}</b> tokens</span>`);
    if (c.errors) stats.push(`<span class="stat error"><b>${c.errors}</b> errors</span>`);
    if (meta.parseErrors) stats.push(`<span class="stat" title="lines that failed to parse"><b>${meta.parseErrors}</b> bad lines</span>`);

    // Conversation picker when a file holds more than one (e.g. an export).
    let picker = "";
    if (bundle && bundle.conversations.length > 1) {
      const opts = bundle.conversations.map((c, i) => {
        const d = c.meta.lastTimestamp ? " — " + fmtDate(c.meta.lastTimestamp) : "";
        const n = (c.meta.title || `Conversation ${i + 1}`);
        return `<option value="${i}"${i === selectedIdx ? " selected" : ""}>${esc(n)}${esc(d)}</option>`;
      }).join("");
      picker = `<div class="convo-picker"><span>${bundle.conversations.length} conversations</span>` +
        `<select id="convo-select">${opts}</select></div>`;
    }

    h.innerHTML =
      `<h1>${esc(title)}</h1>` +
      `<div class="filename">${esc(fileName)}</div>` +
      picker +
      `<div class="meta-line">${metaBits.join('<span style="opacity:.4">·</span>')}</div>` +
      `<div class="stats">${stats.join("")}</div>`;

    const sel = h.querySelector("#convo-select");
    if (sel) sel.addEventListener("change", (e) => {
      selectedIdx = parseInt(e.target.value, 10) || 0;
      render();
      window.scrollTo(0, 0);
    });
    return h;
  }

  function renderToolbar() {
    const bar = el("div", "toolbar");
    const search = el("input", "search");
    search.type = "search";
    search.placeholder = "Search transcript…";
    search.addEventListener("input", () => applySearch(search.value));

    // Filter dropdown (replaces the old inline toggles)
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
    const expand = el("button", "btn"); expand.textContent = "Expand all";
    expand.addEventListener("click", () => setAllDetails(true));
    const collapse = el("button", "btn"); collapse.textContent = "Collapse all";
    collapse.addEventListener("click", () => setAllDetails(false));
    right.appendChild(expand); right.appendChild(collapse);

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

  // ---------- main render ----------
  function render() {
    app.innerHTML = "";
    if (!bundle || !bundle.conversations.length) { app.appendChild(el("div", "loading", "Parsing…")); return; }
    if (selectedIdx >= bundle.conversations.length) selectedIdx = 0;
    transcript = bundle.conversations[selectedIdx];
    app.appendChild(renderHeader(transcript.meta));
    app.appendChild(renderToolbar());

    const list = el("div", "events");
    let lastDate = "";
    if (!transcript.events.length) {
      list.appendChild(el("div", "empty-note", "No renderable messages found in this file."));
    }
    for (const ev of transcript.events) {
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
    app.appendChild(list);
    applyFilters();
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    // close the filter dropdown when clicking outside it
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
    if (msg.type === "bundle") {
      bundle = msg.data;
      fileName = msg.fileName || "";
      selectedIdx = 0;
      render();
    } else if (msg.type === "error") {
      app.innerHTML = `<div class="empty-note">Failed to parse: ${esc(msg.message)}</div>`;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
