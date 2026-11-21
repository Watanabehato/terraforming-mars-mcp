# Terraforming Mars MCP

用官方 [terraforming-mars/terraforming-mars](https://github.com/terraforming-mars/terraforming-mars) 游戏服务器 + 一个独立的 Streamable HTTP MCP 服务，让 Bot 只通过 MCP 就能开局、读状态、提交合法操作，并让人类用浏览器观战。

游戏规则和官方服务端保持原样，没有 fork 或修改核心规则。上游锁定在 commit `fdc1cc5ffdff4ef12b00350734dd68e50a61aa2e`，使用其仓库自带的 Dockerfile 构建。开局调用官方 `POST /api/creategame`（`ApiCreateGame`，请求体为上游 `NewGameConfig`），之后只使用 `/api/player`、`/api/waitingfor` 和 `/player/input`。

```
Bot --Streamable HTTP MCP--> mcp:8765 --HTTP--> tm:8888 (官方服务)
                                                  |
                                          SQLite volume tm-db
```

## 端口

| 服务 | 端口 |
| --- | ---: |
| 官方 Terraforming Mars | **8888** |
| MCP Streamable HTTP | **8765** |

没有使用 8080。上游 Dockerfile 里的 `EXPOSE 8080` 只是镜像元数据；容器内通过 `PORT=8888` 启动，端口映射也是 `8888:8888`。

## 快速开始

```bash
cp .env.example .env
docker compose up -d --build
```

首次构建需要下载 Node 26 基础镜像、执行上游 `npm ci` 和构建，耗时较长。启动后：

```bash
curl http://localhost:8765/healthz
curl http://localhost:8888/api/games
```

- 人类入口：<http://localhost:8888/>
- MCP 入口：`http://localhost:8765/mcp`
- 如果设置了 `MCP_AUTH_TOKEN`，MCP 请求需要带上 `Authorization: Bearer <token>`。

### Docker Hub 镜像

本机 Docker 拉取 Docker Hub 慢时，可以使用镜像 `ssw29qyeeou949jadc.xuanyuan.run`：

```bash
./scripts/prepare-node-image.sh
```

它会把 `ssw29qyeeou949jadc.xuanyuan.run/library/node:26-alpine3.23` 拉下来并打上 `node:26-alpine3.23` 标签，这样上游未修改的 Dockerfile 会直接复用本地镜像。MCP 自己的 Dockerfile 已通过 `NODE_IMAGE` 默认使用该镜像；镜像不可用时在 `.env` 中改成：

```dotenv
NODE_IMAGE=node:26-alpine3.23
```

## 让 Bot 连上 MCP

MCP 使用 Streamable HTTP，不是 stdio。任意支持 Streamable HTTP 的 MCP 客户端都可以直接连：

```text
http://localhost:8765/mcp
```

例如 Claude Code：

```bash
claude mcp add --transport http tm http://localhost:8765/mcp
```

带鉴权时：

```bash
claude mcp add --transport http tm http://localhost:8765/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

## 一局 Bot 的完整流程

### 1. 创建对局

```json
{
  "name": "create_game",
  "arguments": {
    "players": [
      {"name": "Bot-A", "color": "red"},
      {"name": "Bot-B", "color": "green"}
    ],
    "expansions": {"corpera": true, "prelude": true},
    "board": "tharsis"
  }
}
```

返回：

```json
{
  "game_id": "g...",
  "spectator_id": "s...",
  "spectator_url": "http://localhost:8888/spectator?id=s...",
  "players": [
    {
      "name": "Bot-A",
      "color": "red",
      "player_id": "p...",
      "player_url": "http://localhost:8888/player?id=p..."
    }
  ]
}
```

`player_id` 是 Bot 的身份凭证。每个 Bot 只需要自己的 `player_id`，不要把自己的 `player_id` 发给其他 Bot。

支持的官方扩展（`expansions` 里传布尔值）：

`corpera`、`promo`、`venus`、`colonies`、`prelude`、`prelude2`、`turmoil`、`community`、`ares`、`moon`、`pathfinders`、`ceo`、`starwars`、`underworld`、`deltaProject`。

其他可选参数：`board`、`draft`、`initial_draft`、`prelude_draft`、`solo_tr`、`two_corps`、`fast_mode`、`starting_corporations`、`starting_preludes`、`starting_ceos`、`turmoil_agenda`。官方支持 1–6 个玩家。

### 2. 绑定 Bot 身份

```json
{
  "name": "configure_session",
  "arguments": {
    "player_id": "p...",
    "game_id": "g..."
  }
}
```

`tm_server_url` 和 `tm_public_url` 也可以在单个 MCP 会话里覆盖；默认来自环境变量。

### 3. 等待轮到自己

```json
{"name": "wait_for_turn", "arguments": {"timeout_ms": 60000, "poll_ms": 500}}
```

返回里的 `waiting_for` 是官方输入模型经过裁剪后的版本，只保留做决策需要的字段（选项、卡牌名与费用、地块、付款方式、数量范围等），不会把整份 UI model 倒出来。`request_id` 由 MCP 在提交时自动注入，不需要 Bot 自己处理。

### 4. 提交行动

按 `waiting_for.type` 选择工具：

| `waiting_for.type` | 工具 |
| --- | --- |
| `option` / `or` | `choose_option` |
| `amount` | `submit_amount` |
| `card` | `select_cards` |
| `projectCard` | `play_project_card` |
| `space` | `select_space` |
| `player` | `select_player` |
| `payment` | `submit_payment` |
| `initialCards` | `select_initial_cards` |
| `and`、`colony`、`party`、`delegate`、`productionToLose`、`aresGlobalParameters`、`globalEvent`、`resource`、`resources`、`claimedUndergroundToken`、`policy`、`deltaProject` | `submit_input` |
| 上游新增、尚未建模的类型 | `submit_raw_entity` |

例子：

```json
{"name": "choose_option", "arguments": {"index": 0}}
```

```json
{"name": "select_cards", "arguments": {"cards": ["Mine", "Power Plant"]}}
```

```json
{"name": "play_project_card",
 "arguments": {"card": "Mine", "payment": {"megacredits": 4}}}
```

```json
{"name": "submit_input",
 "arguments": {"response": {"type": "colony", "colonyName": "Europa"}}}
```

遇到嵌套的 `or` 选项（子输入不是普通 option）时，把子响应放进 `response`：

```json
{"name": "choose_option",
 "arguments": {"index": 2, "response": {"type": "amount", "amount": 3}}}
```

`submit_raw_entity` 用于规则升级后出现的新输入类型；它只要求对象带 `type`，其余原样交给官方服务端校验。

### 5. 读状态

- `get_game_state`：回合、时代、阶段、全局参数、自己的资源/产能、对手概要、当前 `waiting_for`。
- `get_mars_board_state`：地块、空格奖励、里程碑、奖项、殖民地、扩展状态。
- `get_my_hand_cards`：手牌与计算后的费用。
- `get_my_played_cards`：自己的已打出卡牌/公司。
- `get_opponents_played_cards`：对手公开的面板。

## 错误处理

官方服务端拒绝操作时，MCP 以 `isError: true` 返回错误，并保留官方响应原文，例如：

```text
Terraforming Mars rejected the request (HTTP 400). Raw server response: {"id":"INVALID_REQUEST_ID","message":"This page is out of date. Click OK to refresh it."}
```

Bot 可以据此重新读状态、重试或调整行动。

## 观战

`create_game` 会直接返回：

- 玩家页：`http://localhost:8888/player?id=<player_id>`
- 观战页：`http://localhost:8888/spectator?id=<spectator_id>`

浏览器打开即可看到官方前端和实时局面。

## 最小 e2e

```bash
docker compose exec mcp npm run e2e
```

它会：

1. 通过 MCP 创建一局单人基础游戏；
2. `configure_session` 绑定玩家；
3. `wait_for_turn` 等到初始选择；
4. 通过 MCP 选公司、跳过买牌；
5. 通过 MCP `choose_option` 过牌；
6. 等待并确认进入下一时代；
7. 检查官方的 `/player` 与 `/spectator` 页面返回 200。

成功时输出 `ok: true`。e2e 只调用 MCP 工具，不直接操作官方 HTTP 输入接口。

也可以从宿主机运行：

```bash
E2E_MCP_URL=http://localhost:8765/mcp TM_SERVER_URL=http://localhost:8888 npm run e2e
```

## 数据持久化

默认使用官方 SQLite 后端，数据目录挂载在 Docker volume `tm-db`（容器内 `/usr/src/app/db`）。

```bash
docker compose down -v
```

会清空所有对局数据。需要 Postgres 时，按上游官方文档设置 `POSTGRES_HOST` 等环境变量，并相应调整 compose。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TM_PORT` | `8888` | 官方服务映射到宿主机的端口 |
| `TM_PUBLIC_URL` | `http://localhost:8888` | 返回给人类浏览器的地址 |
| `MCP_PORT` | `8765` | MCP 监听端口 |
| `MCP_AUTH_TOKEN` | 空 | 设置后 MCP 要求 Bearer Token |
| `MIN_RESPONSE_INTERVAL_MS` | `250` | 官方服务端的最小响应间隔 + MCP 出站请求节流 |
| `TM_REQUEST_TIMEOUT_MS` | `30000` | MCP 调用官方服务的超时 |
| `NODE_IMAGE` | 镜像地址 | MCP 构建用的 Node 26 镜像 |
| `TM_BUILD_CONTEXT` | 上游 git 地址（锁定 commit） | 可改成 `./upstream` 使用本地 checkout |

## 构建细节

- 官方服务：直接构建上游仓库的 Dockerfile，没有改游戏规则；上游要求 Node 26。
- MCP 服务：TypeScript + `@modelcontextprotocol/sdk`，使用 `StreamableHTTPServerTransport`，每个 MCP 会话独立绑定 `TM_SERVER_URL` 和 `player_id`。
- 所有对官方的读写在 MCP 内做全局节流，避免多个 Bot 同时轮询打爆服务器。
- `MIN_RESPONSE_INTERVAL_MS` 同时传给官方服务（上游原生的快速响应保护）和 MCP 的节流器。

如果要在本地使用上游源码而不是 git 构建：

```bash
git clone https://gh-proxy.com/https://github.com/terraforming-mars/terraforming-mars.git upstream
# 在 .env 中设置：
# TM_BUILD_CONTEXT=./upstream
```

## 许可证

本项目与上游一致，使用 **GPL-3.0**，见 [LICENSE](LICENSE)。
