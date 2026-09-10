// Preload: expose the command surface through the context bridge. MessagePorts
// cannot cross the bridge, so a port arriving from main is re-posted to the
// page with window.postMessage, which is Electron's documented pattern.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  invoke: (cmd, arg) => ipcRenderer.invoke(cmd, arg),
  onPush: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("push", h);
    return () => ipcRenderer.removeListener("push", h);
  },
});

ipcRenderer.on("port", (e) => {
  window.postMessage("port", "*", e.ports);
});
