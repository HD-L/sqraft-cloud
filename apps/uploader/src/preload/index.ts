/** 渲染层能调用的全部能力：一组明确的 IPC，不暴露 Node / Electron 本身。 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { UploaderApi, UploadProgress } from "../shared/types";

const api: UploaderApi & { designLatest(designId: string): Promise<number | null> } = {
  getState: () => ipcRenderer.invoke("state"),
  setServer: (url) => ipcRenderer.invoke("set-server", url),
  login: () => ipcRenderer.invoke("login"),
  cancelLogin: () => ipcRenderer.invoke("cancel-login"),
  logout: () => ipcRenderer.invoke("logout"),
  listProjects: () => ipcRenderer.invoke("projects"),
  listDesigns: (projectId) => ipcRenderer.invoke("designs", projectId),
  createDesign: (projectId, name) => ipcRenderer.invoke("create-design", projectId, name),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  fileInfo: (path) => ipcRenderer.invoke("file-info", path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getMapping: (path) => ipcRenderer.invoke("get-mapping", path),
  upload: (req) => ipcRenderer.invoke("upload", req),
  cancelUpload: () => ipcRenderer.invoke("cancel-upload"),
  onProgress: (cb) => {
    const listener = (_e: unknown, p: UploadProgress) => cb(p);
    ipcRenderer.on("upload-progress", listener);
    return () => ipcRenderer.removeListener("upload-progress", listener);
  },
  openDesign: (designId) => ipcRenderer.invoke("open-design", designId),
  copy: (text) => ipcRenderer.invoke("copy", text),
  designLatest: (designId) => ipcRenderer.invoke("design-latest", designId),
};

contextBridge.exposeInMainWorld("uploader", api);
