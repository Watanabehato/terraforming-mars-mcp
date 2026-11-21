# MCP 接口参考

本文是给 Bot 开发者看的完整接口文档：连接方式、会话模型、全部 MCP 工具的参数与返回、官方 `InputResponse` 的提交格式、错误处理与推荐主循环。部署与启动见 [README](../README.md)。

MCP 服务不保存游戏状态；对局数据始终在官方 Terraforming Mars 服务里。MCP 只负责身份绑定、读取精简后的状态、把行动转换成官方输入并提交。

## 1. 概览

| 项目 | 值 |
| --- | --- |
| 传输方式 | Streamable HTTP（有状态会话） |
| 默认地址 | `http://<host>:8765/mcp` |
| 响应格式 | JSON（`enableJsonResponse`） |
| 鉴权 | 可选 `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| 健康检查 | `GET /healthz` |
| 上游服务 | `TM_SERVER_URL`，默认 `http://localhost:8888` |
| 浏览器地址 | `TM_PUBLIC_URL`，用于返回玩家/观战链接 |

`/healthz` 返回示例：

```json
{
  "ok": true,
  "sessions": 2,
  "tm_server_url": "http://tm:8888",
  "tm_public_url": "https://battle.asyu9912.com",
  "mcp_endpoint": "/mcp"
}
```

## 2. 连接与会话

### 2.1 建立会话

MCP 是**有状态**的。客户端先发 `initialize`，服务端在响应头返回 `Mcp-Session-Id`；之后每个请求都带上这个头。会话里保存了当前 Bot 绑定的 `player_id`、`game_id` 和上游地址。

大多数 Bot 直接用 MCP SDK，不需要手写握手。Claude Code 示例：

```bash
claude mcp add --transport http tm http://116.140.210.127:8765/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

TypeScript SDK 示例：

```ts
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://116.140.210.127:8765/mcp'),
  {requestInit: {headers: {Authorization: `Bearer ${token}`}}},
);
const client = new Client({name: 'tm-bot', version: '1.0.0'});
await client.connect(transport);

const result = await client.callTool({
  name: 'configure_session',
  arguments: {player_id: 'p...'},
});
```

### 2.2 原始 HTTP 握手

排障或非 SDK 客户端可以直接调。先初始化：

```bash
curl -i -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bot","version":"1.0"}}}'
```

从响应头拿到 `Mcp-Session-Id`，然后发送初始化完成通知、列出工具或调用工具：

```bash
curl -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <session-id>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

```bash
curl -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

```bash
curl -X POST http://localhost:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_game_state","arguments":{}}}'
```

工具结果统一是：

```json
{
  "content": [{"type": "text", "text": "{...JSON...}"}],
  "isError": false
}
```

出错时 `isError` 为 `true`，`text` 里是错误原文（见第 8 节）。

### 2.3 会话生命周期

- **一个 Bot 一个会话。** `player_id` 绑定在会话上；两个 Bot 共用一个会话会互相覆盖身份。
- **会话在服务进程内存里。** MCP 容器重启后旧会话失效，客户端会收到 404，重新 `initialize` 并再次调用 `configure_session` 即可；对局本身不会丢。
- **主动结束**：`DELETE /mcp` 并带上 `Mcp-Session-Id`。
- **无会话 ID 的普通请求**会返回 400；未知或过期会话返回 404。两种情况都需要重新初始化，不要复用旧会话 ID。

MCP 的 HTTP 错误使用 JSON-RPC 形式：

```json
{"jsonrpc": "2.0", "error": {"code": -32001, "message": "Unauthorized"}, "id": null}
```

## 3. 开局与绑定

Bot 有两种入局方式，选一种即可。

### 3.1 方式 A：Bot 自己开房

调用 `create_game`，拿到所有席位的 `player_id`，每个 Bot 用自己那个绑定。适合全 Bot 对局或自动化测试。

### 3.2 方式 B：人类房主开房，Bot 凭链接加入

1. 房主在浏览器打开 `/new-game`，选择 2 人以上，填好每个玩家（包括 Bot）的名字和颜色，创建对局。
2. 创建后停在 Game Home 页面，每个玩家一行，右侧有 **copy** 按钮。
3. 复制 **Bot 那一行**的链接，例如 `https://battle.asyu9912.com/player?id=pb906f629f204`，发给对应 Bot。
4. Bot 从链接取 `id` 参数：

