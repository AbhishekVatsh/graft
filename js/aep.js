// Reads the item tree out of an After Effects .aep file without opening it.
//
// An .aep is a big-endian RIFF ("RIFX") file of form "Egg!". The parts Graft
// needs:
//   LIST Fold            project root
//     LIST Item          one per project item
//       idta             type (u16 @0: 1 folder, 4 comp, 7 footage),
//                        id (u32 @16), label colour (u8 @58)
//       Utf8             name (empty for footage named after its file)
//       LIST Sfdr        folder contents (more LIST Item)
//       cdta             comp settings: width u16 @140, height u16 @142,
//                        duration u32 @43 / timebase u32 @47
//       LIST Layr        one per layer
//         ldta           source item id u32 @40 (0 = no source)
//         ... Utf8       expression text lives in Utf8 chunks further down
//       LIST Pin         footage: opti (format code, solid colour + name),
//                        LIST Als2 > alas (JSON with "fullpath")
//
// Output matches what Graft.stage() returns from After Effects, so the panel
// can browse either one.
(function (root) {
  "use strict";

  var VIDEO = /\.(mov|mp4|m4v|avi|mxf|webm|mkv|mpg|mpeg|r3d|braw|gif)$/i;
  var AUDIO = /\.(wav|mp3|aif|aiff|aac|m4a|ogg|flac)$/i;
  var EXPR_REFS = [/\b(?:comp|footage)\(\s*"([^"]*)"\s*\)/g, /\b(?:comp|footage)\(\s*'([^']*)'\s*\)/g];

  function ParseError(msg) { this.name = "ParseError"; this.message = msg; }
  ParseError.prototype = Object.create(Error.prototype);

  // Footage paths are stored absolute, plus how many folders up the project
  // and the file share a root. If the absolute path is gone, re-anchor it to
  // where the project lives now -- the same way After Effects finds moved files.
  function resolvePath(alias, projectPath, exists) {
    var full = alias.fullpath;
    if (!full || !projectPath || !exists || exists(full)) return full;
    var base = alias.ascendcount_base, target = alias.ascendcount_target;
    if (!(base > 0 && target > 0)) return full;
    var sep = full.indexOf("\\") !== -1 && full.indexOf("/") === -1 ? "\\" : "/";
    var fileParts = full.split(/[\\/]/), projParts = projectPath.split(/[\\/]/);
    if (fileParts.length <= target || projParts.length <= base) return full;
    var moved = projParts.slice(0, projParts.length - base).concat(fileParts.slice(fileParts.length - target)).join(sep);
    return exists(moved) ? moved : full;
  }

  // opts (optional): { projectPath, exists(path) } to resolve moved footage
  // and flag missing files.
  function parse(buf, opts) {
    opts = opts || {};
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var utf8 = new TextDecoder("utf-8");

    function id4(off) { return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]); }
    function text(off, len) { return utf8.decode(buf.subarray(off, off + len)).replace(/\0[\s\S]*$/, ""); }

    // Iterate the chunks in [off, end): fn(id, bodyOffset, size).
    function each(off, end, fn) {
      while (off + 8 <= end) {
        var cid = id4(off), size = view.getUint32(off + 4);
        if (off + 8 + size > end) throw new ParseError("Chunk " + cid + " runs past its parent.");
        if (fn(cid, off + 8, size) === false) return;
        off += 8 + size + (size & 1);
      }
    }

    // Like each(), but descends into LIST chunks: fn(listType, start, end).
    function lists(off, end, fn) {
      each(off, end, function (cid, body, size) {
        if (cid === "LIST") fn(id4(body), body + 4, body + size);
      });
    }

    // Collect every Utf8 string under a chunk range (skipping binary key data).
    function strings(off, end, out) {
      each(off, end, function (cid, body, size) {
        if (cid === "Utf8" && size) out.push(text(body, size));
        else if (cid === "LIST" && id4(body) !== "btdk") strings(body + 4, body + size, out);
      });
      return out;
    }

    if (buf.length < 12 || id4(0) !== "RIFX" || id4(8) !== "Egg!") {
      throw new ParseError("Not an After Effects project file.");
    }

    var items = [];

    function footageInfo(start, end, entry) {
      each(start, end, function (cid, body, size) {
        if (cid === "opti" && size >= 4) {
          var code = id4(body);
          if (code === "Soli" && size >= 26) {
            entry.type = "solid";
            entry.solidName = text(body + 26, Math.min(256, size - 26));
            entry.color = [view.getFloat32(body + 14), view.getFloat32(body + 18), view.getFloat32(body + 22)];
          } else if (code === "8BPS" && size > 344) {
            // One layer of a layered PSD; empty for a flattened import.
            entry.psdLayer = text(body + 344, Math.min(256, size - 344));
          }
        } else if (cid === "LIST" && id4(body) === "Als2") {
          each(body + 4, body + size, function (c2, b2, s2) {
            if (c2 !== "alas") return;
            try { entry.path = resolvePath(JSON.parse(text(b2, s2)), opts.projectPath, opts.exists) || undefined; } catch (e) { /* ignore */ }
          });
        }
      });
    }

    function compInfo(body, size, entry) {
      if (size < 144) return;
      var w = view.getUint16(body + 140), h = view.getUint16(body + 142);
      var dur = view.getUint32(body + 43), base = view.getUint32(body + 47);
      entry.info = w + "x" + h;
      if (base && dur / base < 100000) entry.info += "  " + Math.round(dur / base * 100) / 100 + "s";
    }

    function readItems(start, end, parentId) {
      lists(start, end, function (type, s, e) {
        if (type !== "Item") return;
        var entry = { id: 0, name: "", type: "other", label: 0, parent: parentId, deps: [], exprNames: [] };
        var kind = 0, children = null;

        each(s, e, function (cid, body, size) {
          if (cid === "idta" && size >= 20) {
            kind = view.getUint16(body);
            entry.id = view.getUint32(body + 16);
            if (size > 58) entry.label = buf[body + 58] & 0x1f;
          } else if (cid === "Utf8" && !entry.name) {
            entry.name = text(body, size);
          } else if (cid === "cdta") {
            compInfo(body, size, entry);
          } else if (cid === "LIST") {
            var lt = id4(body);
            if (lt === "Sfdr") children = [body + 4, body + size];
            else if (lt === "Pin ") footageInfo(body + 4, body + size, entry);
            else if (lt === "Layr") {
              each(body + 4, body + size, function (c2, b2, s2) {
                if (c2 === "ldta" && s2 >= 44) {
                  var src = view.getUint32(b2 + 40);
                  if (src) entry.deps.push(src);
                  return false;
                }
              });
              strings(body + 4, body + size, []).forEach(function (str) {
                EXPR_REFS.forEach(function (re) {
                  re.lastIndex = 0;
                  var m;
                  while ((m = re.exec(str)) !== null) entry.exprNames.push(m[1]);
                });
              });
            }
          }
        });

        if (kind === 1) entry.type = "folder";
        else if (kind === 4) entry.type = "comp";
        else if (kind === 7) {
          if (entry.type !== "solid") {
            var p = entry.path || "";
            entry.type = !p ? "placeholder" : VIDEO.test(p) ? "video" : AUDIO.test(p) ? "audio" : "still";
          }
          if (!entry.name) {
            var file = entry.path ? entry.path.split(/[\\/]/).pop() : "";
            entry.name = entry.solidName || (entry.psdLayer && file ? entry.psdLayer + "/" + file : file) || "Untitled footage";
          }
          if (entry.path && opts.exists) entry.missing = !opts.exists(entry.path);
        }
        delete entry.solidName;
        delete entry.psdLayer;
        if (!entry.id) return;

        items.push(entry);
        if (children) readItems(children[0], children[1], entry.id);
      });
    }

    var found = false;
    lists(12, Math.min(buf.length, 8 + view.getUint32(4)), function (type, s, e) {
      if (type !== "Fold" || found) return;
      found = true;
      readItems(s, e, null);
    });
    if (!found) throw new ParseError("No project tree found in this file.");

    // Resolve expression references by name, like Graft.stage() does.
    var byName = {};
    items.forEach(function (it) {
      if (it.type !== "folder") (byName[it.name] = byName[it.name] || []).push(it.id);
    });
    items.forEach(function (it) {
      it.exprNames.forEach(function (n) { if (byName[n]) it.deps = it.deps.concat(byName[n]); });
    });
    return items;
  }

  var api = { parse: parse, ParseError: ParseError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AepParser = api;
})(typeof window !== "undefined" ? window : null);
