// Minimal bridge to the CEP runtime, so we don't have to vendor Adobe's
// CSInterface.js. Only the two calls Graft needs.
(function () {
  var cep = window.__adobe_cep__;

  // Run a host function and resolve with its parsed {ok, data, error} reply.
  function callHost(fn, args) {
    var script = "Graft." + fn + "(" + (args || []).map(function (a) { return JSON.stringify(a); }).join(",") + ")";
    return new Promise(function (resolve, reject) {
      if (!cep) return reject(new Error("Not running inside After Effects."));
      cep.evalScript(script, function (raw) {
        if (raw === "EvalScript error.") return reject(new Error("Host script error while running Graft." + fn + "."));
        var res;
        try { res = JSON.parse(raw); } catch (e) { return reject(new Error("Bad reply from host: " + raw)); }
        if (!res.ok) return reject(new Error(res.error));
        resolve(res.data);
      });
    });
  }

  // Native file picker. Resolves with a path, or null if cancelled.
  function pickFile(title, extensions) {
    var fs = window.cep && window.cep.fs;
    if (!fs) return Promise.reject(new Error("File dialog unavailable outside After Effects."));
    var res = fs.showOpenDialogEx(false, false, title, "", extensions);
    if (res.err) return Promise.reject(new Error("File dialog failed (" + res.err + ")."));
    return Promise.resolve(res.data && res.data.length ? res.data[0] : null);
  }

  window.Host = { call: callHost, pickFile: pickFile };
})();