```js
const playerId = new URL(playerUrl).searchParams.get('id'); // "pb906f629f204"
```

5. Bot 调用：

```json
{
  "name": "configure_session",
  "arguments": {"player_id": "pb906f629f204"}
}
```

`game_id` 可选，只用于回显；需要的话从 Game Home 的 `game?id=g...` 里取。

房主点击自己的名字进入自己的玩家页面正常游玩。官方对局的所有席位在开局时已确定，不能中途加人；几个 Bot 就复制几条不同的玩家链接。

> `player?id=...` 是席位凭证，谁拿到谁就能操作这个玩家。不要把自己的链接发给 Bot，也不要把同一个链接发给多个 Bot。

## 4. 工具参考

共 18 个工具：2 个会话/开局工具、6 个读取工具、10 个行动工具。

### 4.1 `configure_session`

绑定或更新当前 MCP 会话。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `player_id` | string，可选 | 要绑定/切换到的玩家席位 |
| `game_id` | string，可选 | 记录对局 ID，仅用于回显 |
| `tm_server_url` | string，可选 | 覆盖本会话访问的官方服务地址 |
| `tm_public_url` | string，可选 | 覆盖返回给浏览器的公开地址 |

返回示例：

```json
{
  "ok": true,
  "tm_server_url": "http://tm:8888",
  "tm_public_url": "https://battle.asyu9912.com",
  "player_id": "pb906f629f204",
  "game_id": null,
  "player": {
    "name": "Bot-A",
    "color": "red",
    "game_name": "My Game",
    "generation": 1,
    "phase": "initial",
    "player_url": "https://battle.asyu9912.com/player?id=pb906f629f204",
    "spectator_url": "https://battle.asyu9912.com/spectator?id=s..."
  },
  "hint": "Use wait_for_turn to wait for this player's next input."
}
```

绑定成功会立即读取一次官方玩家模型；`player_id` 无效时直接返回官方错误。

### 4.2 `create_game`

通过官方 `POST /api/creategame` 创建对局。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `players` | array，1–6 项 | 必填 | 每项 `{name, color?, beginner?, handicap?}` |
| `expansions` | object | 仅 `corpera: true` | 扩展开关，键见下 |
| `board` | string | `tharsis` | 地图名 |
| `draft` | boolean | `false` | 研究阶段轮抽 |
| `initial_draft` | boolean | `false` | 初始牌轮抽 |
| `prelude_draft` | boolean | `false` | 前奏轮抽 |
| `solo_tr` | boolean | `false` | 单人 TR 规则 |
| `two_corps` | boolean | `false` | 双公司变体 |
| `fast_mode` | boolean | `false` | 快速模式 |
| `starting_corporations` | int，1–4 | `2` | 初始公司候选数 |
| `starting_preludes` | int，0–4 | `2` | 初始前奏数 |
| `starting_ceos` | int，0–4 | `1` | 初始 CEO 候选数 |
| `turmoil_agenda` | `Standard` / `Random` / `Chairman` | `Standard` | 政治议程扩展模式 |

可用颜色：`red`、`green`、`yellow`、`blue`、`black`、`purple`、`orange`、`pink`、`turquoise`、`clear`。同一局颜色不能重复；不传则按顺序自动分配。

可用地图：`tharsis`、`hellas`、`elysium`、`utopia planitia`、`vastitas borealis nova`、`terra cimmeria nova`、`amazonis planitia`、`arabia terra`、`vastitas borealis`、`amazonis p.`、`t. cimmeria`、`Hollandia`。

可用扩展键：`corpera`、`promo`、`venus`、`colonies`、`prelude`、`prelude2`、`turmoil`、`community`、`ares`、`moon`、`pathfinders`、`ceo`、`starwars`、`underworld`、`deltaProject`。

调用示例：

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

返回示例：

```json
{
  "ok": true,
  "game_id": "g...",
  "game_name": "Bot-A vs Bot-B",
  "active_player": "red",
  "phase": "initial",
  "expansions": ["corpera", "prelude"],
  "spectator_id": "s...",
  "spectator_url": "https://battle.asyu9912.com/spectator?id=s...",
  "players": [
    {
      "name": "Bot-A",
      "color": "red",
      "player_id": "p...",
      "player_url": "https://battle.asyu9912.com/player?id=p..."
    }
  ],
  "hint": "Each bot calls configure_session with its own player_id, then wait_for_turn."
}
```

