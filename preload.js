const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("notch", {
  onState: (cb) => ipcRenderer.on("state", (_e, d) => cb(d)),
  onMedia: (cb) => ipcRenderer.on("media", (_e, d) => cb(d)),
  onLayout: (cb) => ipcRenderer.on("layout", (_e, d) => cb(d)),
  mouseEnter: () => ipcRenderer.send("mouseenter"),
  mouseLeave: () => ipcRenderer.send("mouseleave"),
  togglePin: () => ipcRenderer.send("toggle-pin"),
  forceCollapse: () => ipcRenderer.send("force-collapse"),
  setMouseIgnore: (v) => ipcRenderer.send("mouse-ignore", v),
  setRects: (r) => ipcRenderer.send("rects", r),
  media: (action) => ipcRenderer.send("media", action),

  // WhatsApp bridge
  waConnect: () => ipcRenderer.send("wa-connect"),
  waDisconnect: () => ipcRenderer.send("wa-disconnect"),
  waForget: () => ipcRenderer.send("wa-forget"),
  waCommand: (t) => ipcRenderer.send("wa-command", t),
  waStatus: () => ipcRenderer.invoke("wa-status"),
  waRepos: () => ipcRenderer.invoke("wa-repos"),
  // Screenshot gallery (#4)
  shotsList: () => ipcRenderer.invoke("shots-list"),
  shotsOpen: (p) => ipcRenderer.send("shots-open", p),
  shotsSend: (p) => ipcRenderer.send("shots-send", p),
  // Drag-drop onto the notch (#9) — File.path is gone in Electron 45,
  // webUtils.getPathForFile is the only way back to a real path.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  filesDropped: (paths) => ipcRenderer.send("files-dropped", paths),
  onDropStatus: (cb) => ipcRenderer.on("drop-status", (_e, d) => cb(d)),
  onWaStatus: (cb) => ipcRenderer.on("wa-status", (_e, d) => cb(d)),
  onWaQr: (cb) => ipcRenderer.on("wa-qr", (_e, d) => cb(d)),
  onWaEvent: (cb) => ipcRenderer.on("wa-event", (_e, d) => cb(d)),

  // Intro overlay (intro/intro.js)
  introInfo: () => ipcRenderer.invoke("intro:info"),
  introDone: () => ipcRenderer.send("intro:done"),
  introStart: () => ipcRenderer.send("intro:start"),
  introSkip: () => ipcRenderer.send("intro:skip-req"),
  onIntroSkip: (cb) => ipcRenderer.on("intro:skip", () => cb()),
  onIntroVisible: (cb) => ipcRenderer.on("intro-visible", (_e, v) => cb(v)),
  onFullscreen: (cb) => ipcRenderer.on("fullscreen", (_e, v) => cb(v)),
});
