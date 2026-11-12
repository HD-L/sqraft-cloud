# 云设计 Web 端设计规范

面向团队内部的设计稿查看与交付工具。界面气质对标 Linear / Figma：浅色、中性、安静，内容（设计稿）是主角，界面本身不抢戏。

## 原则

1. **不用 emoji 当图标**。图标一律用 `lucide-vue-next`：`import { Folder } from "lucide-vue-next"`，默认 `:size="16"`，按钮里 15–16，空状态 22。文字按钮可以带一个前置图标。
2. **颜色只用变量**（`src/styles.css` 顶部）：`--text / --text-2 / --muted / --faint`、`--bg / --panel / --panel-2 / --hover / --active`、`--border / --border-strong`、`--brand / --brand-soft`、`--danger / --ok / --warning / --purple` 及其 `-soft`。组件样式里不要写死十六进制色值（画布叠加层、代码高亮的深色配色除外）。
3. **层级靠字重和灰度，不靠字号和颜色堆叠**。正文 13px；页面标题 20px/650；分区标题 14px/650；辅助信息 12px `--muted`。数字用 `font-variant-numeric: tabular-nums`。
4. **间距用 4 的倍数**：4 / 8 / 12 / 16 / 20 / 24 / 32。卡片内边距 16，页面左右 32。
5. **圆角**：控件 `--radius-sm`(7)，卡片 `--radius`(10)，弹窗 `--radius-lg`(14)，标签 999。
6. **阴影克制**：卡片 `--shadow-xs`，悬停 `--shadow-md`，浮层 `--shadow-lg`。
7. **每个列表都有三种状态**：加载中（`.skeleton` 骨架，不要只写「加载中…」）、空（`<EmptyState>`）、有数据。
8. **操作反馈**：成功 / 失败用 `toast.success() / toast.error()`（`src/ui.ts`）；危险或不可撤销的操作用 `await confirmDialog({ title, message, confirmText, danger })` 代替浏览器的 `confirm()`；不要用 `alert()`。
9. **键盘可用**：可点的东西是 `<button>` 或 `<a>`；弹窗 Esc 关闭；`:focus-visible` 有焦点环（全局已处理，不要 `outline: none` 后不补）。

## 全局已有的东西（直接用，不要重复造）

### 样式类（`src/styles.css`）

| 类 | 用途 |
|---|---|
| `.page` / `.page.narrow` | 页面容器（最大宽 1280 / 880，居中） |
| `.page-head` > `h1` + `.sub` + `.actions` | 页头 |
| `.breadcrumb` | 面包屑 |
| `.card` | 白底卡片 |
| `button` / `.button` | 默认按钮，高 32；`.primary` 主按钮；`.ghost` 幽灵按钮；`.danger`；`.sm` 高 26；`.icon-btn` 方形图标按钮；`.link` 文字链接 |
| `.segmented` > `button(.active)` | 分段控件 |
| `input / select / textarea` | 高 32；`label.field` 竖排表单项；`.field-hint` |
| `.table-wrap` > `table` | 表格（行高 48，表头 36）；`td .row-actions` 行内操作（悬停才显眼） |
| `.tag`（`.gray .green .red .orange .yellow .purple`，加 `.dot` 带状态圆点） | 标签 |
| `.tabs` > `.tab(.active)` > `.count` | 筛选 tab |
| `.toolbar`、`.search-box` | 工具栏、搜索框（里面放 `<Search :size="15" />` + `<input>`） |
| `.popover` + `.menu-item` + `.menu-sep` | 下拉菜单 / 弹出面板（需要自己定位和点外面关闭） |
| `.empty`、`.skeleton`、`.truncate`、`.mono`、`.muted`、`.row`、`.spacer`、`kbd`、`pre.code`、`.notice`、`.error` | 其他 |

**注意**：全局 `button` 现在固定 `height: 32px`。把 `<button>` 当成多行块、卡片或列表行用的地方，必须在自己的样式里写 `height: auto`（并按需去掉 `box-shadow`、`border`）。

### 组件

- `components/Modal.vue`：`<Modal title width @close>`，默认插槽是内容，`#footer` 插槽放底部按钮（右对齐，取消在左、主操作在右）。
- `components/EmptyState.vue`：`<EmptyState :icon="Folder" title="…" hint="…"><button class="primary">…</button></EmptyState>`。
- `components/DesignCover.vue`：`<DesignCover :design-id :version class="…" />` 渲染设计稿第一个画板的真实缩略图（懒加载、带骨架和占位）。外层尺寸由调用方定，例如 `aspect-ratio: 16 / 10`。
- `components/Avatar.vue`：`<Avatar :name :size />`。
- `ui.ts`：`toast`、`confirmDialog`、`openClient()`（打开「上传客户端」弹窗）。
- `api.ts`：`api()`、`session`、`relativeTime`、`formatTime`、`formatBytes`、`ROLE_LABEL`、`STATUS_LABEL`、`STATUS_TAG`、`colorOf`。

### 外壳

`App.vue` 提供左侧导航、通知、⌘K 命令面板（全局搜索）、用户菜单。普通页面只渲染右侧内容区，根元素用 `.page`。设计稿查看页（`/designs/:id`）是沉浸式的：没有侧栏，页面自己占满 `100vh` 并带顶栏。

## 文案

- 中文界面，简短直接。按钮用动词（「新建项目」「吊销」），不加感叹号。
- 时间用 `relativeTime()`，悬停 `title` 给 `formatTime()` 的完整时间。
- 空状态说清楚「这里会有什么」和「下一步做什么」。
- 错误信息显示服务端给的 `message`（`ApiError.message`），不要吞掉。
