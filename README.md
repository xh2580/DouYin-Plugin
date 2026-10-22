<div align="center">

# TRSS-Yunzai DouYin Plugin

TRSS-Yunzai 抖音适配器插件

基于 [douyin.ts](https://github.com/dmmdekkd/douyin.ts) SDK，支持抖音私聊 / 群聊消息收发与事件处理

</div>

## 🐬 安装教程

需要先准备 [TRSS-Yunzai](../../../Yunzai)

<details>
  <summary>展开/收起</summary>

#### 🔧 Yunzai 根目录执行命令安装

推荐使用 git 进行安装，以方便后续使用 `#抖音bot更新` 升级：

```bash
git clone --depth=1 https://github.com/dmmdekkd/DouYin-Plugin.git ./plugins/DouYin-Plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用代理加速下载服务
>
> ```bash
> git clone --depth=1 https://ghproxy.521002.xyz/https://github.com/dmmdekkd/DouYin-Plugin.git ./plugins/DouYin-Plugin
> ```

#### 🔧 安装依赖

```bash
pnpm install
```

</details>

## 使用教程

- `#抖音bot账号` 查看已登录账号
- `#抖音bot登录` 扫码登录新账号
- `#抖音bot删除uid` 删除账号并断开连接
- `#抖音bot更新` 更新插件（更新成功自动重启）
- `#抖音bot更新日志` 查看插件更新日志
- `#抖音bot状态` 查看账号在线状态与收发统计
- `#抖音bot重连[uid]` 重连指定或全部账号
- `#抖音bot帮助` 查看完整指令菜单

### 列表查询

- `#抖音bot好友列表[页码]` 好友列表（50/页，附抖音号）
- `#抖音bot群列表[页码]` 群列表（50/页）
- `#抖音bot群成员<群号>[页码]` 群成员列表（含群主/管理员标识）
- `#抖音bot群资料<群号>` 群资料（名称/成员数/群主）
- `#抖音bot查用户<uid|抖音号|昵称>` 用户信息（支持昵称模糊匹配）
- `#抖音bot找群<群名关键词>` 搜索群聊
- `#抖音bot头像<uid>` / `#抖音bot群头像<群号>` 查看头像
- `#抖音bot聊天记录<uid|群号>[条数]` 查看聊天记录（默认 10 条，上限 20）
- `#抖音bot陌生人` 查看陌生人会话

### 消息

- `#抖音bot发消息<uid><内容>` 给指定好友发消息
- `#抖音bot发群消息<群号><内容>` 给指定群发消息
- `#抖音bot发图片<uid><链接>` / `#抖音bot群发图片<群号><链接>` 发送图片
- `#抖音bot撤回<消息id>` 撤回已发送消息（发送后保留最近 200 条记录）
- `#抖音bot发送记录` 查看近期经指令发送的消息

### 申请管理

- `#抖音bot好友申请` / `#抖音bot入群申请[群号]` 查看待处理申请
- `#抖音bot同意好友<uid>` / `#抖音bot拒绝好友<uid>` 处理好友申请
- `#抖音bot同意入群<requestId>` / `#抖音bot拒绝入群<requestId>` 处理入群申请
- 配置 `bot.autoAcceptFriend` / `bot.autoAcceptGroup` 可开启自动同意（默认关闭）

### 群管理

- `#抖音bot改群名<群号><名称>` 修改群名（需群主/管理员）
- `#抖音bot踢人<群号><uid>` 移出成员
- `#抖音bot拉人<群号><uid,uid>` 邀请成员
- `#抖音bot退群<群号>确认` 退出群聊（需二次确认）

### 其他

- `#抖音bot拨打语音<uid>` 发起语音通话邀请
- `#抖音bot正在输入<uid>` 向对方展示输入状态

> 多账号场景下，除账号管理类指令外，查询 / 发送类指令默认使用消息来源账号，来源非本适配器（如终端）时回退第一个在线账号

## 配置说明

安装 [Guoba 插件](https://github.com/guoba-yunzai/guoba-plugin) 后，可在 Web 管理面板「插件配置」中图形化管理本插件配置

配置文件 `config/DouYin.yaml`：

- `permission` 指令权限，默认 `master`
- `bot.timeout` 请求超时时间（ms，默认 30000）
- `bot.autoRead` 收到消息后自动标记已读（对方可见已读回执）
- `bot.activeStatus` 上报在线状态（对方可见在线）
- `bot.forwardToImage` 合并转发渲染为图片发送（默认开启，关闭则走 SDK 原生 forward 卡片）
- `token` 账号列表，格式 `uid:cookie`

令牌变更后无需重启，适配器会定时检测配置变化自动连接新账号、断开删除的账号

## 账号安全与风控

### 登录双重验证（建议关闭）

抖音 App「设置 → 账号与安全 → 登录双重验证」开启后，新设备登录或异常登录会要求二次验证。机器人通过 Cookie 模拟登录，开启双重验证时容易触发风控拦截、登录后强制二次验证，导致掉线或消息收发异常。

**建议关闭双重验证**，保持 Cookie 登录稳定：

![抖音账号与安全-双重验证](docs/account-security.jpg)


### 抖音风控限制

可能出现消息仅回显到自身、对方看不到：

## 消息支持

- 收：文本、@、图片（原样透传）、视频（原样透传）、语音（降级文本提示）、文件（原样透传）、表情包、位置、链接/接龙/用户/群邀请等卡片（raw 透传）
- 发：文本、@、@全体成员、图片、视频、文件、表情、位置、raw 卡片透传；不支持的类型自动降级文本（如语音）
- 引用回复：5 分钟内触发消息自动引用，且可引用任意类型消息、回复内容不限于文本（图片 / 视频 / 文件等）；node 合并转发默认渲染为「聊天记录」图片发送（`bot.forwardToImage` 开启，关闭则映射 SDK forward 卡片一次组卡）；合并转发可嵌套，内层聊天记录会递归渲染为内嵌小卡片

> 协议限制：发送位置消息仅自身可见；群聊撤回无权限（对已发送消息生效，转发流程本身不再触发撤回）；关闭转图片后合并转发卡片按节点文本预览渲染，纯生成内容的节点无真实消息 id，点开详情可能无内容

## 事件支持

- message：私聊 / 群聊消息、消息编辑
- notice：消息撤回、表情回应、已读回执、输入状态、好友增减、群成员增减、群名/头像变更、群解散
- request：好友申请、入群申请（approve / reject）
- voip：语音 / 视频来电感知

## 其他框架集成

本插件面向 TRSS-Yunzai 运行时。若你希望在其他框架中使用抖音相关能力，可参考以下项目：

- [zhin-adapter-douyin](https://github.com/zhinjs/zhin-adapter-douyin)（Zhin 框架）
- [karin-plugin-adapter-douyin](https://github.com/dmmdekkd/karin-plugin-adapter-douyin)（Karin 框架）

## 相关链接

- 许可证：MIT（[LICENSE](LICENSE)）
- SDK：https://github.com/dmmdekkd/douyin.ts
- TRSS-Yunzai：https://github.com/TimeRainStarSky/Yunzai
