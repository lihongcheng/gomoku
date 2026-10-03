# 五子棋后端

FastAPI + 原生 WebSocket，Python 3.12+。已实现匿名身份、固定双人席位、邀请与只读观战、双方准备、落子判胜／平局、双方确认悔棋、认输、断线重连、房间关闭及回收。

采用单进程内存存储：**只能运行 1 个实例、1 个进程，重启后会话和房间全部失效。** 已有配套 [React 前端](../frontend/README.md)，当前服务部署在 Railway。

## 本地运行

在本目录执行（依赖使用 [uv](https://docs.astral.sh/uv/getting-started/installation/) 管理）：

```bash
uv sync --frozen --python 3.12
cp .env.example .env
uv run --frozen python -m gomoku
```

默认监听 `http://localhost:8000`，REST 文档位于 `/docs`，健康检查为 `/health`，WebSocket 入口为 `/ws`。已有 `.venv` 时也可直接执行：

```bash
.venv/bin/python -m gomoku
```

端口从进程环境 `PORT` 读取，例如 `PORT=8001 uv run --frozen python -m gomoku`。应用配置从当前目录 `.env` 或 `GOMOKU_*` 环境变量读取，环境变量优先。推荐入口固定单进程、限制 WebSocket 消息为 4 KiB、关闭压缩与访问 URL 日志。

## HTTP 接口

响应均为 JSON，敏感接口设置 `Cache-Control: no-store`。先建立会话并由客户端保存 token，再创建房间：

```bash
curl -X POST http://localhost:8000/sessions
```

```json
{
  "status": "ok",
  "protocolVersion": 1,
  "serverEpoch": "<本次进程标识>",
  "sessionToken": "<保存这个凭证>",
  "memberId": "<公开身份 ID>",
  "expiresAt": "<UTC 时间>"
}
```

将返回凭证填入 `TOKEN` 后创建房间：

```bash
TOKEN='<sessionToken>'
curl -X POST http://localhost:8000/rooms \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: create-001' \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"玩家一"}'
```

返回 `roomId`、`serverEpoch`、`protocolVersion`、`inviteToken`、`watchToken`、`inviteUrl`、`watchUrl`。两种链接基于 `GOMOKU_FRONTEND_URL` 生成；配套前端已支持此 Hash 路由，并以当前页面地址生成可分享链接。

同一身份与创建键、相同参数重试会返回原结果；同键不同参数返回 `REQUEST_ID_CONFLICT`，原房间关闭后返回 `ROOM_GONE`。创建键保留到会话过期，每会话最多 32 个；同一身份同时最多拥有 3 个未关闭房间。创建者固定为黑方，应在返回后 60 秒内连接 WebSocket。

`Idempotency-Key` 与 WebSocket `requestId` 只允许 1–80 位 ASCII 字母、数字、下划线、连字符（UUID 可用）。昵称 1–20 字符，不接受首尾空白、控制字符和无效 Unicode。昵称在入房后保持不变。

## WebSocket 接入

浏览器会自动携带 Origin。Python 等客户端需显式设置 `Origin: http://localhost:5173`；默认拒绝无 Origin 的 WebSocket。凭证只放首条消息，URL 不允许查询参数。

连接成功后 10 秒内发送：

```json
{
  "type": "room.join",
  "protocolVersion": 1,
  "roomId": "<roomId>",
  "sessionToken": "<该客户端自己的凭证>",
  "inviteToken": "<inviteToken 或 watchToken>",
  "nickname": "玩家二"
}
```

创建者和已有成员重连可省略 `inviteToken`。第三个及后续新身份自动成为观战者；只读 token 即使白方空缺也不会占座。每个浏览器身份独立申请 session，不能让两位玩家共用 token。

服务端先私发 `room.joined`：

```json
{
  "type": "room.joined",
  "protocolVersion": 1,
  "serverEpoch": "<进程标识>",
  "roomId": "<roomId>",
  "self": {
    "memberId": "<公开身份 ID>",
    "nickname": "玩家二",
    "role": "PLAYER",
    "color": "WHITE",
    "isOwner": false,
    "generation": 1
  }
}
```

随后发送完整的 `room.state`。`role` 为 `PLAYER` 或 `SPECTATOR`；观战者 `color` 为 `null`。公共快照包含玩家、在线观战人数、完整棋谱、当前回合、结果、待审批悔棋、UTC 期限、维护状态，不包含 token 或自己的私有角色信息。

每次操作使用独立 `requestId` 和最新快照的 `revision`：

```json
{
  "type": "game.ready",
  "requestId": "ready-001",
  "expectedRevision": 2,
  "payload": {
    "ready": true
  }
}
```

上面的版本仅为示例，须替换为真实快照值。两人均准备后，服务端原子进入 `PLAYING`，黑方先行。

| 消息 `type` | `payload` | 权限与行为 |
| --- | --- | --- |
| `game.ready` | `{"ready": true}` 或 `false` | 玩家，等待阶段准备／取消 |
| `move.play` | `{"row": 7, "col": 7}` | 当前回合玩家；坐标为 0–14 整数 |
| `undo.request` | `{}` | 玩家申请撤销自己最近一手及对手可能跟进的一手 |
| `undo.respond` | `{"undoId": "...", "accept": true}` | 对手同意；`false` 为拒绝 |
| `game.resign` | `{}` | 对局中的玩家认输 |
| `room.leave` | `{}` | 观战者退出；等待中的玩家退出关闭房间；对局中退出判负 |
| `room.close` | `{}` | 房主在等待／结束阶段关闭；对局中返回 `USE_RESIGN` |

成功回执示例：

```json
{
  "type": "command.ack",
  "requestId": "move-001",
  "command": "move.play",
  "revision": 5,
  "result": {
    "accepted": true
  }
}
```

错误示例：

```json
{
  "type": "error",
  "code": "STALE_REVISION",
  "message": "Synchronize the latest room state",
  "requestId": "move-001"
}
```

客户端还需遵守以下同步规则：

- 每 20 秒发送 `{"type":"heartbeat"}`，服务端返回 `heartbeat.ack`。应用心跳与 WebSocket ping/pong 不等价。
- 发送 `{"type":"room.sync"}` 获取快照；这两种消息无需 `requestId` 或 `expectedRevision`。
- 在同一进程与房间内，只应用更新 `seq` 的快照。ACK 的 `revision` 属于原操作，不能覆盖更新的状态。恢复连接先取得快照再开放交互。
- ACK 丢失时用原消息、原版本、原 ID 重试。成功和业务失败回执都缓存；若操作内容需要修改，使用新 ID。每成员最多缓存 256 个结果，最多 15 分钟。
- `STALE_REVISION` 后同步，下一次操作用新 ID；`UNDO_EXPIRED` 表示目标请求已结束。若悔棋刚到期且客户端携带旧版本，先返回 `STALE_REVISION` 与最新快照。
- 同一身份同一房间的新连接接管旧连接，旧连接收到 `SESSION_REPLACED` 后停止重试。普通断线按带抖动的退避重连；`ROOM_GONE`、无效凭证或进程换代时停止重试旧操作。
- 业务错误不会变成客户端决定的事实。胜负、倒计时裁决、席位及颜色以服务端快照为准。

主要错误码见 `gomoku/service.py`，消息模型见 `gomoku/protocol.py`。终局结果 `reason` 支持 `FIVE_IN_ROW`、`DRAW`、`RESIGNED`、`PLAYER_LEFT`、`DISCONNECT_TIMEOUT`、`ABANDONED`；中止和平局的 `winner` 均为 `null`。

## 期限和容量

所有期限通过单调时钟执行；每秒调度且每个房间命令前复核。到期顺序按原截止时间排序，同刻优先关闭，其次断线、闲置、悔棋。状态变化和消息入队位于房间锁内，网络发送由每个 socket 唯一 writer 在锁外完成。

| 规则 | 默认值 |
| --- | --- |
| 失联检测／检测后重连宽限 | 60 秒／另计 60 秒 |
| 悔棋答复／同一人申请间隔 | 30 秒／30 秒 |
| 未开局关闭／对局无落子或已批准悔棋则中止 | 10 分钟／15 分钟 |
| 终局保留／空房回收 | 10 分钟／5 分钟，空房先完成重连裁决 |
| 匿名会话闲置 TTL／观战恢复记录 | 24 小时／离线 5 分钟 |
| 每房观战人数／观战记录上限 | 20／100（包括短期离线成员） |
| 实例房间／已入房连接／未认证连接 | 50／200／40 |
| 现有玩家重连预留 | 总连接上限内预留最后 20 个 |
| 发送队列／发送超时 | 每连接 32 条／5 秒 |
| 消息与 HTTP 请求体大小 | 4 KiB；仅接收 JSON 文本消息 |
| 来源令牌桶 | 突发 60 次、每秒恢复 1 次；HTTP 创建和 WS 握手分别计数 |
| 身份操作令牌桶 | 突发 20 次、每秒恢复 5 次；创建、加入、房间命令分别计数 |
| 无效消息 | 累计 5 次非法结构、越权或限流等错误后关闭连接 |

会话、来源限流字典、幂等缓存都有容量上限和回收。完整配置见 `gomoku/config.py`，字段名加 `GOMOKU_` 前缀即为环境变量。来源限制以直接连接 IP 为准，推荐入口不信任客户端传入的代理头；反向代理下多个用户可能共享来源桶，部署后按实际入口与负载调整。

## 测试

```bash
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pytest -q
```

测试使用可控时钟验证截止边界，并在随机本地端口启动真实 Uvicorn，使用 HTTPX 和 WebSocket 客户端验证跨连接行为。包含 10 个房间、20 位玩家与 50 位观战者的短时广播一致性测试。

2026-10-03 已在公网完成 `/health`、Pages CORS、WSS、两名玩家与观战者、落子、悔棋、认输和房间关闭的短时验收；**尚未完成设计中的 30 分钟持续负载、跨地区网络指标和冷启动耗时统计**。

## Docker、Railway 与 Render

```bash
docker build -t gomoku-backend .
docker run --rm -p 8000:8000 --env-file .env gomoku-backend
```

当前 Railway 服务从 `lihongcheng/gomoku` 的 `backend/` 构建 Dockerfile，设置如下：

```text
PORT=8000
GOMOKU_FRONTEND_URL=https://lihongcheng.github.io/gomoku/
GOMOKU_ALLOWED_ORIGINS=["https://lihongcheng.github.io"]
```

健康检查为 `/health`，公网同时提供 HTTPS 与 WSS；保持 1 个副本并启用 Serverless。Railway 监听 `main` 的 `/backend/**` 变更，等待 GitHub Actions 全部成功后自动部署。每次部署都可能中断在局房间并清空内存状态。当前 Free 计划为 `$0/月` 并含 `$1/月` 资源额度，额度和平台策略可能变化，应以 [Railway 官方价格说明](https://docs.railway.com/pricing/plans) 为准。Serverless 服务空闲后会休眠，下一次请求可能经历冷启动或首次返回 502；任何伴随容器重建的唤醒、进程重启或重新部署都会清空内存房间。

当前未设置 `GOMOKU_ADMIN_TOKEN`，因此管理接口返回 404。如需受控排空发布，应先生成独立管理凭证并配置到 Railway，再使用下一节接口。

Render Blueprint 位于 `../render.yaml`，保留为备选方案；本次未使用，因为当前账号创建服务需要绑定支付卡。模板使用 Docker、1 个实例并关闭自动部署。它假设 `gomoku/` 是独立 Git 仓库根目录；如果将整个 `games/` 建为仓库，需将 Blueprint 的构建路径加上 `gomoku/`，并把工作流放到仓库根 `.github/workflows/` 后调整路径。

在 Render 填写：

```text
GOMOKU_FRONTEND_URL=https://username.github.io/gomoku/
GOMOKU_ALLOWED_ORIGINS=["https://username.github.io"]
```

Origin 不带仓库路径。Render 提供 HTTPS/WSS 与 `PORT`；健康检查为 `/health`。Render 模板尚未在平台执行。免费实例可能休眠、重启或冷启动，持久性与可用性边界见 [设计方案](../DESIGN.md)。

## 受控发布

可选 `GOMOKU_ADMIN_TOKEN` 启用管理接口；为空时接口返回 404。Render 模板会生成独立管理凭证，Railway 需手动生成并设置。调用：

```bash
curl -X POST https://your-backend.example/admin/drain \
  -H "Authorization: Bearer $GOMOKU_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

新建房间被拒绝，已有创建请求重试、重连与对局继续；所有房间快照广播 `maintenance: true`，健康状态变为 `draining`，管理响应提供 `openRooms`。若要先排空再发布，须临时关闭 Railway 自动部署，待房间自然结束并回收后手动发布，再重新启用；发送 `false` 可取消维护。进程意外重启和平台滚动切换不保证能够排空，进程重启后 `serverEpoch` 改变。

应用日志仅记录请求 ID、错误码和处理耗时，不输出会话凭证、请求正文或完整邀请 URL。管理凭证只保存在服务端／运维环境，不进入前端的 `VITE_*` 配置。
