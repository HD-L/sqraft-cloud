/** 主进程与渲染层共用的类型。令牌永远只在主进程里，这里没有它。 */

export interface CloudUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface AppState {
  server: string | null;
  user: CloudUser | null;
  /** 服务端地址不是 HTTPS（且不是本机）时提示风险 */
  insecure: boolean;
}

export interface Project {
  id: string;
  name: string;
  role: "editor" | "viewer";
  archived: boolean;
}

export interface Design {
  id: string;
  name: string;
  currentVersion: number | null;
  latestVersion: number | null;
  updatedAt: number;
}

export interface LocalFile {
  path: string;
  name: string;
  size: number;
}

/** 本地文件 ↔ 云端设计稿的对应关系（U7） */
export interface FileMapping {
  server: string;
  projectId: string;
  designId: string;
  designName: string;
  /** 上次从这台电脑上传成功的版本号 */
  version: number;
}

export interface UploadRequest {
  path: string;
  projectId: string;
  designId: string;
  designName: string;
  note: string;
}

/** 这次实际传了多少（增量上传只传服务端没有的页面与切图） */
export interface UploadStats {
  mode: "incremental" | "whole";
  sentBytes: number;
  totalBytes: number;
  sentParts: number;
  totalParts: number;
  sentAssets: number;
  totalAssets: number;
}

/** 服务端返回的版本变更摘要（相对基准版本） */
export interface ChangeSummary {
  base: number | null;
  pages: { added: number; modified: number; removed: number; renamed: number; moved: number };
  components: { added: number; modified: number; removed: number; renamed: number; moved: number };
  tokens: number;
  assets: { added: number; removed: number };
}

export interface UploadResult {
  duplicate: boolean;
  version: number;
  designId: string;
  url: string;
  changes: ChangeSummary | null;
  stats: UploadStats;
}

export interface UploadProgress {
  sent: number;
  total: number;
  /** analyzing：本地拆页、算哈希；uploading：传文件；verifying：服务端校验与建索引 */
  phase: "analyzing" | "uploading" | "verifying";
}

export interface UploaderApi {
  getState(): Promise<AppState>;
  setServer(url: string): Promise<AppState>;
  login(): Promise<AppState>;
  cancelLogin(): Promise<void>;
  logout(): Promise<AppState>;
  listProjects(): Promise<Project[]>;
  listDesigns(projectId: string): Promise<Design[]>;
  createDesign(projectId: string, name: string): Promise<Design>;
  pickFile(): Promise<LocalFile | null>;
  fileInfo(path: string): Promise<LocalFile>;
  pathForFile(file: File): string;
  getMapping(path: string): Promise<FileMapping | null>;
  upload(req: UploadRequest): Promise<UploadResult>;
  cancelUpload(): Promise<void>;
  onProgress(cb: (p: UploadProgress) => void): () => void;
  openDesign(designId: string): Promise<void>;
  copy(text: string): Promise<void>;
}
