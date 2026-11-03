# Graft (MVP)

An After Effects panel that imports chosen comps and footage from another
`.aep` without opening it. Their dependencies come along automatically.

## Install (development)

```bash
./install.sh
```

This links the folder into `~/Library/Application Support/Adobe/CEP/extensions/com.graft.panel`
and turns on `PlayerDebugMode` so the unsigned panel can load. Restart After Effects,
then open **Window > Extensions > Graft**.

Debug the panel UI in Chrome at `http://localhost:8088` while it is open.

## Package for others (.zxp)

```bash
./build.sh
```

This writes a signed `dist/Graft-<version>.zxp` (version from `CSXS/manifest.xml`). It holds only the panel's runtime files: no `.debug`, no dev scripts. Anyone can install it with [ZXP Installer](https://aescripts.com/learn/zxp-installer/) or Adobe's `ExManCmd --install`. Then restart After Effects and open **Window > Extensions > Graft**.

- Signing uses Adobe's `ZXPSignCmd` in `tools/` (from [Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)).
- The first build created a self-signed certificate in `cert/` (valid until 2038) and its password in `cert/password.txt`. **Back both up**: later versions must be signed with the same certificate so they update cleanly. Keep them out of any public repo.
- Bump `ExtensionBundleVersion` in the manifest for each release. The installer won't replace an installed copy that has the same version.

**Switching between the installed copy and development:** they can't both be installed. To go back to working on the source, remove the installed copy, then relink:

```bash
ExManCmd --remove com.graft.panel   # or remove it in ZXP Installer
./install.sh
```

## How it works

| Step | Where | What happens |
|---|---|---|
| Choose project | `js/aep.js` | The `.aep` file is read directly. After Effects isn't touched, so even a 2,000-item project opens in well under a second. The panel gets the tree, label colours, comp sizes, footage paths (following moved folders like After Effects does), missing-file flags, and each comp's dependencies (layer sources plus `comp("…")` / `footage("…")` references in expressions). If a file can't be parsed, Graft falls back to letting After Effects import it. |
| Import (first step) | `Graft.stage()` | Only now is the project imported into a hidden "⏳ Graft staging" folder. Your ticks and targets are matched onto the imported items by folder, name and type, and the parser's dependencies are reused so After Effects doesn't have to rescan every layer. |
| Tick items | `js/main.js` | Ticking an item adds everything it uses, recursively. Those show as **auto**. Ticking a folder ticks everything inside it. |
| Import | `Graft.commit()` | Every unticked item in the staging folder is deleted and empty folders are pruned. With **Merge into matching folders** on, the remaining folders merge into same-named folders in your project (`02. PRECOMPS` → `02. PRECOMPS`). Otherwise they stay in a folder named after the source file. |
| Duplicates | `Graft.conflicts()` + dialog | Before importing, items already in your project are found: footage by file path, solids by name + size + colour, comps by name. For each one you pick **Replace** (your layers switch to the imported item, which takes the old one's folder), **Use Current** (imported layers switch to yours and the copy is dropped, along with anything only it needed) or **Keep Both**. **Apply to all** answers the rest. Your own items are never deleted except the one you chose to replace. |
| Swap target | ⌖ button on a row → picker | Choose an item in your project for the imported one to replace. On import it takes that item's place everywhere: layers are switched over, it moves into that item's folder, the old item is removed, and `comp("Old name")` / `footage("Old name")` expressions are rewritten to the new name. Targeted items skip the duplicate dialog. |
| ✕ / Choose again | `Graft.discard()` | The staging folder is removed. Leftovers from a crashed session are cleaned up when the panel opens. |

Each step is one undo step in After Effects.

## Files

- `CSXS/manifest.xml`: panel registration (After Effects 2021+)
- `index.html`, `css/panel.css`, `js/main.js`: panel UI
- `js/cep.js`: tiny bridge to the CEP runtime (file dialog + `evalScript`)
- `js/aep.js`: reads the item tree out of an `.aep` file (also runs in plain Node)
- `jsx/host.jsx`: ExtendScript that runs inside After Effects

## Not in the MVP yet

- PSD / AI layer import, signed ZXP installer
