# dsh-plugin-message-board（留言板）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的共享留言板插件。

当不止一个人共用同一个 DSH 实例时——同事连上你的机器、一台挂在隧道后面的共享服务器——
唯一的落脚点就是对话记录，而它并不适合：它是按会话隔离的、是线性的，而且往里面写东西
会让 agent 真的动起来。这个插件提供另一条安静的通道：留一条言，对方下次打开留言板
就能看到。

留言分三种范围：

| 范围 | 板子 | 适合放什么 |
|---|---|---|
| **全局** | 每个实例一块 | 「周五之前不要部署」「VM 正在重启」 |
| **项目** | 每个工作区目录一块 | 「构建已恢复」「别动 lockfile」 |
| **会话** | 每个会话一块 | 「这个会话里还没定的问题列在这儿」 |

每条留言都有署名和「已读」水位线，所以你能知道对方到底看没看到。

![留言板面板](docs/screenshot-light.png)

<sub>[English](README.md) | 中文</sub>

## 功能

- **三种范围** —— 全局、按项目、按会话，左侧一栏列出所有板子，所以在还没人留言之前
  也能先把板子开出来。
- **互相可见 + 已读回执** —— 每个读者各有自己的水位线；对方打开后，你留的言会显示
  `✓ 已读：…`，而对方留的言在你看到之前会高亮。
- **留言支持 Markdown** —— 标题、列表、引用、分隔线、行内代码与代码块、粗体、斜体、
  删除线、链接；渲染成 React 元素而非 HTML 字符串，所以留言无法注入标记。
- **从会话一键进入** —— 会话标题栏上有个留言板按钮，直接打开该会话的板子。
- **agent 也能读写** —— 注册了两个工具，留给 agent 的留言它是真能看到的。
- **零依赖、不用构建** —— 纯 JavaScript，只用 `node:` 内置模块，React 取自浏览器模块表。
  把目录拷过去就能跑。
- **复用 DSH 自身的浏览器会话** —— HTTP API 走的是守护 `/api` 的同一套信任检查与签名
  cookie，不需要再维护第二份凭据。
- **跟随主题与语言** —— 只用主题 token，明暗两套主题都正确；界面文字走 Client 的
  locale 服务（中文 / English）。

![暗色主题](docs/screenshot-dark.png)

## 留言写法

留言正文是 Markdown：

| 语法 | 效果 |
|---|---|
| `# 标题` … `###### 标题` | 标题，统一降两级，免得留言里的标题盖过页面本身 |
| `**粗体**`、`*斜体*`、`~~删除线~~` | 强调 |
| `` `代码` ``、```` ```语言 … ``` ```` | 行内代码与代码块 |
| `- 项`、`1. 项` | 无序 / 有序列表 |
| `> 引用` | 引用块 |
| `---` | 分隔线 |
| `[文字](https://…)`、裸 `https://…` | 链接 |
| 单个换行 | 换行，跟聊天框的习惯一致 |

几处刻意的取舍：

- **链接会校验协议。** 只有 `http:`、`https:`、`mailto:` 会变成链接；`javascript:`
  和 `data:` 原样显示成你打的字。
- **不渲染裸 HTML。** `<b>x</b>` 就显示 `<b>x</b>` —— 留言渲染成 React 元素，
  而不是 HTML 字符串。
- **下划线强调关掉了。** `_这样_` 不生效，`snake_case` 才能原样保留。斜体用 `*星号*`。
- **换行结构由服务端保住。** 留言正文保留 `\n` 和 `\t`，其余控制字符替换成空格；
  单行的板子标题会被压平。

## 安装

安装一个 bundle 包含两件事：包在 profile 里变得可解析，以及它的 patch 层被应用。

### 装进你正在用的 profile

在当前会话里让 agent 安装，指向这个目录：

```
plugin_manager install_bundle → /absolute/path/to/dsh-plugin-message-board
```

### 从命令行装进任意 profile

```bash
git clone https://github.com/Chicago01/dsh-plugin-message-board.git
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-message-board
```

因为 manifest 里声明了 `dsh.bundle.patch`，`dsh plugin add` 会一次性完成包的安装
并把 bundle 写进该 profile 的 `dsh.profile.bundles`。

### 然后要重启宿主

Host 半边是一个 Node 模块。**改完 `index.js` 只有重启 DSH 宿主进程才会生效** ——
刷新页面不行，`remove_bundle` / `install_bundle` 也不行，已经加载过的模块世代不会被
重新导入。Client 半边（`client.js`）是浏览器产物，随页面刷新就会更新。

## 配置

在你自己的 patch 层里覆盖这一行的 `config`。id 命中会替换**整个** config，
所以要用的字段都得重写一遍。

```yaml
- id: message-board
  name: 'dsh-plugin-message-board'
  config:
    identityHeader: x-gateway-user
    allowDelete: true
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `routePath` | `/dsh-message-board` | 注册在 `ctx.webServer` 上的前缀路由。存储时不含结尾斜杠——前缀路由匹配 `p` 和 `p/<任意>`，带结尾斜杠会匹配不到任何东西。`/` 会被拒绝。 |
| `dataFile` | `$DSH_HOME/message-board/board.json` | 留言库文件。首次写入时创建，原子写入。 |
| `identityHeader` | `""` | 可选：携带已认证用户名的请求头。见下。 |
| `allowDelete` | `true` | 作者可以删除自己的留言。 |
| `agentTools` | `true` | 注册 `message_board_read` / `message_board_post`。 |
| `agentAuthor` | `DSH Agent` | 工具留言时使用的署名。 |
| `maxMessagesPerBoard` | `2000` | 超过这个数量的旧留言会被丢弃。 |

### 共享实例上的身份

DSH 本身只有一个操作者，所以插件没法知道**是哪个**人在打字。它把名字存在面板右上角
一个小输入框里，按浏览器记在 `localStorage`。

如果你在 DSH 前面放了自己的认证代理——HTTP basic 网关、带 header 的 Cloudflare Access、
SSO 旁车——把 `identityHeader` 指向它设置的那个头，名字就变成权威的：

```yaml
- id: message-board
  name: 'dsh-plugin-message-board'
  config:
    identityHeader: x-gateway-user
