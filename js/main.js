// Graft panel: loads a staged project from the host, lets the user tick
// items, expands dependencies, and asks the host to keep just those.
(function () {
  "use strict";

  // After Effects' default label colours, index 0-16.
  var LABEL_COLORS = [
    "transparent", "#b53838", "#e4d84c", "#a9cbc7", "#e5bcc9", "#a9a9ca", "#e7c19e",
    "#b3c7b3", "#677de0", "#4aa44c", "#8e2c9a", "#e8920d", "#7f452a", "#f46dd6",
    "#3da2a5", "#a89677", "#1e401e"
  ];

  var ICONS = {
    folder: '<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"/>',
    comp: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 3v10M11 3v10"/>',
    video: '<rect x="1.5" y="4" width="9" height="8" rx="1"/><path d="M10.5 7l4-2v6l-4-2"/>',
    still: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 11l4-4 3 3 2-2 3 3"/>',
    audio: '<path d="M3 6h3l4-3v10l-4-3H3z"/>',
    solid: '<rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor"/>',
    placeholder: '<rect x="2.5" y="2.5" width="11" height="11" stroke-dasharray="2 2"/>',
    target: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/>',
    other: '<circle cx="8" cy="8" r="5"/>'
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    pick: $("pick"), source: $("source"), close: $("close"), tools: $("tools"),
    search: $("search"), chips: $("chips"), tree: $("tree"), foot: $("foot"),
    merge: $("merge"), summary: $("summary"), importBtn: $("import"), status: $("status"),
    dialog: $("dup"), picker: $("picker")
  };

  var state = null; // set by load()
  var busy = false;
  var introHTML = els.tree.innerHTML;

  function freshState(data) {
    var items = new Map(), children = new Map();
    data.items.forEach(function (it) {
      items.set(it.id, it);
      var key = it.parent === null ? "root" : it.parent;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(it.id);
    });
    // Open the top level by default.
    var expanded = new Set();
    (children.get("root") || []).forEach(function (id) {
      if (items.get(id).type === "folder") expanded.add(id);
    });
    return {
      stagingId: data.stagingId,
      fileName: data.fileName,
      items: items,
      children: children,
      explicit: new Set(),   // leaf ids the user ticked
      targets: new Map(),    // staged id -> {id, name, where} of the project item it replaces
      expanded: expanded,
      query: "",
      kinds: { comp: true, media: true, solid: true }
    };
  }

  function kindOf(type) {
    if (type === "comp" || type === "solid" || type === "folder") return type;
    return "media";
  }

  function leavesUnder(id, out) {
    (state.children.get(id) || []).forEach(function (c) {
      if (state.items.get(c).type === "folder") leavesUnder(c, out);
      else out.push(c);
    });
    return out;
  }

  // Everything that has to be imported: ticked items plus, recursively,
  // whatever their comps use. Items resolved to "use current" are still
  // listed (the host swaps them out) but their own dependencies aren't needed.
  function closure(resolutions) {
    var all = new Set();
    function visit(id) {
      var it = state.items.get(id);
      if (!it || all.has(id)) return;
      all.add(id);
      if (resolutions && resolutions[id] === "current") return;
      it.deps.forEach(visit);
    }
    state.explicit.forEach(visit);
    return all;
  }

  // ------------------------------------------------------------ rendering

  function svg(type) {
    return '<svg class="ico ' + type + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">' +
      (ICONS[type] || ICONS.other) + "</svg>";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Which items should be shown given search + type filters.
  function visibleSet() {
    var q = state.query.toLowerCase();
    var show = new Set();
    function visit(id) {
      var it = state.items.get(id), any = false;
      if (it.type === "folder") {
        (state.children.get(id) || []).forEach(function (c) { if (visit(c)) any = true; });
        if (!any && q && it.name.toLowerCase().indexOf(q) !== -1 && leavesUnder(id, []).length) any = true;
      } else {
        any = state.kinds[kindOf(it.type)] && (!q || it.name.toLowerCase().indexOf(q) !== -1);
      }
      if (any) show.add(id);
      return any;
    }
    (state.children.get("root") || []).forEach(visit);
    return show;
  }

  function checkState(id, picked) {
    var it = state.items.get(id);
    if (it.type !== "folder") {
      if (state.explicit.has(id)) return "on";
      return picked.has(id) ? "auto" : "off";
    }
    var leaves = leavesUnder(id, []);
    if (!leaves.length) return "off";
    var nOn = 0, nPicked = 0;
    leaves.forEach(function (l) {
      if (state.explicit.has(l)) nOn++;
      if (picked.has(l)) nPicked++;
    });
    if (nOn === leaves.length) return "on";
    if (nPicked === leaves.length) return "auto";
    return nPicked ? "mixed" : "off";
  }

  function depNames(it) {
    var seen = {};
    return it.deps.map(function (d) { return state.items.get(d); })
      .filter(function (d) { return d && !seen[d.id] && (seen[d.id] = true); })
      .map(function (d) { return d.name; });
  }

  function render() {
    if (!state) return;
    var picked = closure();
    var show = visibleSet();
    var searching = !!state.query;
    var html = [];

    function row(id, depth) {
      if (!show.has(id)) return;
      var it = state.items.get(id);
      var isFolder = it.type === "folder";
      var open = isFolder && (searching || state.expanded.has(id));
      var cs = checkState(id, picked);
      var meta = "";
      if (it.missing) meta += '<span class="tag warn" title="Footage is missing on disk">missing</span>';
      if (cs === "auto" && !isFolder) meta += '<span class="tag">auto</span>';
      var tgt = state.targets.get(id);
      if (tgt) meta += '<span class="tag swap" title="Will replace “' + esc(tgt.name) + '” in your project">→ ' + esc(tgt.name) + "</span>";
      if (it.info) meta += '<span class="info">' + esc(it.info) + "</span>";
      if (!isFolder) {
        meta += '<span class="target-btn' + (tgt ? " set" : "") + '" data-act="target" title="Swap into an item in your project">' +
          svg("target") + "</span>";
      }
      var title = it.name;
      if (it.type === "comp") {
        var names = depNames(it);
        if (names.length) title += "\nUses: " + names.join(", ");
      } else if (it.path) {
        title += "\n" + it.path;
      }
      html.push(
        '<div class="row' + (cs === "off" ? "" : " sel") + '" data-id="' + id + '" style="--depth:' + depth + '" title="' + esc(title) + '">' +
          '<span class="caret' + (isFolder ? (open ? " open" : "") : " none") + '" data-act="toggle"></span>' +
          '<span class="cb ' + cs + '" data-act="check"></span>' +
          '<span class="dot" style="background:' + (LABEL_COLORS[it.label] || "transparent") + '"></span>' +
          svg(it.type) +
          '<span class="name" data-act="' + (isFolder ? "toggle" : "check") + '">' + esc(it.name) + "</span>" +
          meta +
        "</div>"
      );
      if (open) (state.children.get(id) || []).forEach(function (c) { row(c, depth + 1); });
    }

    (state.children.get("root") || []).forEach(function (id) { row(id, 0); });
    els.tree.innerHTML = html.length ? html.join("") : '<div class="empty"><p>No items match.</p></div>';

    var nExplicit = state.explicit.size;
    var nAuto = picked.size - nExplicit;
    els.summary.textContent = nExplicit
      ? nExplicit + " selected" + (nAuto ? " + " + nAuto + " dependenc" + (nAuto === 1 ? "y" : "ies") : "")
      : "Nothing selected";
    els.importBtn.disabled = !picked.size || busy;
    els.importBtn.textContent = picked.size ? "Import " + picked.size + " item" + (picked.size === 1 ? "" : "s") : "Import selected";
  }

  // ------------------------------------------------------------ actions

  function setStatus(msg, kind) {
    els.status.hidden = !msg;
    els.status.textContent = msg || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  function setBusy(on, msg) {
    busy = on;
    document.body.classList.toggle("busy", on);
    els.pick.disabled = on;
    if (msg) setStatus(msg, "info");
    if (state) render();
  }

  function showLoaded(on) {
    els.tools.hidden = !on;
    els.foot.hidden = !on;
    els.close.hidden = !on;
  }

  function reset() {
    state = null;
    showLoaded(false);
    els.search.value = "";
    els.source.textContent = "No project loaded";
    els.source.title = "";
    els.tree.innerHTML = introHTML;
  }

  // Give the status a frame to paint before After Effects blocks on a call.
  function nextFrame() { return new Promise(function (r) { setTimeout(r, 30); }); }

  // Read the project straight from disk. Returns null if that isn't possible
  // (no Node in this panel, or a file the parser doesn't understand).
  function readProject(path) {
    var fs = typeof require === "function" ? require("fs") : null;
    if (!fs || !window.AepParser || /\.aepx$/i.test(path)) return null;
    try {
      return AepParser.parse(fs.readFileSync(path), {
        projectPath: path,
        exists: function (p) { return fs.existsSync(p); }
      });
    } catch (e) {
      console.warn("Graft: parser could not read " + path + ": " + e.message);
      return null;
    }
  }

  function load() {
    if (busy) return;
    Host.pickFile("Choose an After Effects project", ["aep", "aepx"]).then(function (path) {
      if (path) return openPath(path);
    }).catch(function (e) { setStatus(e.message, "error"); });
  }

  function openPath(path) {
    if (busy) return Promise.resolve();
    return Promise.resolve().then(function () {
      var fileName = path.split(/[\\/]/).pop();
      var old = state && state.stagingId;
      setBusy(true, "Reading " + fileName + "…");
      return nextFrame()
        .then(function () {
          if (old) Host.call("discard", [old]).catch(function () { });
          var items = readProject(path);
          // Couldn't parse: let After Effects import it instead (slower).
          return items ? { stagingId: null, fileName: fileName, items: items } : Host.call("stage", [path]);
        })
        .then(function (data) {
          state = freshState(data);
          state.path = path;
          els.source.textContent = data.fileName;
          els.source.title = path;
          showLoaded(true);
          var n = data.items.filter(function (i) { return i.type !== "folder"; }).length;
          setStatus(n + " items in " + data.fileName, "");
        });
    }).catch(function (e) {
      setStatus(e.message, "error");
    }).then(function () { setBusy(false); });
  }

  // Identity of an item that survives the import: folder path, kind, name,
  // and which same-named sibling it is. Item ids change when AE imports.
  function itemKeys(items) {
    var byId = new Map(), seen = {}, keys = new Map();
    items.forEach(function (it) { byId.set(it.id, it); });
    items.forEach(function (it) {
      var path = [], p = it;
      while (p && p.parent !== null) { p = byId.get(p.parent); if (p) path.unshift(p.name); }
      var kind = it.type === "folder" ? "folder" : it.type === "comp" ? "comp" : "footage";
      var base = path.join("/") + "|" + kind + "|" + it.name;
      seen[base] = (seen[base] || 0) + 1;
      keys.set(it.id, base + "#" + seen[base]);
    });
    return keys;
  }

  // A browsed project is only imported into After Effects when the user
  // imports from it. Swap the parsed tree for AE's, carrying the selection,
  // targets and open folders across. Rejects if a selected item can't be found.
  function ensureStaged() {
    if (state.stagingId) return Promise.resolve();
    setStatus("Importing " + state.fileName + " into After Effects…", "info");
    // The parsed file already knows every dependency, so AE skips that scan.
    return nextFrame().then(function () { return Host.call("stage", [state.path, { deps: false }]); }).then(function (data) {
      var oldKeys = itemKeys(Array.from(state.items.values()));
      var newKeys = itemKeys(data.items);
      var newIds = new Map(), oldIds = new Map();
      newKeys.forEach(function (key, id) { newIds.set(key, id); });
      oldKeys.forEach(function (key, id) { oldIds.set(key, id); });
      var lost = [];
      function remap(id) {
        var nid = newIds.get(oldKeys.get(id));
        if (nid === undefined) lost.push(state.items.get(id).name);
        return nid;
      }

      data.items.forEach(function (it) {
        var old = state.items.get(oldIds.get(newKeys.get(it.id)));
        if (!old) return;
        it.deps = old.deps
          .map(function (d) { return newIds.get(oldKeys.get(d)); })
          .filter(function (d) { return d !== undefined; });
      });

      var next = freshState(data);
      next.path = state.path;
      next.query = state.query;
      next.kinds = state.kinds;
      state.explicit.forEach(function (id) { var n = remap(id); if (n !== undefined) next.explicit.add(n); });
      state.targets.forEach(function (t, id) { var n = remap(id); if (n !== undefined) next.targets.set(n, t); });
      next.expanded = new Set();
      state.expanded.forEach(function (id) { var n = newIds.get(oldKeys.get(id)); if (n !== undefined) next.expanded.add(n); });
      state = next;
      render();
      if (lost.length) {
        throw new Error("After Effects didn't find " + lost.join(", ") + " where the file said. Check your selection and press Import again.");
      }
    });
  }

  // ------------------------------------------------------------ duplicates

  // Show the "already exists" dialog. Resolves {action, all} or null if the
  // user backs out of the import.
  function askConflict(c, remaining) {
    var d = els.dialog;
    d.querySelector("[data-f=name]").textContent = c.name;
    d.querySelector("[data-f=where]").textContent = c.existingWhere ? "in “" + c.existingWhere + "”" : "at the top of the project";
    d.querySelector("[data-f=match]").textContent = c.match;
    var all = d.querySelector("[data-f=all]");
    all.checked = false;
    all.parentNode.hidden = remaining < 2;
    d.querySelector("[data-f=count]").textContent = remaining - 1;
    d.hidden = false;
    return new Promise(function (resolve) {
      d.onclick = function (ev) {
        var btn = ev.target.closest("[data-choice]");
        if (!btn) return;
        d.hidden = true;
        d.onclick = null;
        var choice = btn.dataset.choice;
        resolve(choice === "cancel" ? null : { action: choice, all: all.checked });
      };
    });
  }

  // Ask about each conflict that is still needed, comps first, re-checking
  // after every answer since "use current" can make later ones irrelevant.
  function resolveConflicts(conflicts) {
    var resolutions = {}, existingIds = {}, applyAll = null;
    conflicts.sort(function (a, b) { return (a.type === "comp" ? 0 : 1) - (b.type === "comp" ? 0 : 1); });

    function pending() {
      var needed = closure(resolutions);
      return conflicts.filter(function (c) { return needed.has(c.id) && !(c.id in resolutions); });
    }

    function next() {
      var open = pending();
      if (!open.length) return Promise.resolve({ resolutions: resolutions, existingIds: existingIds });
      var c = open[0];
      existingIds[c.id] = c.existingId;
      if (applyAll) {
        resolutions[c.id] = applyAll;
        return next();
      }
      return askConflict(c, open.length).then(function (answer) {
        if (!answer) return null;
        resolutions[c.id] = answer.action;
        if (answer.all) applyAll = answer.action;
        return next();
      });
    }
    return next();
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function doImport() {
    if (!state || busy) return;
    if (!closure().size) return;
    var folderName = state.fileName.replace(/\.aepx?$/i, "");
    setBusy(true);
    ensureStaged()
      .then(function () {
        setStatus("Checking for duplicates…", "info");
        return Host.call("conflicts", [state.stagingId, Array.from(closure())]);
      })
      .then(function (conflicts) {
        // Items with a chosen target already know what they replace.
        conflicts = conflicts.filter(function (c) { return !state.targets.has(c.id); });
        setStatus(conflicts.length ? plural(conflicts.length, "item") + " already in this project" : "", "info");
        return resolveConflicts(conflicts);
      })
      .then(function (res) {
        if (!res) { setStatus("Import cancelled. Your selection is kept.", ""); return; }
        var keep = Array.from(closure(res.resolutions));
        var targets = {}, swaps = 0;
        state.targets.forEach(function (t, id) {
          if (keep.indexOf(id) !== -1) { targets[id] = t.id; swaps++; }
        });
        setStatus("Importing " + plural(keep.length, "item") + "…", "info");
        return Host.call("commit", [state.stagingId, keep, {
          merge: els.merge.checked,
          folderName: folderName,
          resolutions: res.resolutions,
          existingIds: res.existingIds,
          targets: targets
        }]).then(function (r) {
          var where = r.target === "merged" ? "merged into your folders" : "in folder “" + folderName + "”";
          var extra = [];
          if (r.reused) extra.push("reused " + r.reused + " existing");
          if (swaps) extra.push("swapped " + swaps);
          if (r.replaced - swaps > 0) extra.push("replaced " + (r.replaced - swaps));
          if (r.exprs) extra.push("updated " + plural(r.exprs, "expression"));
          reset();
          setStatus("Imported " + plural(r.imported, "item") + " " + where + (extra.length ? " (" + extra.join(", ") + ")" : "") + ".", "ok");
        });
      })
      .catch(function (e) { setStatus(e.message, "error"); })
      .then(function () { setBusy(false); });
  }

  function close() {
    if (!state || busy) return;
    var id = state.stagingId;
    reset();
    setStatus("", "");
    if (id) Host.call("discard", [id]).catch(function (e) { setStatus(e.message, "error"); });
  }

  function onTreeClick(ev) {
    var target = ev.target.closest("[data-act]");
    var rowEl = ev.target.closest(".row");
    if (!target || !rowEl || busy) return;
    var id = Number(rowEl.dataset.id);
    var it = state.items.get(id);

    if (target.dataset.act === "target") {
      openPicker(id);
      return;
    }
    if (target.dataset.act === "toggle") {
      if (it.type !== "folder") return;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    } else if (it.type === "folder") {
      var leaves = leavesUnder(id, []);
      var allOn = leaves.length && leaves.every(function (l) { return state.explicit.has(l); });
      leaves.forEach(function (l) {
        if (allOn) { state.explicit.delete(l); state.targets.delete(l); } else state.explicit.add(l);
      });
    } else if (state.explicit.has(id)) {
      state.explicit.delete(id);
      state.targets.delete(id);
    } else {
      state.explicit.add(id);
    }
    render();
  }

  // ------------------------------------------------------------ target picker

  var picker = null; // {stagedId, items, children, kinds, query, hideEmpty, selected}

  function openPicker(stagedId) {
    if (busy) return;
    Host.call("projectItems", [state.stagingId]).then(function (list) {
      var items = new Map(), children = new Map();
      list.forEach(function (it) {
        items.set(it.id, it);
        var key = it.parent === null ? "root" : it.parent;
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(it.id);
      });
      var staged = state.items.get(stagedId);
      var kinds = { comp: false, media: false, solid: false };
      kinds[kindOf(staged.type)] = true;
      var current = state.targets.get(stagedId);
      picker = {
        stagedId: stagedId, items: items, children: children, kinds: kinds,
        query: "", hideEmpty: true, selected: current ? current.id : null
      };
      var p = els.picker;
      p.querySelector("[data-f=name]").textContent = staged.name;
      p.querySelector("[data-f=search]").value = "";
      p.querySelector("[data-f=hide]").checked = true;
      p.querySelectorAll("[data-kind]").forEach(function (cb) { cb.checked = kinds[cb.dataset.kind]; });
      p.querySelector("[data-choice=clear]").hidden = !current;
      p.hidden = false;
      renderPicker();
      p.querySelector("[data-f=search]").focus();
    }).catch(function (e) { setStatus(e.message, "error"); });
  }

  function renderPicker() {
    var q = picker.query.toLowerCase(), show = new Set();
    function visit(id) {
      var it = picker.items.get(id), any = false;
      if (it.type === "folder") {
        (picker.children.get(id) || []).forEach(function (c) { if (visit(c)) any = true; });
        if (!any && !picker.hideEmpty && !q) any = true;
      } else {
        any = picker.kinds[kindOf(it.type)] && (!q || it.name.toLowerCase().indexOf(q) !== -1);
      }
      if (any) show.add(id);
      return any;
    }
    (picker.children.get("root") || []).forEach(visit);

    var html = [];
    function row(id, depth) {
      if (!show.has(id)) return;
      var it = picker.items.get(id), isFolder = it.type === "folder";
      html.push(
        '<div class="row' + (isFolder ? " folder" : "") + (picker.selected === id ? " picked" : "") + '" data-id="' + id + '" style="--depth:' + depth + '">' +
          '<span class="dot" style="background:' + (LABEL_COLORS[it.label] || "transparent") + '"></span>' +
          svg(it.type) + '<span class="name">' + esc(it.name) + "</span>" +
          (it.info ? '<span class="info">' + esc(it.info) + "</span>" : "") +
        "</div>"
      );
      if (isFolder) (picker.children.get(id) || []).forEach(function (c) { row(c, depth + 1); });
    }
    (picker.children.get("root") || []).forEach(function (id) { row(id, 0); });

    var listEl = els.picker.querySelector("[data-f=list]");
    listEl.innerHTML = html.length ? html.join("") : '<div class="empty"><p>No matching items in this project.</p></div>';
    els.picker.querySelector("[data-choice=ok]").disabled = !picker.selected || !show.has(picker.selected);
  }

  function pickerPath(p, id) {
    var parts = [], it = p.items.get(id);
    while (it && it.parent !== null) {
      it = p.items.get(it.parent);
      parts.unshift(it.name);
    }
    return parts.join(" / ");
  }

  function closePicker(choice) {
    var p = picker;
    els.picker.hidden = true;
    picker = null;
    if (choice === "ok" && p.selected) {
      // One project item can only be swapped out once.
      state.targets.forEach(function (t, sid) { if (t.id === p.selected) state.targets.delete(sid); });
      state.targets.set(p.stagedId, { id: p.selected, name: p.items.get(p.selected).name, where: pickerPath(p, p.selected) });
      state.explicit.add(p.stagedId);
    } else if (choice === "clear") {
      state.targets.delete(p.stagedId);
    }
    render();
  }

  els.picker.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-choice]");
    if (btn) { if (!btn.disabled) closePicker(btn.dataset.choice); return; }
    var rowEl = ev.target.closest("[data-f=list] .row");
    if (!rowEl || rowEl.classList.contains("folder")) return;
    picker.selected = Number(rowEl.dataset.id);
    renderPicker();
  });
  els.picker.addEventListener("dblclick", function (ev) {
    var rowEl = ev.target.closest("[data-f=list] .row");
    if (rowEl && !rowEl.classList.contains("folder")) closePicker("ok");
  });
  els.picker.addEventListener("input", function (ev) {
    if (!picker) return;
    var f = ev.target.dataset.f, kind = ev.target.dataset.kind;
    if (f === "search") picker.query = ev.target.value.trim();
    else if (f === "hide") picker.hideEmpty = ev.target.checked;
    else if (kind) picker.kinds[kind] = ev.target.checked;
    renderPicker();
  });

  // ------------------------------------------------------------ wiring

  els.pick.addEventListener("click", load);
  els.close.addEventListener("click", close);
  els.importBtn.addEventListener("click", doImport);
  els.tree.addEventListener("click", onTreeClick);
  els.search.addEventListener("input", function () {
    state.query = els.search.value.trim();
    render();
  });
  els.chips.addEventListener("change", function (ev) {
    state.kinds[ev.target.dataset.kind] = ev.target.checked;
    render();
  });

  // Remove staging folders left behind by a previous session of the panel.
  Host.call("cleanup").catch(function () { /* outside AE: ignore */ });

  // Exposed for testing.
  window.GraftPanel = {
    _open: openPath,
    _loadData: function (data) {
      state = freshState(data);
      els.source.textContent = data.fileName;
      showLoaded(true);
      render();
    }
  };
})();
