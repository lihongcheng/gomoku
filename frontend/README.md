# 对弈 · 五子棋前端

React + TypeScript + Vite，中文响应式页面，SVG 棋盘。支持创建与邀请、仅观战链接、准备、选点确认落子、实时棋谱、悔棋审批、认输、退出与关闭房间、断线恢复。桌面与手机统一使用“选点 → 确认落子”，避免误触；棋盘支持方向键选位和回车选择。

## 本地运行

要求 Node.js 22.12+，Python 后端按 [后端说明](../backend/README.md) 启动。两个终端分别运行：

```bash
# 终端一，从 gomoku 目录运行
cd backend
uv sync --frozen --python 3.12
uv run --frozen python -m gomoku
```

```bash
# 终端二，从 gomoku 目录运行
cd frontend
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173/`。默认 API 为 `http://localhost:8000`，不需要创建 `.env`。如需覆盖，复制 `.env.example` 为 `.env.local`，修改后重启 Vite：

```dotenv
VITE_API_ORIGIN=http://localhost:8000
VITE_BASE_PATH=/
```

`VITE_API_ORIGIN` 必须为完整 HTTP(S) Origin，不带末尾斜杠或路径。WebSocket 地址由它推导。改前端端口时，也需要把该 Origin 加入后端 `GOMOKU_ALLOWED_ORIGINS`。

与好友测试时，使用各自的设备或独立浏览器上下文。同一浏览器的普通标签页共享匿名身份，新标签页会接管旧标签页。同机可用一个普通窗口和一个隐私窗口测试两位玩家。

## 页面和状态

- 首页：输入昵称创建房间，或粘贴完整邀请链接。短房间号不能作为加入凭证。
- 新邀请：先确认加入，再建立成员关系；仅加载邀请页不占座。已有成员刷新自动恢复。
- 对局：服务端快照决定棋子、轮次、胜负和倒计时裁决；观战端没有控制按钮。
- 邀请弹窗：房主可复制对战和仅观战链接；访客只能转发自己持有的邀请。浏览器拒绝剪贴板时，可选中输入框手动复制。
- 悔棋：显示将撤销的棋子坐标、步数和答复倒计时。按钮的冷却提示只是辅助，最终由后端判定。
- 恢复：普通断线自动退避重连；进程换代、身份过期、房间关闭、标签页接管会停止旧操作，并给出中文提示。

匿名会话按 API Origin 使用 `gomoku:v1:<origin>:` 前缀保存在 `localStorage`，创建请求先保存幂等键和原始昵称。凭证存储失败时不创建房间。连接中断会丢弃未确认命令和所选交点；不会重放离线点击。

在线 ACK 超时会用原请求 ID、原版本与原内容重试。收到 ACK 后仍等待相应或更新快照，才开放下一次操作。`seq` 只前进，旧回执不能回滚棋盘。心跳每 20 秒发送；重连后先获取自己的角色和全量快照。

## 代码入口

| 文件                 | 用途                                 |
| -------------------- | ------------------------------------ |
| `src/App.tsx`        | 首页、加入确认、棋室、分享与确认弹窗 |
| `src/Board.tsx`      | SVG 棋盘、键盘和触摸选点             |
| `src/api.ts`         | REST、身份存储、创建幂等、邀请解析   |
| `src/client.ts`      | WebSocket、同步、ACK、重连、心跳     |
| `src/types.ts`       | 后端公开协议类型                     |
| `src/style.css`      | 桌面和移动布局                       |
| `tests/game.spec.ts` | 真实后端的多客户端端到端测试         |

## 验证

```bash
npm run format:check
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run test:preview
```

E2E 自动启动独立后端 `8001`，构建测试 API 版本，再用 `5173` 静态服务运行。请先关闭占用这两个端口的服务；不会复用线上后端。后端测试参数缩短悔棋答复和重连时间，并提高来源限流额度，均不改变默认产品规则。

E2E 会将 `dist` 构建为测试 API 版本。测试后如需 `npm run preview`，先重新执行 `npm run build`，生成当前本地或生产配置的产物。

本地若已安装 Chrome，可绕过 Chromium 下载运行：

```bash
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=mobile-webkit
```

2026-10-03 本地验证：前端 19 项单元测试；Chrome 和手机 WebKit 共 8 个对战 E2E 场景及 2 个独立展示模式场景通过，包含三端同步、只读不占座、满员观战、五连胜、悔棋同意／拒绝／超时、认输、离开、关闭房间、刷新重连、多标签接管、移动布局及 Pages 子路径。真实平台的网络、冷启动和长时间负载仍需上线环境验收。

## GitHub Pages

工作流假设 `gomoku/` 为独立 Git 仓库根目录；若仓库根是 `games/`，须将 `.github/workflows` 移到真正仓库根并调整所有工作目录、缓存和产物路径。

**后端未上线时**：将 Pages Source 设为 GitHub Actions，然后手动运行 **Publish frontend to Pages** 并选择 `preview`。此模式展示前端，明确提示“对战服务尚未开放”，禁止创建／加入房间，不发起 API 或 WebSocket 请求，也不会使用 localhost。接入后端后重新选择 `live` 发布即可。

**开放在线对战时**：

1. 部署 Python 后端，取得 HTTPS 域名。
2. 后端设置 `GOMOKU_FRONTEND_URL=https://用户名.github.io/仓库名/` 和 `GOMOKU_ALLOWED_ORIGINS=["https://用户名.github.io"]`。Origin 不带仓库路径。
3. 在 GitHub 仓库 Variables 中设置 `VITE_API_ORIGIN=https://实际后端域名`。
4. 仓库 Settings → Pages 的 Source 选择 GitHub Actions。
5. 在默认分支手动运行 **Publish frontend to Pages**，选择 `live`。工作流先验证前后端及两种浏览器，再按 Pages 实际路径重新生产构建并发布。

本地验证生产配置：

```bash
export VITE_API_ORIGIN=https://实际后端域名
export VITE_BASE_PATH=/gomoku/
export VITE_SITE_MODE=live
npm run build
npm run check:production
```

检查会确认 HTTPS API、资源路径、构建元数据一致，以及无 localhost 地址残留。`live` 模式缺少生产 API 时会拒绝发布；`preview` 模式要求 API 为空。`VITE_*` 为公开配置，不能放凭证。Hash 路由支持 Pages 子路径和房间页刷新，邀请 token 不随静态页面请求发往 Pages。

仅展示前端的产物可用 `VITE_SITE_MODE=preview VITE_API_ORIGIN= VITE_BASE_PATH=/gomoku/ npm run build` 构建，以相同环境变量运行 `npm run check:production` 检查。`npm run test:preview` 会在 Chrome 和手机 WebKit 中验证子路径、深链接刷新、按钮禁用和无后端请求。

CI 和 Pages 工作流已提供，尚未实际发布到 GitHub 或部署线上服务。