API 创建的对局没有 Discord 用户绑定，玩家页和观战页凭 ID 直接可看，不需要登录。

## 5. 读取工具

需要已绑定 `player_id`，否则返回 `No player is bound to this MCP session...`。

### 5.1 `get_game_state`

一次返回当前玩家视角的精简局面。

```json
{
  "game_id": "g...",
  "player_id": "p...",
  "color": "red",
  "name": "Bot-A",
  "player_url": "https://battle.asyu9912.com/player?id=p...",
  "spectator_url": "https://battle.asyu9912.com/spectator?id=s...",
  "game": {
    "name": "My Game",
    "generation": 3,
    "phase": "action",
    "step": 0,
    "game_age": 9,
    "undo_count": 0,
    "active_player": "red",
    "passed_players": [],
    "globals": {"temperature": -24, "oxygen": 1, "oceans": 1, "venus": 0},
    "is_terraformed": false,
    "is_solo_win": false,
    "expansions": ["corpera", "prelude"],
    "deck": {"project_draw": 48, "project_discard": 3},
    "spectator_id": "s..."
  },
  "you": {
    "name": "Bot-A",
    "color": "red",
    "terraform_rating": 22,
    "resources": {"megacredits": 18, "steel": 2, "titanium": 1, "plants": 3, "energy": 1, "heat": 4},
    "production": {"megacredits": 2, "steel": 1, "titanium": 0, "plants": 0, "energy": 1, "heat": 1},
    "cards_in_hand": 7,
    "played_cards": 2,
    "is_active": true,
    "cities": 0,
    "colonies": 0,
    "fleet": 0,
    "influence": 0,
    "tags": {"building": 2, "space": 1},
    "victory_points": 22,
    "actions_taken_this_generation": ["projectCard"],
    "available_blue_card_actions": 1
  },
  "opponents": [
    {
      "name": "Bot-B",
      "color": "green",
      "terraform_rating": 20,
      "resources": {"megacredits": 12, "steel": 0, "titanium": 0, "plants": 2, "energy": 0, "heat": 0},
      "production": {"megacredits": 1, "steel": 0, "titanium": 0, "plants": 1, "energy": 0, "heat": 0},
      "cards_in_hand": 7,
      "played_cards": 1
    }
  ],
  "hand_count": 7,
  "request_id": "...",
  "waiting_for": null,
  "hint": "No input is currently requested. Use wait_for_turn."
}
```

- `game.phase`：`initial`、`action`、`production`、`research`、`drafting`、`end` 等官方阶段。
- `game.globals`：温度、氧、海洋、金星。
- 对局结束时 `game` 里会追加 `milestones` 和 `awards`。
- `you` 比对手多两个字段：本代已执行行动和可用蓝卡行动数。
- `request_id` 只用于排查；提交时 MCP 会自动注入最新的值。

### 5.2 `wait_for_turn`

长轮询官方 `/api/waitingfor`，直到轮到当前玩家输入。这是 Bot 主循环的入口。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `timeout_ms` | int，0–300000 | `60000` | 本次等待上限 |
| `poll_ms` | int，100–5000 | `500` | 服务端轮询间隔 |

轮到自己时：

```json
{
  "ready": true,
  "waited_ms": 1840,
  "player_id": "p...",
  "request_id": "...",
  "waiting_for": {
    "type": "or",
    "title": "Take your first action",
    "button_label": "Take action",
    "options": [
      {"type": "option", "title": "Play project card"},
      {"type": "option", "title": "Pass"}
    ]
  },
  "game": {"generation": 3, "phase": "action"}
}
```

超时：

```json
{
  "ready": false,
  "ended": false,
  "waited_ms": 60000,
  "result": "WAIT",
  "waiting_for_players": ["green"],
  "game": {"generation": 3, "phase": "action"},
  "hint": "Timed out. Call wait_for_turn again to continue waiting."
}
```

对局结束：

```json
{
  "ready": false,
  "ended": true,
  "waited_ms": 120,
  "game": {"generation": 14, "phase": "end"},
  "hint": "The game has ended."
}
```

处理规则：

