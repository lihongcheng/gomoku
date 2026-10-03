# 在线五子棋

在线五子棋应用：React / TypeScript 前端 + Python FastAPI / WebSocket 后端。支持邀请双人对战、只读观战、双方准备、悔棋审批、认输、断线恢复和房间回收。

- [前端启动、页面与 Pages 发布说明](frontend/README.md)
- [后端启动、协议与部署说明](backend/README.md)
- [设计方案](DESIGN.md)
- [Render 部署模板](render.yaml)
- [后端 CI 工作流](.github/workflows/backend.yml)

```bash
cd backend
uv sync --frozen --python 3.12
uv run --frozen python -m gomoku
```

服务地址 `http://localhost:8000`，接口文档 `/docs`。

另开终端，从 `gomoku` 目录运行：

```bash
cd frontend
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173/`，输入昵称创建房间，再把邀请链接发给好友。桌面和手机均先选交点，再确认落子。双方应使用独立设备或浏览器身份，同一浏览器标签页会互相接管。

本地已验证：后端 68 项测试，前端 19 项单元测试，Chrome / 手机 WebKit 共 8 个真实后端 E2E 场景。前端测试工作流和手动 Pages 发布工作流位于 `.github/workflows/`。

当前为单实例、单进程、内存存储，重启会清空房间与会话。线上部署、目标网络与长时间负载验收尚未完成。