```

该请求头优先于浏览器自称的名字，所以面板显示的是代理认证出来的身份，而不是浏览器
声称的身份。

## Agent 工具

每个会话都会注册这两个工具。

| 工具 | 作用 |
|---|---|
| `message_board_read` | 读取某个板子的留言。`scope` 为 `global` / `project` / `session`；`session` 默认取当前会话。 |
| `message_board_post` | 留言。范围同上；`label` 用于记录一个给人看的板子标题。 |

留在这个会话板子上的留言，正在该会话里工作的 agent 是能看到的：

```
> 在这个会话的留言板上留一条：那个不稳定的测试是重跑循环导致的

… message_board_post { scope: "session", text: "那个不稳定的测试是重跑循环导致的。" }
```

## HTTP API

Client 半边通过一条前缀路由与 Host 半边通信。所有响应都是 JSON，所有失败都用同一个
信封格式。

| 方法 | 路径 | Body / query |
|---|---|---|
| `GET` | `api/boards` | `?author=` → 所有板子的计数与已读水位线 |
| `GET` | `api/messages` | `?board=` → 某个板子的留言，最新在前 |
| `POST` | `api/post` | `{ board, text, author?, label? }` |
| `POST` | `api/read` | `{ board, author? }` → 推进该读者的水位线 |
| `POST` | `api/delete` | `{ id, author? }` → 仅作者本人 |

请求由 `ctx.connection.requestRejection(...)` 放行，也就是守护 DSH 自身 `/api` 的同一套
Host/Origin 信任检查和签名浏览器会话 cookie。不可信的 `Host` 得到 `403`，缺失或过期的
会话得到 `401`。

## 工作原理

```
ctx.webServer  ──前缀路由──▶  index.js   （Host 半边）
                                 │  board.json，原子写入
                                 ├─ ctx.connection.requestRejection  → 信任检查 + cookie
                                 └─ ctx.tools.register               → agent 工具

slots ──▶ client.js  （Client 半边：sidebar.panellist、main、会话标题栏）
             └─ fetch('/dsh-message-board/api/…', credentials: same-origin)
```

- Host 半边持有存储和 HTTP API。它通过 `ctx.webServer.tapIndex` 把挂载点写进页面，
  所以自定义 `routePath` 不需要再去改 `client.js`。
- Client 半边只注册三个 slot 贡献，不导入任何 Harness Client 包：React 取自浏览器模块
  表，与宿主共享的只有 `--dsw-alias-*` 主题 token。
- 画在 `--dsw-alias-brand-primary` 底色上的文字用 `--dsw-alias-bg-base` 作为前景色。
  在两套内置主题里这两个是互为反色的表面，所以主题翻转时配色依然可读。
- 写入通过进程内队列串行化，并以「写临时文件再改名」的方式落盘，崩到一半也不会留下
  写坏的板子。

### 数据格式

```json
{
  "version": 1,
  "boards": {
    "global": {
      "scope": "global", "target": "", "label": "",
      "createdAt": "2026-10-01T13:30:44.847Z",
      "readAt": { "Alice": "2026-10-01T14:09:44.847Z" }
    },
    "session:session-8f21c0": {
      "scope": "session", "target": "session-8f21c0",
      "label": "重构认证网关",
      "createdAt": "2026-10-01T13:54:44.847Z",
      "readAt": {}
    }
  },
  "messages": [
    {
      "id": "mb_demo_1", "board": "global", "scope": "global", "target": "",
      "author": "Alice", "text": "…", "createdAt": "2026-10-01T13:30:44.847Z"
    }
  ]
}
```

板子键的形态是 `global`、`project:<路径>` 或 `session:<会话 id>`。「未读」是算出来的
而不是存的：当某条留言的 `createdAt` 晚于该读者的水位线时，它对这个人就是未读。

## 安全

- **留言板不是保密信道。** 只要能带着有效浏览器会话访问 DSH 网页界面，就能访问它的
  API —— 也就是每个能用 agent 的人，而 agent 本来就能执行命令。不要把凭据写进留言。
- **API 的安全性等同于它外面的部署。** 在只监听回环的 DSH 上，那就是你这台机器；
  挂在隧道后面，那就是守护隧道的那一层。如果你把 DSH 直接暴露到网络上，留言板也跟着
  暴露。
- **`routePath` 必须保持独占。** 不要让别的插件用同一个前缀；webserver 遇到重复路由会
  抛错，导致加载失败。

## 开发

Host 半边有一套完全不需要 DSH 的契约测试。它替身了插件用到的两个服务，并从 DSH 源码
里抄来了它们的真实规则——路由匹配（前缀 `p` 匹配 `p` 和 `p/<任意>`）以及 Host/Origin
信任栅栏：

```bash
node --test test/host.test.mjs
```

要验证 Client 半边，把 bundle 装进任意 profile 后重启宿主。`client.js` 随页面刷新生效，
`index.js` 不会。

## 兼容性

基于 DSH `0.2.0-rc.2` 开发并验证。插件依赖 `ctx.webServer.register`（`prefix` 路由）、
`ctx.connection.requestRejection`、`ctx.tools.register`、`sidebar.panellist` / `main` /
`conversation.session.header.utilities` 三个 slot，以及 `--dsw-alias-*` 主题 token。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
