// Graft host script. Runs inside After Effects (ExtendScript / ES3).
//
// Flow:
//   1. stage(path)   imports the whole .aep into a hidden "staging" folder and
//                    returns its item tree plus each comp's dependencies.
//   2. commit(...)   keeps only the items the panel asked for, deletes the rest,
//                    prunes empty folders and (optionally) merges the remaining
//                    folders into same-named folders in the current project.
//   3. discard(id)   throws the staging folder away.
//
// Every public function returns a JSON string: {"ok":true,"data":...} or
// {"ok":false,"error":"..."}.

var Graft = (function () {
    var STAGING_COMMENT = "graft:staging";

    // ---------------------------------------------------------------- JSON

    function quote(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === "\\") out += "\\\\";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\t") out += "\\t";
            else if (code < 0x20) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
            else out += c;
        }
        return out + '"';
    }

    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return quote(v);
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return "[" + parts.join(",") + "]";
        }
        var props = [];
        for (var k in v) {
            if (v.hasOwnProperty(k)) props.push(quote(k) + ":" + toJSON(v[k]));
        }
        return "{" + props.join(",") + "}";
    }

    function ok(data) { return toJSON({ ok: true, data: data }); }
    function fail(err) { return toJSON({ ok: false, error: String(err && err.message ? err.message : err) }); }

    // ------------------------------------------------------------- helpers

    function findItem(id) {
        var proj = app.project;
        if (!proj) return null;
        if (typeof proj.itemByID === "function") {
            try { return proj.itemByID(id); } catch (e) { /* fall through */ }
        }
        for (var i = 1; i <= proj.numItems; i++) {
            if (proj.item(i).id === id) return proj.item(i);
        }
        return null;
    }

    function stagingFolders() {
        var found = [];
        if (!app.project) return found;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.comment === STAGING_COMMENT) found.push(it);
        }
        return found;
    }

    function itemType(item) {
        if (item instanceof FolderItem) return "folder";
        if (item instanceof CompItem) return "comp";
        if (item instanceof FootageItem) {
            var src = item.mainSource;
            if (src instanceof SolidSource) return "solid";
            if (src instanceof PlaceholderSource) return "placeholder";
            if (!item.hasVideo && item.hasAudio) return "audio";
            if (src.isStill) return "still";
            return "video";
        }
        return "other";
    }

    // Collect comp("Name") / footage("Name") references from every expression
    // on a property group, recursively.
    var EXPR_REFS = [/\b(?:comp|footage)\(\s*"([^"]*)"\s*\)/g, /\b(?:comp|footage)\(\s*'([^']*)'\s*\)/g];

    function scanExpressions(group, names) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (e) { continue; }
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) {
                var expr = "";
                try { if (p.canSetExpression && p.expressionEnabled) expr = p.expression; } catch (e2) { }
                for (var r = 0; expr && r < EXPR_REFS.length; r++) {
                    var re = EXPR_REFS[r], m;
                    re.lastIndex = 0;
                    while ((m = re.exec(expr)) !== null) names.push(m[1]);
                }
            } else {
                scanExpressions(p, names);
            }
        }
    }

    // Direct dependencies of a comp: layer sources (precomps, footage, solids)
    // plus names referenced from expressions (resolved later in stage()).
    function compDeps(comp) {
        var ids = [], names = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            try {
                if (layer.source) ids.push(layer.source.id);
            } catch (e) { /* cameras / lights / text / shapes have no source */ }
            try { scanExpressions(layer, names); } catch (e2) { }
        }
        return { ids: ids, names: names };
    }

    // withDeps: false skips scanning layers and expressions, which is most of
    // the time on a big project, for callers that already know dependencies.
    function walk(folder, parentId, out, byName, withDeps) {
        for (var i = 1; i <= folder.numItems; i++) {
            var it = folder.item(i);
            var entry = {
                id: it.id,
                name: it.name,
                type: itemType(it),
                label: it.label,
                parent: parentId,
                deps: [],
                exprNames: []
            };
            if (it instanceof FootageItem) {
                entry.missing = !!it.footageMissing;
                try { if (it.file) entry.path = it.file.fsName; } catch (e) { }
            }
            if (it instanceof CompItem) {
                if (withDeps) {
                    var d = compDeps(it);
                    entry.deps = d.ids;
                    entry.exprNames = d.names;
                }
                entry.info = it.width + "x" + it.height + "  " + Math.round(it.duration * 100) / 100 + "s";
            }
            if (!(it instanceof FolderItem)) {
                (byName[it.name] = byName[it.name] || []).push(it.id);
            }
            out.push(entry);
            if (it instanceof FolderItem) walk(it, it.id, out, byName, withDeps);
        }
    }

    // Delete empty sub-folders, bottom-up. Returns true if `folder` is now empty.
    function pruneEmpty(folder) {
        for (var i = folder.numItems; i >= 1; i--) {
            var child = folder.item(i);
            if (child instanceof FolderItem && pruneEmpty(child)) child.remove();
        }
        return folder.numItems === 0;
    }

    function childFolderNamed(parent, name) {
        for (var i = 1; i <= parent.numItems; i++) {
            var it = parent.item(i);
            if (it instanceof FolderItem && it.name === name && it.comment !== STAGING_COMMENT) return it;
        }
        return null;
    }

    // Move everything in `src` into `dst`, merging sub-folders that share a name.
    function mergeInto(src, dst) {
        var children = [];
        for (var i = 1; i <= src.numItems; i++) children.push(src.item(i));
        for (var j = 0; j < children.length; j++) {
            var child = children[j];
            var twin = child instanceof FolderItem ? childFolderNamed(dst, child.name) : null;
            if (twin) {
                mergeInto(child, twin);
                if (child.numItems === 0) child.remove();
            } else {
                child.parentFolder = dst;
            }
        }
    }

    // ----------------------------------------------------------- duplicates

    function isInside(item, folder) {
        for (var f = item.parentFolder, guard = 0; f && guard < 100; f = f.parentFolder, guard++) {
            if (f.id === folder.id) return true;
            if (f.id === app.project.rootFolder.id) return false;
        }
        return false;
    }

    function folderPath(item) {
        var parts = [];
        for (var f = item.parentFolder, guard = 0; f && f.id !== app.project.rootFolder.id && guard < 100; f = f.parentFolder, guard++) {
            parts.unshift(f.name);
        }
        return parts.join(" / ");
    }

    // Identity used to decide that two items are "the same thing", or null if
    // the item can't be matched.
    function matchKey(item) {
        if (item instanceof CompItem) return "comp|" + item.name;
        if (!(item instanceof FootageItem)) return null;
        var src = item.mainSource;
        if (src instanceof SolidSource) {
            var c = src.color;
            return "solid|" + item.name + "|" + item.width + "x" + item.height + "|" +
                Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255);
        }
        if (src instanceof PlaceholderSource) return "placeholder|" + item.name;
        try { if (item.file) return "file|" + item.file.fsName; } catch (e) { }
        return null;
    }

    var MATCH_REASON = { comp: "same name", solid: "same name, size and colour", placeholder: "same name", file: "same file on disk" };

    // Items in the project (outside staging) that the given staged items duplicate.
    function conflicts(stagingId, keepIds) {
        try {
            var staging = findItem(stagingId);
            if (!staging || staging.comment !== STAGING_COMMENT) return fail("The staged project is gone. Load the file again.");

            var existing = {};
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (it instanceof FolderItem || isInside(it, staging)) continue;
                var key = matchKey(it);
                if (key && !existing[key]) existing[key] = it;
            }

            var out = [];
            for (var k = 0; k < keepIds.length; k++) {
                var staged = findItem(keepIds[k]);
                var sk = staged && matchKey(staged);
                var twin = sk && existing[sk];
                if (!twin) continue;
                out.push({
                    id: staged.id,
                    name: staged.name,
                    type: itemType(staged),
                    existingId: twin.id,
                    existingWhere: folderPath(twin),
                    match: MATCH_REASON[sk.split("|")[0]]
                });
            }
            return ok(out);
        } catch (e) { return fail(e); }
    }

    // Every layer in the project, grouped by the id of its source item.
    function layerUsage(staging) {
        var usage = {};
        for (var i = 1; i <= app.project.numItems; i++) {
            var comp = app.project.item(i);
            if (!(comp instanceof CompItem)) continue;
            var staged = isInside(comp, staging);
            for (var l = 1; l <= comp.numLayers; l++) {
                var layer = comp.layer(l), src = null;
                try { src = layer.source; } catch (e) { }
                if (!src) continue;
                (usage[src.id] = usage[src.id] || []).push({ layer: layer, staged: staged });
            }
        }
        return usage;
    }

    function repoint(uses, staged, to) {
        var n = 0;
        for (var i = 0; uses && i < uses.length; i++) {
            if (uses[i].staged !== staged) continue;
            uses[i].layer.replaceSource(to, false);
            n++;
        }
        return n;
    }

    function quoteExpr(name) { return '"' + name.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }

    // Rewrite comp("old") / footage("old") to the new name in every expression
    // outside staging. Returns how many expressions changed.
    function renameRefs(oldName, newName, staging) {
        if (oldName === newName) return 0;
        var changed = 0;
        var olds = [quoteExpr(oldName), "'" + oldName.replace(/'/g, "\\'") + "'"];
        var fresh = quoteExpr(newName);
        function fix(group) {
            for (var i = 1; i <= group.numProperties; i++) {
                var p;
                try { p = group.property(i); } catch (e) { continue; }
                if (!p) continue;
                if (p.propertyType !== PropertyType.PROPERTY) { fix(p); continue; }
                var expr = "";
                try { if (p.canSetExpression && p.expression) expr = p.expression; } catch (e2) { }
                if (!expr) continue;
                var next = expr;
                for (var o = 0; o < olds.length; o++) {
                    next = next.split("comp(" + olds[o] + ")").join("comp(" + fresh + ")")
                               .split("footage(" + olds[o] + ")").join("footage(" + fresh + ")");
                }
                if (next !== expr) {
                    try { p.expression = next; changed++; } catch (e3) { }
                }
            }
        }
        for (var i = 1; i <= app.project.numItems; i++) {
            var comp = app.project.item(i);
            if (!(comp instanceof CompItem) || isInside(comp, staging)) continue;
            for (var l = 1; l <= comp.numLayers; l++) fix(comp.layer(l));
        }
        return changed;
    }

    // resolutions: { stagedId: "replace" | "current" | "both" }, each paired with
    // existingIds[stagedId]. Runs after unselected items have been deleted.
    // Replaces go first so a later "current" can follow an item to its
    // replacement instead of pointing at something about to be removed.
    function applyResolutions(staging, resolutions, existingIds) {
        var usage = layerUsage(staging), replacedBy = {}, reused = 0, replaced = 0, exprs = 0;
        var id, staged, exId, existing;

        for (id in resolutions) {
            if (!resolutions.hasOwnProperty(id) || resolutions[id] !== "replace") continue;
            staged = findItem(Number(id));
            exId = existingIds[id];
            existing = findItem(exId);
            if (!staged || !existing || replacedBy[exId]) continue;
            // Point the project's layers at the imported item and put it
            // where the old one lived.
            repoint(usage[existing.id], false, staged);
            exprs += renameRefs(existing.name, staged.name, staging);
            staged.parentFolder = existing.parentFolder;
            existing.remove();
            replacedBy[exId] = staged;
            replaced++;
        }

        for (id in resolutions) {
            if (!resolutions.hasOwnProperty(id) || resolutions[id] !== "current") continue;
            staged = findItem(Number(id));
            exId = existingIds[id];
            existing = replacedBy[exId] || findItem(exId);
            if (!staged || !existing) continue;
            // Point imported layers at the item already in the project.
            repoint(usage[staged.id], true, existing);
            staged.remove();
            reused++;
        }
        return { reused: reused, replaced: replaced, exprs: exprs };
    }

    // Items outside staging, for the "choose a target" picker.
    function projectItems(stagingId) {
        try {
            var out = [];
            (function walkTree(folder, parentId) {
                for (var i = 1; i <= folder.numItems; i++) {
                    var it = folder.item(i);
                    if (it instanceof FolderItem && (it.id === stagingId || it.comment === STAGING_COMMENT)) continue;
                    var entry = { id: it.id, name: it.name, type: itemType(it), label: it.label, parent: parentId };
                    if (it instanceof CompItem) entry.info = it.width + "x" + it.height;
                    out.push(entry);
                    if (it instanceof FolderItem) walkTree(it, it.id);
                }
            })(app.project.rootFolder, null);
            return ok(out);
        } catch (e) { return fail(e); }
    }

    // ---------------------------------------------------------- public API

    function ping() {
        return ok({ app: app.version, hasProject: !!app.project });
    }

    function cleanup() {
        try {
            var folders = stagingFolders();
            if (folders.length) {
                app.beginUndoGroup("Graft: clean up");
                for (var i = 0; i < folders.length; i++) folders[i].remove();
                app.endUndoGroup();
            }
            return ok({ removed: folders.length });
        } catch (e) { return fail(e); }
    }

    // opts: { deps: false } to skip dependency scanning (see walk()).
    function stage(path, opts) {
        var suppressing = false;
        try {
            var file = new File(path);
            if (!file.exists) return fail("File not found: " + path);
            if (!app.project) app.newProject();

            var io = new ImportOptions(file);
            if (!io.canImportAs(ImportAsType.PROJECT)) return fail("Not an After Effects project: " + file.displayName);
            io.importAs = ImportAsType.PROJECT;

            // Only one staging folder at a time.
            var old = stagingFolders();
            app.beginUndoGroup("Graft: read project");
            for (var i = 0; i < old.length; i++) old[i].remove();

            app.beginSuppressDialogs();
            suppressing = true;
            var folder = app.project.importFile(io);
            app.endSuppressDialogs(false);
            suppressing = false;

            folder.name = "⏳ Graft staging (" + file.displayName + ")";
            folder.comment = STAGING_COMMENT;
            app.endUndoGroup();

            var items = [], byName = {};
            walk(folder, null, items, byName, !(opts && opts.deps === false));

            // Resolve expression references to item ids inside the staged project.
            for (var k = 0; k < items.length; k++) {
                var e = items[k];
                for (var n = 0; n < e.exprNames.length; n++) {
                    var hits = byName[e.exprNames[n]];
                    if (hits) e.deps = e.deps.concat(hits);
                }
            }

            return ok({ stagingId: folder.id, fileName: file.displayName, items: items });
        } catch (err) {
            if (suppressing) { try { app.endSuppressDialogs(false); } catch (e3) { } }
            try { app.endUndoGroup(); } catch (e4) { }
            return fail(err);
        }
    }

    // keepIds: ids of every non-folder item to keep (the panel has already
    // expanded dependencies). opts: { merge: bool, folderName: string,
    // resolutions: {stagedId: action}, existingIds: {stagedId: existingId} }
    function commit(stagingId, keepIds, opts) {
        try {
            opts = opts || {};
            var staging = findItem(stagingId);
            if (!staging || staging.comment !== STAGING_COMMENT) {
                return fail("The staged project is gone (was the project closed or the folder deleted?). Load the file again.");
            }

            var keep = {};
            for (var i = 0; i < keepIds.length; i++) keep[keepIds[i]] = true;

            // Count kept / total items under each folder.
            var tally = {};
            (function count(f) {
                var t = { kept: 0, total: 0 };
                for (var j = 1; j <= f.numItems; j++) {
                    var it = f.item(j);
                    if (it instanceof FolderItem) {
                        var sub = count(it);
                        t.kept += sub.kept;
                        t.total += sub.total;
                    } else {
                        t.total++;
                        if (keep[it.id]) t.kept++;
                    }
                }
                tally[f.id] = t;
                return t;
            })(staging);

            // Folders with nothing kept go in one call each: deleting thousands
            // of items one at a time takes minutes in a big project.
            var comps = [], footage = [], folders = [];
            (function gather(f) {
                for (var j = 1; j <= f.numItems; j++) {
                    var it = f.item(j);
                    if (it instanceof FolderItem) {
                        if (tally[it.id].kept) gather(it); else folders.push(it);
                    } else if (!keep[it.id]) {
                        (it instanceof CompItem ? comps : footage).push(it);
                    }
                }
            })(staging);

            app.beginUndoGroup("Graft: import selected");

            // Comps first so removing footage doesn't have to touch their layers.
            for (var c = 0; c < comps.length; c++) comps[c].remove();
            for (var d = 0; d < folders.length; d++) folders[d].remove();
            for (var f = 0; f < footage.length; f++) footage[f].remove();
            var removed = tally[staging.id].total - tally[staging.id].kept;

            // Chosen targets are swaps: a "replace" against an item the user picked.
            var resolutions = opts.resolutions || {}, existingIds = opts.existingIds || {}, targets = opts.targets || {};
            for (var t in targets) {
                if (!targets.hasOwnProperty(t) || !keep[t]) continue;
                resolutions[t] = "replace";
                existingIds[t] = targets[t];
            }

            var dup = applyResolutions(staging, resolutions, existingIds);
            var imported = keepIds.length - dup.reused;
            var result = { imported: imported, removed: removed, reused: dup.reused, replaced: dup.replaced, exprs: dup.exprs };

            if (pruneEmpty(staging)) {
                staging.remove();
                app.endUndoGroup();
                result.target = "merged";
                return ok(result);
            }

            var target = "folder";
            if (opts.merge) {
                mergeInto(staging, app.project.rootFolder);
                target = "merged";
            }
            if (staging.numItems === 0) {
                staging.remove();
            } else {
                staging.name = opts.folderName || "Graft import";
                staging.comment = "Imported with Graft";
            }

            app.endUndoGroup();
            result.target = target;
            return ok(result);
        } catch (err) {
            try { app.endUndoGroup(); } catch (e2) { }
            return fail(err);
        }
    }

    function discard(stagingId) {
        try {
            var staging = findItem(stagingId);
            if (staging && staging.comment === STAGING_COMMENT) {
                app.beginUndoGroup("Graft: cancel");
                staging.remove();
                app.endUndoGroup();
            }
            return ok({ discarded: !!staging });
        } catch (e) { return fail(e); }
    }

    // Select an item in the Project panel so the user can see what landed.
    function reveal(id) {
        try {
            var it = findItem(id);
            if (it) it.selected = true;
            return ok(true);
        } catch (e) { return fail(e); }
    }

    return { ping: ping, cleanup: cleanup, stage: stage, conflicts: conflicts, projectItems: projectItems, commit: commit, discard: discard, reveal: reveal, _toJSON: toJSON };
})();