- `ready === false && ended === false`：没轮到你或暂时没输入，再次调用即可。
- `ready === false && ended === true`：对局结束，停止行动。
- `waiting_for.optional === true` 表示该输入被官方标记为可选；仍按 `waiting_for` 正常回应（选项里通常有 Skip/No），不确定时先用 `get_game_state` 查看。

### 5.3 `waiting_for` 精简模型

`waiting_for` 是官方输入模型裁剪后的结果，只保留做决策需要的字段。所有类型都可能带 `type`、`title`、`button_label`、`optional`、`warning`。

| `waiting_for.type` | 额外字段 |
| --- | --- |
| `or` / `and` / `initialCards` | `options[]`（每项也是精简输入模型）；`initial_index`（部分 `or` 的默认选项） |
| `option` | 无，直接确认 |
| `card` | `min`、`max`、`cards[]`（`{name, cost?, resources?, disabled?}`） |
| `projectCard` | `cards[]`、`payment_options[]`、`card_resources` |
| `payment` | `amount`、`payment_options[]`、`reserve_units`、`card_resources` |
| `player` / `delegate` | `players[]`（玩家颜色） |
| `space` | `spaces[]`（地块 ID） |
| `amount` | `min`、`max`、`max_by_default` |
| `colony` | `colonies[]`（`name`、`is_active`、`track_position`、`colonies`） |
| `party` | `parties[]` |
| `productionToLose` | `pay_production` |
| `aresGlobalParameters` | `ares_data` |
| `globalEvent` | `global_events[]` |
| `resource` | `include[]`（可选资源） |
| `resources` | `count` |
| `claimedUndergroundToken` | `min`、`max`、`tokens` |
| `deltaProject` | `valid_steps` |
| 未建模的新类型 | `raw`（原始输入模型） |

卡牌一律用 `name` 指代；`cost` 是服务器算好的实际费用，`disabled` 表示当前不可选。地块用 `spaces[]` 里的 ID，玩家用颜色字符串。

### 5.4 `get_mars_board_state`

返回棋盘和全局扩展状态：

```json
{
  "generation": 3,
  "phase": "action",
  "active_player": "red",
  "passed_players": [],
  "globals": {"temperature": -24, "oxygen": 1, "oceans": 1, "venus": 0},
  "spaces": [
    {"id": "03", "space_type": "land", "bonus": ["steel"]},
    {"id": "04", "space_type": "land", "tile": "city", "owner": "green"}
  ],
  "milestones": [{"name": "Terraformer", "claimed_by": null, "color": null}],
  "awards": [{"name": "Landlord", "funded_by": null, "color": null}],
  "colonies": [],
  "turmoil": null,
  "moon": null,
  "pathfinders": null,
  "ares": null,
  "deck": {"project_draw": 48, "project_discard": 3, "other": {}}
}
```

`spaces` 是整张地图的完整枚举，每格包含 `id`、`space_type`，已放置的格子还带 `tile` 和 `owner`，有奖励的带 `bonus`。上面的示例只截取了两个格子。实际选地块时以 `waiting_for.spaces` 为准，它只包含当前合法的位置。

### 5.5 `get_my_hand_cards`

```json
{
  "count": 2,
  "cards": [
    {"name": "Mine", "cost": 4},
    {"name": "Power Plant", "cost": 4, "disabled": true}
  ]
}
```

### 5.6 `get_my_played_cards`

```json
{
  "count": 2,
  "cards": [{"name": "Thorgate"}, {"name": "Sponsors"}],
  "self_replicating_robots": []
}
```

### 5.7 `get_opponents_played_cards`

```json
{
  "opponents": [
    {
      "player": "Bot-B",
      "color": "green",
      "count": 3,
      "cards": [{"name": "Mine"}, {"name": "Asteroid Mining"}]
    }
  ]
}
```

## 6. 行动工具

### 6.1 通用提交结果

所有行动工具成功时返回同一结构：

```json
{
  "ok": true,
  "player_id": "p...",
  "request_id": "...",
  "game": {"generation": 3, "phase": "action"},
  "waiting_for": {"type": "payment", "amount": 4, "...": "..."},
  "hint": "Input accepted. The server still requests input from this player; inspect waiting_for and submit again."
}
```

