import { config, configSave } from "../../index.js"

export const schemas = [
  {
    component: "Alert",
    componentProps: {
      type: "info",
      message: "保存后自动持久化到 config/DouYin.yaml，Bot 设置即时生效；账号增删会在 30 秒内自动重连 / 断开",
    },
  },
  {
    field: "permission",
    label: "命令权限",
    component: "Select",
    defaultValue: "master",
    options: [
      { label: "主人", value: "master" },
      { label: "群主", value: "owner" },
      { label: "管理员", value: "admin" },
      { label: "所有人", value: "all" },
    ],
    help: "#抖音bot 系列指令的使用权限，修改后需 #重载插件 生效",
  },
  {
    component: "Divider",
    label: "Bot 设置",
  },
  {
    field: "bot.timeout",
    label: "API 超时时间",
    component: "InputNumber",
    componentProps: { min: 0, max: 300000, step: 1000 },
    defaultValue: 30000,
    help: "SDK 请求超时时间（毫秒），重连后生效",
  },
  {
    field: "bot.autoRead",
    label: "自动已读",
    component: "Switch",
    defaultValue: true,
    help: "收到消息后自动标记已读，对方可见已读回执",
  },
  {
    field: "bot.activeStatus",
    label: "在线状态",
    component: "Switch",
    defaultValue: true,
    help: "上报在线状态，对方可见在线",
  },
  {
    field: "bot.forwardToImage",
    label: "合并转发转图片",
    component: "Switch",
    defaultValue: true,
    help: "合并转发渲染为图片发送；关闭则走 SDK 原生 forward 卡片",
  },
  {
    field: "bot.autoAcceptFriend",
    label: "自动同意好友申请",
    component: "Switch",
    defaultValue: false,
    help: "收到好友申请时自动通过，仍会推送事件",
  },
  {
    field: "bot.autoAcceptGroup",
    label: "自动同意入群申请",
    component: "Switch",
    defaultValue: false,
    help: "收到入群申请时自动通过，仍会推送事件",
  },
  {
    component: "Divider",
    label: "账号设置",
  },
  {
    field: "token",
    label: "账号列表",
    component: "Textarea",
    componentProps: {
      rows: 4,
      placeholder: "每行一个账号，格式：id:token\n登录后自动生成，无需手动维护",
    },
    help: "账号 Token 列表，一般通过 #抖音bot登录 生成",
  },
]

export function getConfigData() {
  return {
    permission: config.permission,
    bot: { ...config.bot },
    token: config.token.join("\n"),
  }
}

export function setConfigData(data, { Result }) {
  if (data.permission) config.permission = data.permission
  if (data.bot) config.bot = { ...config.bot, ...data.bot }
  if (data.token != null)
    config.token = String(data.token).split("\n").map(i => i.trim()).filter(Boolean)
  configSave()
  return Result.ok({}, "保存成功")
}
