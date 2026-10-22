import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

export default {
  name: "DouYin-Plugin",
  title: "抖音插件",
  description: "TRSS-Yunzai 抖音适配器插件，支持抖音私聊 / 群聊消息收发与事件处理",
  author: "@dmmdekkd",
  version,
  repo: "https://github.com/xh2580/DouYin-Plugin",
  repoUrl: "https://github.com/xh2580/DouYin-Plugin",
}