- `waiting_for` 不为 `null`：服务器还要你继续输入（例如选牌后付款），按新模型再提交一次。
- `waiting_for` 为 `null`：本次行动完成，回到 `wait_for_turn`。
- 不要自己传 `requestId`；MCP 每次提交前都会读取最新的 `requestId` 并注入。`submit_raw_entity` 也一样。
- 所有对官方服务的请求在 MCP 进程内全局排队，并按 `MIN_RESPONSE_INTERVAL_MS` 限速；多个 Bot 同时行动也不会打爆服务器。

### 6.2 行动工具一览

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `choose_option` | `index?`、`response?` | 回答 `option` 或 `or` |
| `submit_amount` | `amount` | 回答 `amount` |
| `select_cards` | `cards[]` | 回答 `card` |
| `play_project_card` | `card`、`payment?` | 回答 `projectCard` |
| `select_space` | `space_id` | 回答 `space` |
| `select_player` | `player` | 回答 `player` |
| `submit_payment` | `payment` | 回答 `payment` |
| `select_initial_cards` | `responses[]` | 回答 `initialCards` |
| `submit_input` | `response` | 回答其余所有已建模类型 |
| `submit_raw_entity` | `entity` | 上游新增类型的逃生口 |

### 6.3 `choose_option`

- 当前输入是 `option`：调用时不需要 `index`，等价于确认。

```json
{"name": "choose_option", "arguments": {}}
```

- 当前输入是 `or`：`index` 是 `waiting_for.options` 的下标。子选项是普通 `option` 时可省略 `response`。

```json
{"name": "choose_option", "arguments": {"index": 2}}
```

- 子选项不是普通 `option`（例如选完项目卡后还要付款），把子响应放进 `response`：

```json
{
  "name": "choose_option",
  "arguments": {
    "index": 2,
    "response": {"type": "payment", "payment": {"megacredits": 4}}
  }
}
```

### 6.4 `submit_amount`

```json
{"name": "submit_amount", "arguments": {"amount": 3}}
```

### 6.5 `select_cards`

`cards` 用 `waiting_for.cards[].name` 的精确名称，数量必须在 `min`/`max` 之间。

```json
{"name": "select_cards", "arguments": {"cards": ["Mine", "Power Plant"]}}
```

跳过多选卡时传空数组：`{"cards": []}`。

### 6.6 `play_project_card`

```json
{
  "name": "play_project_card",
  "arguments": {
    "card": "Mine",
    "payment": {"megacredits": 4}
  }
}
```

`payment` 可省略，缺省全部资源为 0；免费卡或不关心最优付款时可以直接打。可用付款键：`megacredits`、`steel`、`titanium`、`heat`、`plants`、`microbes`、`floaters`、`lunaArchivesScience`、`spireScience`、`seeds`、`auroraiData`、`graphene`、`kuiperAsteroids`。

### 6.7 `select_space`

```json
{"name": "select_space", "arguments": {"space_id": "03"}}
```

地块 ID 必须来自当前 `waiting_for.spaces`。

### 6.8 `select_player`

```json
{"name": "select_player", "arguments": {"player": "green"}}
```

### 6.9 `submit_payment`

```json
{
  "name": "submit_payment",
  "arguments": {"payment": {"steel": 2, "megacredits": 0}}
}
```

未传的资源键自动补 0。付款是否合法、钢材/钛能否用于该卡，由官方服务端判定。

### 6.10 `select_initial_cards`

`responses` 必须与 `waiting_for.options` 一一对应，顺序不能变。每个子响应都是针对该选项的输入响应；官方初始选择里每个选项都是 `card` 类型。

基础游戏（公司 + 起始项目卡，两个选项）：

```json
{
  "name": "select_initial_cards",
  "arguments": {
    "responses": [
      {"type": "card", "cards": ["Thorgate"]},
      {"type": "card", "cards": ["Mine", "Power Plant"]}
    ]
  }
}
```

带前奏和 CEO 时是四个选项（公司、2 张前奏、CEO、起始项目卡），顺序以 `waiting_for.options` 为准：

```json
{
  "responses": [
    {"type": "card", "cards": ["Thorgate"]},
    {"type": "card", "cards": ["Business Empire", "Research Network"]},
    {"type": "card", "cards": ["Carson"]},
    {"type": "card", "cards": ["Mine"]}
  ]
}
```

不买起始项目卡就传空数组 `{"type": "card", "cards": []}`。买牌超出公司起始资金会被官方拒绝，错误原文会返回给 Bot。

