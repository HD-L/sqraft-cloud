/**
 * Sqraft 上传客户端主进程：窗口、自定义协议（浏览器登录回调）、IPC。
 * 令牌只在主进程里使用与保存，渲染层通过 preload 暴露的有限接口调用。
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import * as cloud from "./cloud";
import * as store from "./store";
import type { AppState, UploadRequest, UploadResult } from "../shared/types";

const PROTOCOL = "sqraft-uploader";
let win: BrowserWindow | null = null;
const queuedUrls: string[] = [];
let uploadAbort: AbortController | null = null;

// 开发态（electron .）也要能被浏览器唤起
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [join(process.cwd(), process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

if (!app.requestSingleInstanceLock()) app.quit();

function onProtocolUrl(url: string): void {
  if (!app.isReady()) {
    queuedUrls.push(url);
    return;
  }
  cloud.handleCallback(url);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// macOS：浏览器跳回 sqraft-uploader:// 时触发（可能早于 ready）
app.on("open-url", (event, url) => {
  event.preventDefault();
  onProtocolUrl(url);
});
// Windows / Linux：第二个实例带着协议地址启动
app.on("second-instance", (_e, argv) => {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (url) onProtocolUrl(url);
  else win?.focus();
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 600,
    title: "Sqraft 上传",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  // 渲染层只显示本地页面：不开新窗口、不跳转到外部
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("closed", () => (win = null));
}

// ── IPC ──

function requireServer(): string {
  const server = store.getServer();
  if (!server) throw new Error("请先配置私有云地址");
  return server;
}

function requireToken(): [string, string] {
  const server = requireServer();
  const token = store.loadToken(server);
  if (!token) throw new Error("请先登录");
  return [server, token];
}

async function state(): Promise<AppState> {
  const server = store.getServer();
  if (!server) return { server: null, user: null, insecure: false };
  const token = store.loadToken(server);
  let user = null;
  if (token) {
    try {
      user = await cloud.me(server, token);
    } catch (error) {
      // 令牌过期或被吊销：清掉，回到登录
      if (error instanceof cloud.CloudError && error.status === 401) store.clearToken(server);
      else throw error;
    }
  }
  return { server, user, insecure: cloud.isInsecure(server) };
}

async function fileInfo(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".sketch") throw new Error("只能上传 .sqraft。请先用 sketch2sqraft 把 Sketch 稿转换成 .sqraft，在 Sqraft 里确认后再上传。");
  if (ext !== ".sqraft") throw new Error("只能上传 .sqraft 设计稿");
  const s = await stat(path);
  if (!s.isFile()) throw new Error("不是文件");
  return { path, name: basename(path), size: s.size };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`缺少 ${name}`);
  return v;
};

function registerIpc(): void {
  ipcMain.handle("state", () => state());

  ipcMain.handle("set-server", async (_e, url: unknown) => {
    const server = cloud.normalizeServer(str(url, "地址"));
    await cloud.checkServer(server);
    store.setServer(server);
    return state();
  });

  ipcMain.handle("login", async () => {
    const server = requireServer();
    const token = await cloud.login(server);
    store.saveToken(server, token);
    return state();
  });

  ipcMain.handle("cancel-login", () => cloud.cancelLogin());

  ipcMain.handle("logout", async () => {
    const server = requireServer();
    const token = store.loadToken(server);
    if (token) await cloud.revoke(server, token).catch(() => undefined);
    store.clearToken(server);
    return state();
  });

  ipcMain.handle("projects", async () => {
    const [server, token] = requireToken();
    return (await cloud.listProjects(server, token)).filter((p) => p.role === "editor" && !p.archived);
  });

  ipcMain.handle("designs", async (_e, projectId: unknown) => {
    const [server, token] = requireToken();
    return cloud.listDesigns(server, token, str(projectId, "项目"));
  });

  ipcMain.handle("create-design", async (_e, projectId: unknown, name: unknown) => {
    const [server, token] = requireToken();
    return cloud.createDesign(server, token, str(projectId, "项目"), str(name, "名称").trim());
  });

  ipcMain.handle("pick-file", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "选择要上传的设计稿",
      properties: ["openFile"],
      filters: [{ name: "Sqraft 设计稿", extensions: ["sqraft"] }],
    });
    return res.canceled || !res.filePaths[0] ? null : fileInfo(res.filePaths[0]);
  });

  ipcMain.handle("file-info", (_e, path: unknown) => fileInfo(str(path, "文件")));

  ipcMain.handle("get-mapping", (_e, path: unknown) => {
    const server = store.getServer();
    return server ? store.getMapping(str(path, "文件"), server) : null;
  });

  ipcMain.handle("upload", async (e, req: UploadRequest): Promise<UploadResult> => {
    const [server, token] = requireToken();
    const file = await fileInfo(str(req.path, "文件"));
    if (uploadAbort) throw new Error("已有上传在进行");
    uploadAbort = new AbortController();
    try {
      const res = await cloud.uploadFile(
        server,
        token,
        str(req.designId, "设计稿"),
        file.path,
        typeof req.note === "string" ? req.note.slice(0, 500) : "",
        (p) => e.sender.send("upload-progress", p),
        uploadAbort.signal,
      );
      store.setMapping(file.path, { server, projectId: req.projectId, designId: req.designId, designName: req.designName, version: res.version });
      return { ...res, designId: req.designId, url: `${server}/designs/${encodeURIComponent(req.designId)}` };
    } finally {
      uploadAbort = null;
    }
  });

  ipcMain.handle("cancel-upload", () => uploadAbort?.abort());

  ipcMain.handle("open-design", (_e, designId: unknown) => {
    const server = requireServer();
    return shell.openExternal(`${server}/designs/${encodeURIComponent(str(designId, "设计稿"))}`);
  });

  ipcMain.handle("copy", (_e, text: unknown) => clipboard.writeText(str(text, "内容")));

  ipcMain.handle("design-latest", async (_e, designId: unknown) => {
    const [server, token] = requireToken();
    return (await cloud.getDesign(server, token, str(designId, "设计稿"))).latestVersion;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  for (const url of queuedUrls.splice(0)) onProtocolUrl(url);
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