### 6.11 `submit_input`

回答所有已建模的官方输入类型，也可以处理嵌套响应：

```json
{"name": "submit_input", "arguments": {"response": {"type": "colony", "colonyName": "Europa"}}}
```

```json
{"name": "submit_input", "arguments": {"response": {"type": "productionToLose", "units": {"megacredits": 1}}}}
```

`productionToLose` 的 `units` 用**非负整数**表示要失去的产能步数，各键之和必须等于 `waiting_for.pay_production.cost`；官方内部会把它当作扣减处理，不要传负数。

支持的完整类型与格式见第 7 节。

### 6.12 `submit_raw_entity`

给上游升级后新增、MCP 尚未建模的类型用。只要求对象带非空 `type`，其余字段原样透传，官方服务端负责校验：

```json
{
  "name": "submit_raw_entity",
  "arguments": {
    "entity": {"type": "someNewInputType", "foo": 1}
  }
}
```

`requestId` 仍会自动注入。能用 `submit_input` 时优先用它，因为 MCP 会先做格式校验，错误更早也更清楚。

## 7. 官方 `InputResponse` 速查

`submit_input`、`select_initial_cards` 和嵌套 `or` 的 `response` 都使用这些结构。字段名是官方要求的大小写，不要改写。

| `type` | 含义 | 示例 |
| --- | --- | --- |
| `option` | 确认一个选项 | `{"type":"option"}` |
| `or` | 选择一个子输入 | `{"type":"or","index":2,"response":{"type":"option"}}` |
| `and` / `initialCards` | 按顺序回答多个子输入 | `{"type":"and","responses":[{"type":"option"}]}` |
| `card` | 选牌 | `{"type":"card","cards":["Mine","Power Plant"]}` |
| `projectCard` | 打项目卡并付款 | `{"type":"projectCard","card":"Mine","payment":{"megacredits":4}}` |
| `space` | 选地块 | `{"type":"space","spaceId":"03"}` |
| `player` | 选玩家（颜色） | `{"type":"player","player":"green"}` |
| `party` | 选政党 | `{"type":"party","partyName":"Mars First"}` |
| `delegate` | 选代表目标（颜色） | `{"type":"delegate","player":"red"}` |
| `amount` | 选数量 | `{"type":"amount","amount":3}` |
| `colony` | 选殖民地 | `{"type":"colony","colonyName":"Europa"}` |
| `payment` | 付款 | `{"type":"payment","payment":{"megacredits":4,"steel":2}}` |
| `productionToLose` | 失去产能（非负步数） | `{"type":"productionToLose","units":{"megacredits":1}}` |
| `aresGlobalParameters` | Ares 全局参数选择 | `{"type":"aresGlobalParameters","response":{...}}` |
| `globalEvent` | 选全球事件 | `{"type":"globalEvent","globalEventName":"..."}` |
| `policy` | 选政策 | `{"type":"policy","policyId":"..."}` |
| `resource` | 选一种资源 | `{"type":"resource","resource":"plants"}` |
| `resources` | 选多种资源数量 | `{"type":"resources","units":{"plants":2,"heat":1}}` |
| `claimedUndergroundToken` | 选地下标记（下标数组） | `{"type":"claimedUndergroundToken","selected":[0,2]}` |
| `deltaProject` | Delta Project 数值 | `{"type":"deltaProject","amount":2}` |

说明：

- `payment` 可用键与 `play_project_card` 相同；`productionToLose` / `resources` 的 `units` 可用键是 `megacredits`、`steel`、`titanium`、`plants`、`energy`、`heat`。
- `aresGlobalParameters.response` 是官方对象，按当前 `waiting_for.ares_data` 的结构原样传入。
- 未列出的新类型用 `submit_raw_entity`。
- 嵌套 `or` 的 `response` 递归使用本表结构。

## 8. 错误处理

官方服务拒绝操作时，工具返回 `isError: true`，文本里保留官方响应原文：

```text
Terraforming Mars rejected the request (HTTP 400). Raw server response: {"id":"INVALID_REQUEST_ID","message":"This page is out of date. Click OK to refresh it."}
```

常见错误与处理：

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `No player is bound to this MCP session` | 会话还没绑定席位 | 调用 `configure_session` |
| `The server is not waiting for input from this player` | 当前不该你行动 | 调用 `get_game_state` 或 `wait_for_turn` |
| `INVALID_REQUEST_ID` | 状态已过期（页面/模型太旧） | 重新读状态后基于新的 `waiting_for` 再提交 |
| 其他 HTTP 400 原文 | 行动本身不合法 | 读原文，调整参数或换行动；不要原样重试 |
| `Cannot reach Terraforming Mars server` | MCP 连不上官方服务 | 检查上游容器和 `TM_SERVER_URL` |
| MCP HTTP 401 | Token 错误 | 检查 `Authorization: Bearer ...` |
| MCP HTTP 404 | 会话不存在或 MCP 重启过 | 重新 `initialize` 并 `configure_session` |

原则：**提交失败后先重读，再重试**。被拒绝的输入不会消耗回合，但牌、地块、可选选项可能因为其他玩家行动、撤销或时代推进而变化，旧模型里的名字不一定还合法。

## 9. 推荐的 Bot 主循环

```text
client.connect(mcpUrl)
configure_session({player_id})

loop:
  turn = wait_for_turn({timeout_ms: 60000})
  if turn.ended: break
  if not turn.ready: continue

  w = turn.waiting_for
  if w is null: continue

  switch w.type:
    option          -> choose_option({})
    or              -> 选 index；子类型非 option 时在 response 里递归构造
    amount          -> submit_amount({amount})
    card            -> select_cards({cards})
    projectCard     -> play_project_card({card, payment})
    space           -> select_space({space_id})
    player          -> select_player({player})
    payment         -> submit_payment({payment})
    initialCards    -> select_initial_cards({responses})
    其他已建模类型  -> submit_input({response})
    未建模类型      -> submit_raw_entity({entity})

  result = 上一步的返回
  if result.waiting_for is not null:
      继续按 result.waiting_for 提交，直到为 null
```

实现建议：

- `wait_for_turn` 超时是正常分支，不要当错误；继续调用即可。
- 一次只提交一个输入；不要在同一个会话里并行提交多个行动。
- 多步行动（选牌 → 付款 → 选地块）按返回的 `waiting_for` 逐步走完，中途不要重新 `wait_for_turn`。
- 每个 Bot 独立 MCP 会话、独立 `player_id`；Token 可以共享。
- 处理 `ended: true` 后可以调用 `get_game_state` 读取终局分数与里程碑/奖项。

## 10. 限制与调参

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `MIN_RESPONSE_INTERVAL_MS` | `250` | MCP 全局出站节流；同时传给官方服务作为快速响应保护 |
| `TM_REQUEST_TIMEOUT_MS` | `30000` | 单次调用官方服务的超时 |
| `WAIT_DEFAULT_MS` | `60000` | `wait_for_turn` 默认超时 |
| `WAIT_POLL_MS` | `500` | `wait_for_turn` 默认轮询间隔 |
| `MCP_AUTH_TOKEN` | 空 | 设置后所有 `/mcp` 请求必须带 Bearer Token |

`MIN_RESPONSE_INTERVAL_MS` 是**整个 MCP 进程共享**的，不是每个会话一份。Bot 数量多时不要把它调得太小，否则只是让请求排队更久，还会触发官方的快速响应保护。

## 11. 观战与排障

- 玩家页：`<TM_PUBLIC_URL>/player?id=<player_id>`
- 观战页：`<TM_PUBLIC_URL>/spectator?id=<spectator_id>`
- MCP 健康检查：`GET /healthz`
- 服务信息：`GET /`

排查顺序：

1. `curl http://<mcp-host>:8765/healthz` 确认 MCP 活着，且 `tm_server_url` 指向正确的上游。
2. `curl http://<tm-host>:8888/api/games` 确认官方服务活着。
3. 用 `tools/list` 确认工具集合与本文一致。
4. `configure_session` 能返回玩家信息，说明 MCP 到官方服务的读链路正常。
5. 提交类错误以官方原文为准，MCP 不会改写规则错误。

## 12. 兼容性

- 上游锁定 commit `fdc1cc5ffdff4ef12b00350734dd68e50a61aa2e`，使用官方 `InputResponse` 类型。
- 上游新增输入类型时，先用 `submit_raw_entity` 过渡；确认结构后再加进 `src/inputResponses.ts`。
- 本项目与上游一致，使用 GPL-3.0。
