logger.info(logger.yellow("- 正在加载 DouYin 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import QRCode from "qrcode"
import md5 from "md5"
import path from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createDecipheriv } from "node:crypto"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import * as douyin from "douyin.ts"
import Renderer from "../../lib/renderer/loader.js"
import { update } from "../other/update.js"

// SDK sendBody 支持 11 种类型（text/image/video/file/emoji/share/userCard/forward/card/location/groupCard）；
// audio/link/chains 无发送实现，raw 透传时降级为文本
const sdkSendable = new Set(["text", "image", "video", "file", "emoji", "share", "userCard", "forward", "card", "location", "groupCard"])

// 富文本转义：嵌套合并转发需递归拼 HTML，在 JS 侧生成时防止昵称/文本注入标签
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

// 抖音资源代理：抖音 CDN 直链校验 Referer/Cookie，外部（Chromium 渲染、其它插件）直连会 403；
// 挂在本机 HTTP 服务下统一补全请求头转发，带 skey 的私有图片/视频在代理内解密后再回吐
const MEDIA_MOUNTED = Symbol.for("trss.douyin.media.mounted")
const MEDIA_ROUTE = "/douyin-media"
// 桌面端 UA：抖音 CDN 同时校验 UA 与 Referer，缺一即 403
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// AES-256-GCM 解密抖音图片：前 12 字节 IV + 密文 + 后 16 字节 AuthTag，密钥为消息图片 skey（64 hex）
function decryptImage(buf, skey) {
  if (buf.length < 29) return undefined
  try {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(skey, "hex"), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(buf.length - 16))
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()])
  } catch {
    return undefined
  }
}

// 按魔数识别图片类型（转码档为 WebP，origin 档可能为 HEIC）
function imageContentType(buf) {
  const head = buf.subarray(0, 12).toString("hex")
  if (head.startsWith("ffd8ff")) return "image/jpeg"
  if (head.startsWith("89504e47")) return "image/png"
  if (head.startsWith("52494646") && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp"
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "image/heic"
  if (head.startsWith("474946")) return "image/gif"
  return "application/octet-stream"
}

export const { config, configSave } = await makeConfig(
  "DouYin",
  {
    tips: "",
    permission: "master",
    bot: {
      timeout: 30000,
      // 收到消息后自动标记已读（对方可见已读回执）
      autoRead: true,
      // 上报在线状态（对方可见在线）
      activeStatus: true,
      // 合并转发渲染为图片发送（默认开启）：抖音 forward 卡片需引用会话内真实消息，
      // 纯生成内容节点无真实消息 id 时预览/展开异常，转图片更稳定；关闭则走 SDK 原生 forward 卡片
      forwardToImage: true,
      // 好友申请自动同意（默认关闭，仅对申请事件生效）
      autoAcceptFriend: false,
      // 入群申请自动同意（默认关闭，仅对申请事件生效）
      autoAcceptGroup: false,
    },
    token: [],
  },
  {
    tips: [
      "欢迎使用 TRSS-Yunzai DouYin Plugin ! SDK：dmmdekkd",
      "参考：https://github.com/dmmdekkd/douyin.ts",
    ],
  },
)

const adapter = new (class DouYinAdapter {
  constructor() {
    this.id = "DouYin"
    this.name = "DouYin"
    this.path = "data/DouYin/"
    // SDK 名称与版本号（exports 不含 package.json，通过入口文件路径定位读取）
    const { name, version } = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve("douyin.ts"))), "../package.json"), "utf8"),
    )
    this.version = `${name} ${version}`
    this.logining = false
    // 登录频控冷却截止时间戳：check_qrconnect error_code=7 后 10 分钟内拒绝新登录
    this.loginCooldown = 0
    // 登录二次验证等待：{ kind: "sms"|"password", resolve, reject }，由验证码/密码指令消费
    this.mfaWait = null
    // 断线重连状态：各账号已重试次数 / 主动登出标记
    this.reconnects = {}
    this.noReconnect = new Set()
    // 群成员增减去重：notice 与 status 补漏双路径
    this.memberSeen = new Map()
    this.refreshes = {}
    // 媒体代理路由（全局幂等，仅挂载一次）
    this.registerResourceProxy()
  }

  makeSDKLog(id) {
    return {
      info: msg => Bot.makeLog("debug", msg, id),
      // SDK 传输层每次调用失败都会 warn 一次（如 cmd=203 get_by_user_init 重试 3 次），
      // cookie 失效时多触发点叠加会疯狂刷屏；此类自动重试噪音降级为 debug，只保留插件侧的最终失效提示
      warn: msg =>
        /^cmd=\d+ .*失败/.test(msg)
          ? Bot.makeLog("debug", msg, id)
          : Bot.makeLog("warn", msg, id),
      error: msg => Bot.makeLog("error", msg, id),
    }
  }

  // 设备身份落盘路径：与好友/群列表同账号目录
  deviceFile(id) {
    return `${this.path}${id}/device.json`
  }

  // 读取已持久化设备身份（douyin.ts 0.6.6 起支持）；不存在或损坏时返回 undefined，由 SDK 重新注册
  loadDevice(id) {
    try {
      return JSON.parse(readFileSync(this.deviceFile(id), "utf8"))
    } catch {
      return undefined
    }
  }

  // 持久化设备身份：下次构造/登录注入同一设备，避免每次启动重新注册导致身份不稳定触发二次验证
  saveDevice(id, device) {
    if (!device) return
    try {
      mkdirSync(path.dirname(this.deviceFile(id)), { recursive: true })
      writeFileSync(this.deviceFile(id), JSON.stringify(device))
    } catch (err) {
      Bot.makeLog("warn", ["设备身份落盘失败", id, err], this.id)
    }
  }

  // 资源直链 → 本机代理地址（附目标账号 uin 与可选 skey 供代理内解密）；
  // 非 http(s)（data URI / base64 / 本地路径）原样返回；已是代理地址不二次包装
  resourceUrl(url, uin, skey) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return url
    if (url.includes(`${MEDIA_ROUTE}/`)) return url
    const base = String(Bot.url || "http://localhost:2536").replace(/\/+$/, "")
    return `${base}${MEDIA_ROUTE}/${uin ?? ""}?u=${encodeURIComponent(url)}${skey ? `&k=${encodeURIComponent(skey)}` : ""}`
  }

  // 幂等挂载媒体代理路由：按账号 Cookie + Referer 拉取抖音私有资源；
  // 带 skey 的图片（64 hex，AES-256-GCM）与 CENC 视频（32 hex，AES-128）解密后回吐，其余流式转发
  registerResourceProxy() {
    if (globalThis[MEDIA_MOUNTED]) return
    globalThis[MEDIA_MOUNTED] = true
    if (!Bot.express.skip_auth.includes(MEDIA_ROUTE)) Bot.express.skip_auth.push(MEDIA_ROUTE)
    Bot.express.get(`${MEDIA_ROUTE}/:uin`, async (req, res) => {
      const url = String(req.query.u ?? "")
      const uin = String(req.params.uin ?? "")
      if (!/^https?:\/\//i.test(url)) return res.status(400).end("bad url")
      try {
        const headers = { Referer: "https://www.douyin.com/", "User-Agent": DESKTOP_UA }
        const cookie = Bot[uin]?.getCookies?.()
        if (cookie) headers.Cookie = cookie
        const upstream = await fetch(url, { headers, redirect: "follow" })
        if (!upstream.ok) return res.status(upstream.status).end("upstream error")
        if (!upstream.body) return res.status(502).end("empty upstream")
        const skey = String(req.query.k ?? "")
        if (/^[0-9a-f]{64}$/i.test(skey)) {
          const raw = Buffer.from(await upstream.arrayBuffer())
          const plain = decryptImage(raw, skey)
          if (plain) {
            res.setHeader("Content-Type", imageContentType(plain))
            res.setHeader("Content-Length", String(plain.length))
            return res.end(plain)
          }
          // 解密失败说明该资源本身是明文，按原样回吐，避免误传 skey 破坏图片
          res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream")
          res.setHeader("Content-Length", String(raw.length))
          return res.end(raw)
        }
        if (/^[0-9a-f]{32}$/i.test(skey)) {
          const plain = douyin.decryptCencMp4(new Uint8Array(await upstream.arrayBuffer()), skey)
          res.setHeader("Content-Type", "video/mp4")
          res.setHeader("Content-Length", String(plain.length))
          return res.end(plain)
        }
        const type = upstream.headers.get("content-type")
        const len = upstream.headers.get("content-length")
        if (type) res.setHeader("Content-Type", type)
        if (len) res.setHeader("Content-Length", len)
        Readable.fromWeb(upstream.body).pipe(res)
      } catch (err) {
        Bot.makeLog("warn", ["媒体代理失败", url.slice(0, 120), err], uin)
        if (!res.headersSent) res.status(502).end("proxy error")
        else res.destroy()
      }
    })
  }

  // 消息 → 消息段数组 + 日志用 raw_message：与 OPQBot/GSUIDCore 接收侧一致，组装 message 段时同步拼接
  // raw_message，每种消息类型带一个基本信息标记（如 [图片:url] / [视频:摘要] / [文件:名称] / [语音:摘要]），
  // 日志只打 raw_message，避免把带 resource 的自定义段整体序列化刷屏
  makeMessageSegs(msg, uin) {
    const message = []
    let raw = ""
    for (const i of msg.ats || []) {
      message.push({ type: "at", qq: i.uid })
      raw += `[提及:${i.nickname || i.uid}]`
    }

    switch (msg.type) {
      case "text":
        // 引用消息可能仅携带 refmsg 而无正文（text=""），为空不生成段，避免空气泡
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      case "image": {
        const url =
          msg.image.thumbUrls?.[0] || msg.image.mediumUrls?.[0] || msg.image.largeUrls?.[0] || msg.image.originUrls?.[0]
        // 完整资源对象挂 resource 供发侧原样回传；私有图片（带 skey）展示用 file 走代理解密
        if (url) {
          const file = msg.image.skey ? this.resourceUrl(url, uin, msg.image.skey) : url
          message.push({ type: "image", file, resource: msg.image })
          raw += `[图片:${file}]`
        }
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      }
      case "video": {
        const video = msg.video
        if (video?.tkey && video?.skey && video?.md5) {
          // 收侧视频资源齐备时原样透传：SDK 服务端直接引用原视频，poster 内嵌视频体无需单独发封面
          message.push({ type: "video", video })
          raw += `[视频:${md5(video.tkey)}]`
        } else {
          // 资源缺失无法透传：封面图（如有）+ 播放地址提示文本
          const coverUrl =
            video?.poster?.mediumUrls?.[0] || video?.poster?.thumbUrls?.[0] ||
            video?.poster?.largeUrls?.[0] || video?.poster?.originUrls?.[0]
          if (coverUrl) message.push({ type: "image", file: video?.poster?.skey ? this.resourceUrl(coverUrl, uin, video.poster.skey) : coverUrl, resource: video?.poster })
          else if (video?.inlinePic) message.push({ type: "image", file: `base64://${video.inlinePic}` })
          const playUrl = video?.url?.mainUrl
          message.push({ type: "text", text: playUrl ? `[视频] ${video?.skey ? this.resourceUrl(playUrl, uin, video.skey) : playUrl}` : "[视频]" })
          raw += "[视频]"
        }
        // v0.6.2 起 parseBody 不再填充占位 "[视频]"，text 为真实文案或空串，非空才附带
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      }
      case "file": {
        // 收侧文件资源（uri/skey/md5）齐备时原样透传：SDK 服务端直接引用原文件
        if (msg.file?.uri && msg.file?.skey && msg.file?.md5) {
          message.push({ type: "file", file: msg.file })
        } else {
          message.push({ type: "text", text: `[文件] ${msg.file?.name || msg.file?.md5 || ""}` })
        }
        raw += `[文件:${msg.file?.name || msg.file?.md5 || ""}]`
        // v0.6.2 起 parseBody 将文件名直接作为 text（不再填占位 "[文件]"），仅真实文案才附带（当前文件消息无正文）
        if (msg.text && msg.text !== msg.file?.name) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      }
      case "audio":
        // SDK 不支持发送语音、收侧仅有短时签名 URL 无资源对象可透传，降级为文本提示
        message.push({ type: "text", text: "[语音]" })
        raw += msg.audio?.uri ? `[语音:${md5(msg.audio.uri)}]` : "[语音]"
        // v0.6.2 起 parseBody 不再填充占位 "[语音]"，text 为真实文案或空串，非空才附带
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      case "emoji":
        if (msg.emoji) message.push({ type: "image", file: this.resourceUrl(msg.emoji, uin) })
        raw += msg.emoji ? `[表情:${msg.emoji}]` : "[表情]"
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      case "location":
        if (msg.location) message.push({ type: "location", ...msg.location })
        raw += `[位置:${msg.location?.name || ""}]`
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
        break
      default:
        // 卡片/分享/链接/名片/接龙/合并转发/未知等：透传原始消息体，raw 取标题/人数等基本信息概括
        message.push({ type: "raw", data: msg })
        const label = { forward: "聊天记录", chains: "接龙", link: "链接", share: "分享", userCard: "名片", card: "卡片", groupCard: "群邀请", unknown: "未知消息" }[msg.type] || msg.type
        const info =
          msg.groupCard?.groupName ||
          msg.user?.name ||
          msg.share?.title ||
          msg.link?.title ||
          msg.card?.title ||
          msg.chains?.description ||
          (msg.forward ? `${msg.nodes?.length || 0}条` : "")
        raw += `[${label}${info ? `:${info}` : ""}]`
        if (msg.text) {
          message.push({ type: "text", text: msg.text })
          raw += msg.text
        }
    }
    return { message, raw }
  }

  async makeMsg(data, msg, nested) {
    const msgs = []
    let text = "",
      ats = [],
      atAll = false,
      image,
      // 5 分钟内自动引用触发消息
      reply = !nested && data.time && Date.now() / 1000 - data.time < 300 ? data.bot.replys[data.message_id] : undefined

    const flush = () => {
      if (image) {
        msgs.push({ type: "image", body: { type: "image", image, text }, reply })
        text = ""
        ats = []
        image = undefined
        reply = undefined
      } else if (text || ats.length || atAll) {
        // loader 的 at 选项会插入 "\n" 分隔段，SDK 提及追加在末尾，去掉多余换行
        msgs.push({
          type: "text",
          body: {
            type: "text",
            text: ats.length || atAll ? text.replace(/^\n+/, "") : text,
            ...(ats.length ? { ats } : {}),
            ...(atAll ? { atAll: true } : {}),
          },
          reply,
        })
        text = ""
        ats = []
        atAll = false
        reply = undefined
      }
    }

    for (const i of Array.isArray(msg) ? msg : [msg]) {
      switch (i.type) {
        case "text":
          if (!i.text?.trim()) continue
          if (image) flush()
          text += i.text
          break
        case "at": {
          const uid = String(i.qq)
          if (uid === "all") {
            atAll = true
            continue
          }
          if (image) flush()
          ats.push({
            uid,
            nickname: data.bot.gml.get(data.group_id)?.get(uid)?.nickname || data.bot.fl.get(uid)?.nickname || uid,
          })
          break
        }
        case "image":
          flush()
          image = await this.mediaSource(i.file, data.bot, true, i.resource)
          break
        case "record":
        case "file":
          flush()
          msgs.push({ type: i.type, body: { type: "file", file: { source: await this.mediaSource(i.file, data.bot) } } })
          break
        case "video":
          flush()
          if (i.video?.tkey && i.video?.skey && i.video?.md5) {
            // 收侧完整视频资源原样透传：SDK 服务端直接引用原视频，避免下载/重传
            msgs.push({
              type: "video",
              body: {
                type: "video",
                video: {
                  tkey: i.video.tkey,
                  skey: i.video.skey,
                  md5: i.video.md5,
                  ...(i.video.poster ? { poster: i.video.poster } : {}),
                  ...(typeof i.video.width === "number" ? { width: i.video.width } : {}),
                  ...(typeof i.video.height === "number" ? { height: i.video.height } : {}),
                },
              },
            })
          } else {
            msgs.push({ type: "video", body: { type: "video", video: { source: await this.mediaSource(i.file, data.bot) } } })
          }
          break
        case "file":
          flush()
          if (i.file?.uri && i.file?.skey && i.file?.md5) {
            // 收侧完整文件资源原样透传：SDK 服务端直接引用原文件
            msgs.push({
              type: "file",
              body: {
                type: "file",
                file: {
                  uri: i.file.uri,
                  skey: i.file.skey,
                  md5: i.file.md5,
                  ...(i.file.name ? { name: i.file.name } : {}),
                  ...(typeof i.file.dataSize === "number" ? { dataSize: i.file.dataSize } : {}),
                },
              },
            })
          } else {
            msgs.push({ type: "file", body: { type: "file", file: { source: await this.mediaSource(i.file, data.bot) } } })
          }
          break
        case "raw": {
          flush()
          // SDK 不支持的类型（link/chains/audio/emoji/unknown）降级为文本发送
          let body = i.data
          if (!sdkSendable.has(body.type)) {
            const link = body.link
            const text = link
              ? [link.title, link.url].filter(Boolean).join("\n")
              : body.chains
                ? [body.chains.description, ...(body.chains.entries || []).map(i => i.text)].filter(Boolean).join("\n")
                : body.audio?.urls?.[0] || body.text || body.emoji || ""
            body = { type: "text", text }
          }
          if (body.type !== "text" || body.text?.trim()) msgs.push({ type: "raw", body })
          break
        }
        case "location":
          flush()
          // 兼容 icqq 命名（lat/lng/title）与 SDK 命名（latitude/longitude/name）
          msgs.push({
            type: "location",
            body: {
              type: "location",
              location: {
                name: i.name || i.title,
                address: i.address,
                latitude: i.latitude ?? i.lat,
                longitude: i.longitude ?? i.lng,
                ...(i.poiId ? { poiId: i.poiId } : {}),
              },
            },
          })
          break
        case "face":
          // QQ 数字表情 id 无抖音对应，仅透传抖音小表情 id（如 weixiao）
          if (i.id && !/^\d+$/.test(String(i.id))) {
            flush()
            msgs.push({ type: "raw", body: { type: "emoji", emoji: String(i.id) } })
          }
          continue
        case "button":
        case "markdown":
          continue
        case "node": {
          // 合并转发：收集节点消息体；sendMsg 阶段按 config.bot.forwardToImage 决定渲染为图片或走原生 forward 卡片。
          // bodies 为原生卡片的节点列表（嵌套 forward 保留为单个 forward 节点，不再展平成父节点）；
          // grouped 保留原节点分组与昵称（转图片时一个节点渲染为一个气泡组，嵌套 forward 递归渲染为内嵌小卡片）
          const bodies = []
          const grouped = []
          for (const { nickname, uid, user_id, message } of i.data) {
            const segs = []
            for (const seg of await this.makeMsg(data, message, true)) {
              bodies.push(seg)
              segs.push(seg)
            }
            if (segs.length) grouped.push({ name: nickname, uid: uid ?? user_id, segs })
          }
          if (bodies.length) msgs.push({ type: "forward", bodies, grouped })
          continue
        }
        case "reply":
          reply = data.bot.replys[i.id]
          continue
        default:
          if (image) flush()
          text += Bot.String(i)
      }
    }
    flush()
    return msgs
  }

  makeBrief(seg) {
    const { type, body, reply } = seg
    let brief = reply ? `[回复:${reply.serverMessageId}]` : ""
    switch (type) {
      case "text":
        for (const i of body.ats || []) brief += `@[${i.uid}]`
        if (body.atAll) brief += "@[所有人]"
        return brief + body.text
      case "image":
        // body.image 可能为收侧 ImageResource 透传对象（原样回传原图）
        return `${brief}[图片:${md5(body.image?.oid || body.image)}]${body.text || ""}`
      case "record":
        return `${brief}[语音:${md5(body.file.source)}]`
      case "video": {
        // body.video 可能是透传资源（tkey）或上传 source，对象不可直接 md5
        const vid = body.video?.source || body.video?.tkey
        return `${brief}[视频:${md5(vid && typeof vid !== "object" ? vid : "")}]`
      }
      case "file": {
        // body.file 可能是透传资源（md5）或上传 source，对象不可直接 md5
        const fid = body.file?.source || body.file?.md5
        return `${brief}[文件:${md5(fid && typeof fid !== "object" ? fid : "")}]`
      }
      case "raw":
        return (
          brief +
          (body.text ||
            body.groupCard?.groupName ||
            body.user?.name ||
            body.share?.title ||
            body.card?.title ||
            body.chains?.description ||
            (body.emoji ? `[表情:${body.emoji}]` : undefined) ||
            `[${body.type}]`)
        )
      case "location":
        return `${brief}[位置:${body.location.name}]${body.text || ""}`
      case "forward":
        return `${brief}[聊天记录:${seg.bodies?.length || 0}条]`
      default:
        return brief + JSON.stringify(body)
    }
  }

  // 魔数检测图片实际格式（SDK sniffImageFormat 仅支持 webp/jpeg/png/gif/heic，
  // 多识别 avif/bmp 用于给出明确错误，避免笼统的 "unsupported image data"）
  detectImgFormat(buf) {
    const b = Buffer.from(buf)
    if (b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp"
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return "jpeg"
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png"
    if (b.length >= 6 && (b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a")) return "gif"
    if (b.length >= 12 && b.subarray(4, 8).toString() === "ftyp") {
      for (let offset = 8; offset + 4 <= Math.min(b.length, 32); offset += 4) {
        const brand = b.subarray(offset, offset + 4).toString()
        if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic"
        if (brand === "avif") return "avif"
      }
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp"
    return "unknown"
  }

  // 媒体输入规范化：去首尾反引号（QQ 等来源遗留格式）；URL 带浏览器标识与账号 Cookie 主动下载为字节，
  // 否则 SDK 内部下载（无 Cookie/UA）会被 CDN 拦截或返回非图片内容而报 unsupported image data；
  // base64 与本地路径放行由核心处理；img=true 时校验字节确为 SDK 可上传图片格式。
  // resource 为收侧 ImageResource 完整对象时原样透传（SDK 服务端直接引用原图，私有 CDN 字节无法重新上传）
  async mediaSource(input, bot, img, resource) {
    // 统一校验字节内容，图片场景给出明确错误并记录 debug 日志
    const check = buf => {
      if (!img) return new Uint8Array(buf)
      const fmt = this.detectImgFormat(buf)
      Bot.makeLog("debug", ["媒体图片", `${buf.length}B`, fmt], bot?.uin)
      if (fmt === "avif" || fmt === "bmp")
        throw new Error(`图片格式 ${fmt} 不受 SDK 支持，仅支持 png/jpeg/gif/webp/heic`)
      if (fmt === "unknown")
        throw new Error(`图片内容无效（${buf.length}B，无法识别图片格式），源数据可能损坏`)
      return new Uint8Array(buf)
    }
    // 收侧 ImageResource 完整对象（oid/skey/md5 齐备）：SDK 服务端可直接引用原图资源，无需下载重传
    if (img && resource && ["oid", "skey", "md5"].every(k => typeof resource[k] === "string")) return resource
    if (Buffer.isBuffer(input) || input instanceof Uint8Array || input instanceof ArrayBuffer)
      return check(input)
    if (typeof input !== "string") return input
    const s = input.trim().replace(/^`+|`+$/g, "")
    if (/^https?:\/\//i.test(s)) {
      const headers = {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        referer: "https://www.douyin.com/",
      }
      // 抖音图片 CDN 需登录态，附上账号 Cookie
      const cookie = bot?.getCookies?.()
      if (cookie) headers.cookie = cookie
      const res = await fetch(s, { headers, redirect: "follow" })
      if (!res.ok) throw new Error(`媒体下载失败 HTTP ${res.status}`)
      const type = (res.headers.get("content-type") || "").toLowerCase()
      if (type && !type.startsWith("image/") && !["application/octet-stream", "binary/octet-stream"].includes(type))
        throw new Error(`媒体下载失败：服务器返回 ${type}（URL 可能已失效或需登录）`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error("媒体下载为空")
      Bot.makeLog("debug", ["媒体下载", s.slice(0, 80)], bot?.uin)
      return check(buf)
    }
    const out = Bot.Buffer(s, { http: true })
    return Buffer.isBuffer(out) || out instanceof Uint8Array || out instanceof ArrayBuffer ? check(out) : out
  }

  // 发送单条消息体（reply 优先走引用回复），statusCode 非 0 抛错由调用方统一处理
  // 引用回复透传完整 body：SDK 0.6.7 起支持引用任意类型消息（图片/视频/文件等），@提及/@所有人随 body 一并生效
  async sendBody(data, { reply, body }) {
    const ret = reply
      ? await data.bot.sdk.msg.reply(data.chatId, reply, body)
      : await data.bot.sdk.msg.send(data.chatId, body)
    Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)
    if (ret.statusCode) throw new Error(`发送被拒：statusCode=${ret.statusCode} ${ret.statusMsg || ""}`)
    return ret
  }

  // 合并转发转图片：把节点渲染成「聊天记录」卡片（config.bot.forwardToImage 开启时走此路径）。
  // 一个节点渲染为一个气泡组：文本→气泡、图片→缩略图、其余类型→标签；嵌套 forward 递归渲染为内嵌「聊天记录」小卡片。
  // 节点无昵称时统一用当前 bot 昵称。行 HTML 在 JS 侧生成（嵌套需递归，art-template 不便递归）。
  async renderForward(data, { bodies, grouped }) {
    const fallback = data.bot.nickname || String(data.self_id)
    const groups = grouped?.length ? grouped : [{ name: fallback, segs: bodies }]
    const nodes = await this.buildNodes(data.bot, groups, fallback, data.group_id)
    const buf = await Renderer.getRenderer().render("DouYinForward", {
      tplFile: path.join(path.dirname(fileURLToPath(import.meta.url)), "resources", "forward.html"),
      title: data.group_id ? "群聊的聊天记录" : "聊天记录",
      desc: `${nodes.length} 条消息`,
      listHTML: this.nodesHTML(nodes),
    })
    if (!buf) throw new Error("合并转发图片渲染失败（Chromium 不可用或模板加载失败）")
    return buf
  }

  // 节点分组 → 渲染节点（逐段解析；嵌套 forward 递归构建内层节点）
  // 头像取发送者真实头像：优先好友/群成员缓存，缺失时按 secUid 批量补全（IM user.info 50/批）；
  // 无头像时退化为昵称首字彩底
  async buildNodes(bot, groups, fallback = bot?.nickname || "·", groupId) {
    const gml = groupId != null ? bot?.gml?.get(String(groupId)) : undefined
    const cacheOf = uid => bot?.fl?.get(String(uid)) || gml?.get(String(uid)) || {}
    const secUids = groups.map(g => cacheOf(g.uid)).filter(c => !c.avatar && c.secUid).map(c => c.secUid)
    const fetched = secUids.length ? await this.fetchUserInfo(bot.uin, secUids) : new Map()
    const nodes = []
    for (const g of groups) {
      const name = g.name || fallback
      const parts = []
      for (const seg of g.segs) {
        const part = await this.renderPart(bot, seg, groupId)
        if (part) parts.push(part)
      }
      if (!parts.length) continue
      const cache = cacheOf(g.uid)
      // 节点无 uid（如 Bot.makeForwardArray 生成）时视为 bot 自己发送，头像回退 bot 头像
      const raw = cache.avatar || fetched.get(cache.secUid)?.avatar || (!g.uid && bot?.avatar)
      nodes.push({
        name,
        avatar: raw || "",
        initial: [...name][0] || "·",
        color: this.avatarColor(name),
        parts,
      })
    }
    return nodes
  }

  // 节点列表 → HTML（顶层与嵌套共用；嵌套 forward 在 partHTML 中递归展开）
  nodesHTML(nodes) {
    return nodes.map(n => this.nodeHTML(n)).join("")
  }

  nodeHTML({ name, avatar, initial, color, parts }) {
    const face = avatar
      ? `<img class="avatar" src="${escHtml(avatar)}" alt="">`
      : `<div class="avatar" style="background:${escHtml(color)}">${escHtml(initial)}</div>`
    return (
      `<div class="row">${face}` +
      `<div class="content"><div class="name">${escHtml(name)}</div>${parts.map(p => this.partHTML(p)).join("")}</div></div>`
    )
  }

  partHTML(part) {
    switch (part.kind) {
      case "text":
        return `<div class="text">${escHtml(part.text)}</div>`
      case "image":
        return (
          `<div class="pic"><img src="${escHtml(part.src)}">${part.tag ? `<span class="badge">${escHtml(part.tag)}</span>` : ""}</div>` +
          (part.text ? `<div class="cap">${escHtml(part.text)}</div>` : "")
        )
      case "forward":
        return (
          `<div class="fwd"><div class="fwd-head"><span class="fwd-title">聊天记录</span><span class="fwd-count">${part.count} 条</span></div>` +
          `<div class="fwd-list">${this.nodesHTML(part.nodes)}</div></div>`
        )
      default:
        return `<div class="chip">${escHtml(part.label)}</div>`
    }
  }

  // 昵称 → 头像底色（稳定散列，同一昵称固定同色）
  avatarColor(name) {
    const colors = ["#fe2c55", "#ff7a45", "#f5a623", "#52c41a", "#13c2c2", "#1890ff", "#2f54eb", "#722ed1", "#eb2f96"]
    let h = 0
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 99991
    return colors[h % colors.length]
  }

  // 单个消息体 → 渲染片段：text 文本气泡 / image 图片缩略图 / forward 内嵌小卡片 / 其他标签
  async renderPart(bot, seg, groupId) {
    const { type, body } = seg
    switch (type) {
      case "text": {
        const ats = (body.ats || []).map(i => `@${i.nickname || i.uid}`).join("")
        const text = (body.atAll ? "@所有人 " : "") + ats + (body.text || "")
        return text.trim() ? { kind: "text", text } : undefined
      }
      case "image": {
        const src = await this.bodyImageSrc(bot, body.image)
        if (src) return { kind: "image", src, text: body.text || "" }
        return { kind: "chip", label: this.makeBrief(seg) }
      }
      case "video": {
        const inline = body.video?.inlinePic
        const src = (await this.bodyImageSrc(bot, body.video?.poster)) || (inline ? `data:image/jpeg;base64,${inline}` : "")
        if (src) return { kind: "image", src, tag: "视频" }
        return { kind: "chip", label: "[视频]" }
      }
      case "forward": {
        // 嵌套合并转发：递归构建内层节点，渲染为内嵌「聊天记录」小卡片
        const fallback = bot?.nickname || "·"
        const groups = seg.grouped?.length ? seg.grouped : [{ name: fallback, segs: seg.bodies }]
        const nodes = await this.buildNodes(bot, groups, fallback, groupId)
        return nodes.length ? { kind: "forward", count: nodes.length, nodes } : undefined
      }
      default:
        return { kind: "chip", label: this.makeBrief(seg) }
    }
  }

  // 图片消息 → 渲染用 src：抖音 CDN 直链直接输出；本机字节/base64/本地路径内联为 data URI
  async bodyImageSrc(bot, image) {
    try {
      if (typeof image === "string") {
        if (/^https?:\/\//i.test(image)) return image
      } else if (
        image &&
        typeof image === "object" &&
        !Buffer.isBuffer(image) &&
        !(image instanceof Uint8Array) &&
        !(image instanceof ArrayBuffer)
      ) {
        const url = image.mediumUrls?.[0] || image.thumbUrls?.[0] || image.largeUrls?.[0] || image.originUrls?.[0] || image.url
        return url && image.skey ? this.resourceUrl(url, bot?.uin, image.skey) : url || ""
      }
      const buf =
        Buffer.isBuffer(image) || image instanceof Uint8Array || image instanceof ArrayBuffer
          ? Buffer.from(image)
          : Buffer.from(await this.mediaSource(image, bot, true))
      if (!buf.length) return ""
      const mime = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[this.detectImgFormat(buf)]
      return mime ? `data:${mime};base64,${buf.toString("base64")}` : ""
    } catch (err) {
      Bot.makeLog("debug", ["合并转发图片渲染跳过", String(err.message || err)], bot?.uin)
      return ""
    }
  }

  // 合并转发转图片发送：渲染失败时回退到 SDK 原生 forward 卡片，避免消息丢失
  async sendForwardImage(data, { bodies, grouped }, rets) {
    let image
    try {
      image = await this.mediaSource(await this.renderForward(data, { bodies, grouped }), data.bot, true)
    } catch (err) {
      Bot.makeLog("warn", ["合并转发转图片失败，回退原生 forward 卡片", err], data.self_id)
      return this.sendForward(data, { bodies }, rets)
    }
    try {
      Bot.makeLog(
        "info",
        `send to ${data.group_id ? `Group(${data.group_id})` : `User(${data.user_id})`}: [合并转发转图片:${bodies.length}条]`,
        data.self_id,
      )
      const ret = await this.sendBody(data, { body: { type: "image", image } })
      rets.data.push(ret)
      if (ret.serverMessageId) rets.message_id.push(ret.serverMessageId)
    } catch (err) {
      Bot.makeLog("error", ["发送合并转发图片错误", err], data.self_id)
      if (/HTTP 401|login|auth|登录|expire/i.test(String(err.message || err)))
        Bot.makeLog("error", `${data.self_id} 登录状态已失效，请使用 #抖音bot登录 重新扫码`, data.self_id)
      rets.error.push(err)
    }
  }

  // 合并转发：直接走 SDK 原生 sendMergeForward（msg.send type=forward）一次组卡发送，
  // 不再先逐条真发节点再撤回——旧实现会「先发送后撤回」造成闪屏/留痕。
  // 节点携带真实消息 id（转发真实聊天记录）时直接透传；纯生成内容无真实 id 给占位 id "0"，
  // 卡片按节点 text 预览渲染。发送失败仅报错，不做降级。
  async sendForward(data, { bodies }, rets) {
    // 节点消息类型映射（7 文本 / 27 图片 / 30 视频 / 136 转发 / 152 接龙，未知给 0）
    const fwdType = { text: [7, 700], image: [27, 2702], video: [30, 0], forward: [136, 0], chains: [152, 0] }
    try {
      const nodes = bodies.map(seg => ({
        uid: String(data.self_id),
        nickname: data.bot.nickname,
        text: this.makeBrief(seg),
        msgType: fwdType[seg.type]?.[0] ?? 0,
        aweType: fwdType[seg.type]?.[1] ?? 0,
        msgId: String(seg.msgId ?? seg.serverMessageId ?? "0"),
      }))
      Bot.makeLog("info", `send to ${data.group_id ? `Group(${data.group_id})` : `User(${data.user_id})`}: [合并转发:${nodes.length}条]`, data.self_id)
      const ret = await data.bot.sdk.msg.send(data.chatId, { type: "forward", nodes })
      rets.data.push(ret)
      if (ret.statusCode) rets.error.push(new Error(`发送被拒：statusCode=${ret.statusCode} ${ret.statusMsg || ""}`))
      else if (ret.serverMessageId) rets.message_id.push(ret.serverMessageId)
    } catch (err) {
      Bot.makeLog("error", ["发送合并转发错误", err], data.self_id)
      if (/HTTP 401|login|auth|登录|expire/i.test(String(err.message || err)))
        Bot.makeLog("error", `${data.self_id} 登录状态已失效，请使用 #抖音bot登录 重新扫码`, data.self_id)
      rets.error.push(err)
    }
  }

  async sendMsg(data, msg) {
    const rets = { message_id: [], data: [], error: [] }
    data.bot.stat.sent_msg_cnt++
    for (const i of await this.makeMsg(data, msg)) {
      if (i.type === "forward") {
        if (config.bot.forwardToImage) await this.sendForwardImage(data, i, rets)
        else await this.sendForward(data, i, rets)
        continue
      }
      try {
        Bot.makeLog(
          "info",
          `send to ${data.group_id ? `Group(${data.group_id})` : `User(${data.user_id})`}: ${this.makeBrief(i)}`,
          data.self_id,
        )
        const ret = await this.sendBody(data, i)
        rets.data.push(ret)
        if (ret.serverMessageId) rets.message_id.push(ret.serverMessageId)
      } catch (err) {
        Bot.makeLog("error", ["发送消息错误", i.body, err], data.self_id)
        if (/HTTP 401|login|auth|登录|expire/i.test(String(err.message || err)))
          Bot.makeLog("error", `${data.self_id} 登录状态已失效，请使用 #抖音bot登录 重新扫码`, data.self_id)
        rets.error.push(err)
      }
    }
    return rets
  }

  async sendFriendMsg(data, msg) {
    if (!data.chatId) {
      await this.loadFriend(data.self_id)
      // loadFriend 检测到 cookie 失效时会移除账号，Bot[id] 可能已不存在
      Object.assign(data, Bot[data.self_id]?.fl.get(data.user_id) || {})
      if (!data.chatId) {
        Bot.makeLog("error", [`发送好友消息失败：[${data.user_id}] 不存在会话信息`, msg], data.self_id)
        return false
      }
    }
    return this.sendMsg(data, msg)
  }

  async sendGroupMsg(data, msg) {
    if (!data.chatId) {
      await this.loadGroup(data.self_id)
      Object.assign(data, Bot[data.self_id].gl.get(data.group_id) || {})
      if (!data.chatId) {
        Bot.makeLog("error", [`发送群消息失败：[${data.group_id}] 不存在会话信息`, msg], data.self_id)
        return false
      }
    }
    return this.sendMsg(data, msg)
  }

  async recallMsg(data, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id) {
      Bot.makeLog(
        "info",
        `${data.group_id ? `撤回群消息：[${data.group_id}]` : `撤回好友消息：[${data.user_id}]`} ${i}`,
        data.self_id,
      )
      let ret
      try {
        ret = await data.bot.sdk.msg.recall(data.chatId, i)
        // SDK 失败不抛异常，返回 recalled:false（如群聊无撤回权限 statusCode=11 USER_FORBIDDEN）
        if (ret?.recalled === false) {
          Bot.makeLog("warn", ["撤回消息失败", i, `${ret.statusCode} ${ret.statusMsg}`], data.self_id)
          ret = false
        }
      } catch (err) {
        Bot.makeLog("info", ["撤回消息错误", i, err], data.self_id)
        ret = false
      }
      msgs.push(ret || false)
    }
    return msgs
  }

  getFriendMap(id) {
    return Bot.getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return Bot.getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return Bot.getMap(`${this.path}${id}/Member`)
  }

  async getChatHistory(data, cnt = 20) {
    const history = await data.bot.sdk.chat.history(data.chatId, { count: cnt })
    return history.map(msg => {
      const { message, raw } = this.makeMessageSegs(msg, data.bot?.uin)
      return {
        message_id: msg.serverMessageId,
        user_id: msg.senderUid,
        time: msg.createTime ? +msg.createTime / 1e6 : undefined,
        message,
        raw_message: raw,
        raw: msg,
      }
    })
  }

  pickFriend(id, user_id) {
    if (typeof user_id !== "string") user_id = String(user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id,
    }
    return {
      ...i,
      get name() {
        return this.nickname
      },
      sendMsg: msg => this.sendFriendMsg(i, msg),
      recallMsg: message_id => this.recallMsg(i, message_id),
      getAvatarUrl: async () => {
        if (i.avatar) return i.avatar
        if (!i.secUid) return i.avatar
        // 好友列表无头像，通过资料接口查询并缓存
        const profile = await i.bot.sdk.user.profileScene(i.secUid).catch(() => undefined)
        if (profile?.avatar) {
          i.avatar = profile.avatar
          await i.bot.fl.set(user_id, {
            ...i.bot.fl.get(user_id),
            user_id,
            nickname: i.nickname,
            secUid: i.secUid,
            chatId: i.chatId,
            avatar: i.avatar,
          })
        }
        return profile?.avatar || i.avatar
      },
      getInfo: async () => {
        if (!i.secUid) return i
        const profile = await i.bot.sdk.user.profileScene(i.secUid).catch(() => undefined)
        if (profile?.avatar) {
          i.avatar = profile.avatar
          await i.bot.fl.set(user_id, {
            ...i.bot.fl.get(user_id),
            user_id,
            nickname: profile.nickname || i.nickname,
            secUid: i.secUid,
            chatId: i.chatId,
            avatar: i.avatar,
          })
        }
        return { ...i, ...profile, user_id }
      },
      getChatHistory: (cnt = 20) => this.getChatHistory(i, cnt),
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id,
      group_id,
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      get card() {
        return this.nickname
      },
      get is_friend() {
        return i.bot.fl.has(user_id)
      },
      // role 来自群成员列表（1 群主），或与群主 uid 比对
      get is_owner() {
        return i.role === 1 || i.bot.gl.get(group_id)?.ownerUid === user_id
      },
      get is_admin() {
        return this.is_owner || i.role === 2 || i.role === 3
      },
      getInfo: async () => {
        const chatId = i.bot.gl.get(group_id)?.chatId
        if (!chatId) return i
        const member = (await i.bot.sdk.grp.members(chatId)).find(m => m.uid === user_id)
        if (!member) return i
        // 群成员列表（605）不含昵称/头像，用 IM 批量接口按 secUid 补全，并落库 secUid/抖音号供后续读取
        const [user] = member.secUid ? await i.bot.sdk.user.info([member.secUid]) : []
        const data = {
          ...i,
          ...member,
          ...(user ? {
            nickname: user.nickname || i.nickname,
            avatar: user.avatar || i.avatar,
            signature: user.signature ?? i.signature,
            uniqueId: user.uniqueId ?? i.uniqueId,
            shortId: user.shortId ?? i.shortId,
          } : {}),
        }
        const gml = i.bot.gml.get(group_id)
        if (gml)
          await gml.set(user_id, {
            ...gml.get(user_id),
            user_id,
            nickname: data.nickname,
            secUid: member.secUid,
            avatar: data.avatar,
            uniqueId: data.uniqueId,
            shortId: data.shortId,
          })
        return data
      },
      kickOut: async () => {
        const chatId = i.bot.gl.get(group_id)?.chatId
        if (!chatId) return false
        return i.bot.sdk.grp.removeMembers(chatId, [user_id])
      },
      kick() {
        return this.kickOut()
      },
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id,
    }
    return {
      ...i,
      get name() {
        return this.group_name
      },
      get is_owner() {
        return i.ownerUid === id
      },
      sendMsg: msg => this.sendGroupMsg(i, msg),
      recallMsg: message_id => this.recallMsg(i, message_id),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap() {
        return i.bot.gml.get(group_id)
      },
      getMemberList() {
        return [...(i.bot.gml.get(group_id)?.keys() || [])]
      },
      getMemberArray() {
        return [...(i.bot.gml.get(group_id)?.values() || [])]
      },
      getAvatarUrl: () => i.avatar,
      getInfo: async () => {
        if (!i.chatId) return i
        const info = (await i.bot.sdk.chat.info(i.chatId))[0]
        if (!info) return i
        const owner = info.members?.find(m => m.uid === info.ownerUid || m.role === 1)
        Object.assign(i, {
          group_name: info.name,
          avatar: info.avatar?.replace(/`/g, ""),
          member_count: info.members?.length,
          ownerUid: info.ownerUid,
          ownerSecUid: owner?.secUid,
        })
        // 只存纯数据字段，避免 bot 实例循环引用无法序列化
        await i.bot.gl.set(group_id, {
          ...i.bot.gl.get(group_id),
          group_id,
          chatId: i.chatId,
          group_name: i.group_name,
          avatar: i.avatar,
          member_count: i.member_count,
          ownerUid: i.ownerUid,
          ownerSecUid: i.ownerSecUid,
        })
        return { ...i }
      },
      getChatHistory: (cnt = 20) => this.getChatHistory(i, cnt),
      setGroupName: async group_name => {
        const ret = await i.bot.sdk.grp.rename(i.chatId, group_name)
        if (ret?.statusCode === 0) {
          i.group_name = group_name
          // 只存纯数据字段，避免 bot 实例循环引用无法序列化
          await i.bot.gl.set(group_id, {
            ...i.bot.gl.get(group_id),
            group_id,
            chatId: i.chatId,
            group_name,
          })
        }
        return ret
      },
      setName(group_name) {
        return this.setGroupName(group_name)
      },
      kickOut: async user_id => i.bot.sdk.grp.removeMembers(i.chatId, [String(user_id)]),
      kickMember(user_id) {
        return this.kickOut(user_id)
      },
      quit: () => i.bot.sdk.grp.leave(i.chatId),
    }
  }

  // list 可由调用方预取（connect 时复用 cookie 校验阶段的结果），缺省则现拉，避免重复全量翻页
  async loadFriend(id, list) {
    try {
      for (const i of list ?? await Bot[id].sdk.frd.list())
        Bot[id].fl.set(i.uid, {
          ...Bot[id].fl.get(i.uid),
          user_id: i.uid,
          nickname: i.nickname,
          secUid: i.secUid,
          chatId: i.chatId,
        })
    } catch (err) {
      // 运行期 cookie 失效（get_by_user_init 报 unexpected session length）：移除账号并禁止重连，
      // 避免 SDK 自动重连后仍持续拉取会话列表刷报错
      if (/session length/i.test(String(err?.message || err))) {
        this.noReconnect.add(id)
        await this.removeBot(id)
        return Bot.makeLog("error", `${id} 登录状态已失效（cookie 校验失败），账号已移除，请使用 #抖音bot登录 重新扫码`, id)
      }
      Bot.makeLog("error", ["好友列表获取错误", err], id)
    }
  }

  // list 说明同 loadFriend：可复用 cookie 校验阶段已拉取的群列表
  async loadGroup(id, list) {
    try {
      for (const i of list ?? await Bot[id].sdk.grp.list())
        if (i.isGroup)
          Bot[id].gl.set(i.conversationShortId, {
            ...Bot[id].gl.get(i.conversationShortId),
            group_id: i.conversationShortId,
            group_name: i.name,
            avatar: i.avatar?.replace(/`/g, ""),
            chatId: i.chatId,
          })
    } catch (err) {
      // 群列表同样可能报 unexpected session length（cookie 失效）：与 loadFriend 一致，移除账号并禁止重连
      if (/session length/i.test(String(err?.message || err))) {
        this.noReconnect.add(id)
        await this.removeBot(id)
        return Bot.makeLog("error", `${id} 登录状态已失效（cookie 校验失败），账号已移除，请使用 #抖音bot登录 重新扫码`, id)
      }
      Bot.makeLog("error", ["群列表获取错误", err], id)
    }
  }

  // 批量拉用户资料（IM user.info，50/批），按 secUid 建索引；失败返回空 Map，不阻断调用方
  async fetchUserInfo(id, secUids) {
    const list = [...new Set((secUids || []).filter(Boolean))]
    if (!list.length) return new Map()
    const info = await Bot[id].sdk.user.info(list).catch(err => {
      Bot.makeLog("warn", ["用户资料批量获取失败", err], id)
      return []
    })
    return new Map(info.map(i => [i.secUid, i]))
  }

  // 批量补全好友缓存的抖音号/短号/签名/头像，落库后插件可直接读 e.bot.pickFriend(uid).uniqueId；
  // 单次请求覆盖 50 个好友，避免逐个 profileScene 拖慢
  async enrichFriends(id) {
    const rows = [...Bot[id].fl.values()].filter(i => i.secUid)
    if (!rows.length) return
    const info = await this.fetchUserInfo(id, rows.map(i => i.secUid))
    for (const row of rows) {
      const u = info.get(row.secUid)
      if (!u) continue
      await Bot[id].fl.set(row.user_id, {
        ...row,
        nickname: u.nickname || row.nickname,
        avatar: u.avatar || row.avatar,
        signature: u.signature ?? row.signature,
        uniqueId: u.uniqueId ?? row.uniqueId,
        shortId: u.shortId ?? row.shortId,
      })
    }
  }

  async setFriendMap(data) {
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      user_id: data.user_id,
      nickname: data.sender.nickname,
      chatId: data.chatId,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async setGroupMap(data) {
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      chatId: data.chatId,
      time: data.time,
      message_id: data.message_id,
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      user_id: data.user_id,
      nickname: data.sender.nickname,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async makeMessage(id, msg) {
    if (!msg.serverMessageId || (msg.conversationType !== 1 && msg.conversationType !== 2)) {
      Bot.makeLog("warn", ["未知消息", msg], id)
      return
    }
    Bot[id].stat.recv_msg_cnt++

    const { message, raw: raw_message } = this.makeMessageSegs(msg, id)
    // 空内容消息（引用无正文 / 纯空文本）不构成有效消息，忽略避免空气泡
    if (message.length === 0) {
      Bot[id].stat.recv_msg_cnt--
      Bot.makeLog("debug", `空内容消息已忽略：[${msg.serverMessageId}] from=${msg.senderUid}`, id)
      return
    }

    const data = {
      raw: msg,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_type: msg.conversationType === 2 ? "group" : "private",
      sub_type: "normal",
      message_id: msg.serverMessageId,
      user_id: msg.senderUid,
      time: msg.createTime ? +msg.createTime / 1e6 : Date.now() / 1000,
      sender: {
        user_id: msg.senderUid,
        nickname: msg.senderNickname || msg.senderUid,
      },
      chatId: msg.chatId,
      // 抖音特有字段：盖楼 / 会话内游标 / 上下文扩展
      thread_id: msg.threadId,
      is_thread_root: msg.isThreadRoot,
      index_in_conversation: msg.indexInConversation,
      ext: msg.ext,
      message,
      raw_message,
    }

    if (data.message_type === "group") {
      data.group_id = msg.conversationShortId
      Bot.makeLog("info", `群消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, id)
      await this.setGroupMap(data)
    } else {
      Bot.makeLog("info", `好友消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, id)
      await this.setFriendMap(data)
    }

    Bot[id].replys[data.message_id] = msg
    setTimeout(() => delete Bot[id].replys[data.message_id], 300000)

    // 自动标记已读：readSwitch 清列表红点（50013 依据），markRead 会话内已读（对方可见）
    if (config.bot.autoRead)
      Promise.all([
        data.bot.sdk.chat.readSwitch(data.chatId, [msg]),
        data.bot.sdk.msg.read(data.chatId, msg),
      ])
        .then(() => Bot.makeLog("debug", `已读回执：[${data.message_id}]`, id))
        .catch(err => Bot.makeLog("debug", ["自动已读失败", err], id))

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  // 由会话 id 反查群/好友 id（事件部分类型仅携带长会话 id）
  chatIdToTarget(id, chatId) {
    for (const [gid, g] of Bot[id].gl) if (g.chatId === chatId) return { type: "group", id: gid }
    for (const [uid, f] of Bot[id].fl) if (f.chatId === chatId) return { type: "friend", id: uid }
    return { type: chatId.startsWith("2:") ? "group" : "friend", id: chatId }
  }

  // 会话状态变更（messageType=50001，高频且自发也下发）
  makeStatus(id, event) {
    // 3/4/8 为自身客户端的会话状态同步（游标更新/属性设置/信息回显），高频无业务价值
    if (event.commandType === 3 || event.commandType === 4 || event.commandType === 8) return
    const label = { 1: "红点更新", 14: "已读同步", 2: "消息删除", 6: "群属性变更", 7: "群成员变更" }[event.commandType] || `commandType=${event.commandType}`
    const detail =
      event.commandType === 2 ? `删除 ${event.messageId}`
      : event.commandType === 6 ? event.nameChange?.name || event.avatarChange?.icon || Bot.String(event.extData || [])
      : event.commandType === 7 ? Bot.String(event.memberChange || {})
      : event.unread != null ? `unread=${event.unread} readIndex=${event.readIndex}` : "未知状态"
    Bot.makeLog("debug", `会话状态 ${label}：[${event.conversationId}] ${detail}`, id)
    // 退群等场景服务端不下发 1001 系统消息，仅 status 有 removed 明细，需补漏派发
    if (event.commandType === 7) this.memberChangeNotice(id, event)
  }

  // bot 自身 uid 判定：数组内大数无保精度处理，尾部可能被截 0（7669111753674851387 → ...4851000），前 15 位比对兜底
  isSelfUid(id, uid) {
    uid = String(uid)
    return uid === id || (uid.length === id.length && uid.slice(0, 15) === id.slice(0, 15))
  }

  // 群成员增减补漏派发：notice（1001 系统消息）已派发过的（2 分钟内）跳过，避免重复
  memberChangeNotice(id, event) {
    const mc = event.memberChange
    if (!mc) return
    // status 的 conversationId 可能是群短 id，与 gl 的 key 或 chatId 匹配（兜底区分群/好友不可靠）
    const conv = event.conversationId
    let gid
    for (const [k, g] of Bot[id].gl) if (g.chatId === conv || k === conv) { gid = k; break }
    if (!gid) return
    const gml = Bot[id].gml.get(gid)
    const emit = (sub_type, uids) => {
      for (const uid of uids) {
        if (this.isSelfUid(id, uid)) { // bot 自身进/退群不派发事件
          Bot.makeLog("info", `机器人${sub_type === "increase" ? "加入" : "退出"}群聊：[${gid}]`, id)
          continue
        }
        const key = `${gid}:${uid}:${sub_type}`
        const seen = this.memberSeen.get(key)
        if (seen && Date.now() - seen < 120000) continue
        this.memberSeen.set(key, Date.now())
        if (this.memberSeen.size > 500) this.memberSeen.clear()
        const nickname = gml?.get(uid)?.nickname || uid
        Bot.makeLog("info", `群成员${sub_type === "increase" ? "加入" : "离开"}：[${gid}] ${nickname}(${uid})`, id)
        Bot.em(`notice.group.${sub_type}`, {
          raw: event,
          bot: Bot[id],
          self_id: id,
          post_type: "notice",
          notice_type: "group",
          sub_type,
          group_id: gid,
          user_id: uid,
          nickname,
          time: Date.now() / 1000,
        })
      }
    }
    emit("increase", mc.added || [])
    emit("decrease", mc.removed || [])
  }

  async makeNotice(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "notice",
      time: Date.now() / 1000,
    }

    switch (event.type) {
      case "message.reaction": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "reaction"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.operator_id = event.operatorUid
        data.message_id = event.serverMessageId
        data.emoji = event.emoji
        data.isSet = event.isSet
        Bot.makeLog("info", `消息${event.isSet ? "添加" : "取消"}回应：[${data.group_id || data.user_id}] ${event.operatorUid} ${event.emoji}`, id)
        break
      }
      case "conversation.read": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "read"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.read_index = event.readMessageIndexV2 || event.readMessageIndex
        Bot.makeLog("debug", `已读回执：[${data.group_id || data.user_id}] ${data.read_index}`, id)
        break
      }
      case "conversation.typing": {
        data.notice_type = "friend"
        data.sub_type = "typing"
        data.user_id = event.peerUid
        data.operator_id = event.senderUid
        data.typing = event.typing
        Bot.makeLog("debug", `输入状态：${event.senderUid} ${event.typing ? "正在输入" : "停止输入"}`, id)
        break
      }
      case "conversation.update":
        Bot.makeLog("debug", ["会话更新", event.conversationId], id)
        return
      case "conversation.delete":
        Bot.makeLog("debug", ["会话删除", event.conversationId], id)
        return
      case "friend.increase":
      case "friend.decrease": {
        data.notice_type = "friend"
        data.sub_type = event.type === "friend.increase" ? "increase" : "decrease"
        data.user_id = event.peerUid
        data.content = event.content
        Bot.makeLog("info", `好友${data.sub_type === "increase" ? "添加" : "删除"}：${event.peerUid}${event.content ? ` ${event.content}` : ""}`, id)
        break
      }
      case "message.recall": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "recall"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.message_id = event.serverMessageId
        data.client_id = event.targetClientMessageId
        data.operator_id = event.recallUid
        Bot.makeLog("info", `撤回消息：[${data.group_id || data.user_id}] ${event.serverMessageId}`, id)
        break
      }
      case "group.member-increase":
      case "group.member-decrease": {
        data.notice_type = "group"
        data.sub_type = event.type === "group.member-increase" ? "increase" : "decrease"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.source = event.source
        for (const i of event.members) {
          // bot 自身进/退群不派发事件（退群后回复必被拒），仅记日志
          if (this.isSelfUid(id, i.uid)) {
            Bot.makeLog("info", `机器人${data.sub_type === "increase" ? "加入" : "退出"}群聊：[${data.group_id}]`, id)
            continue
          }
          this.memberSeen.set(`${data.group_id}:${i.uid}:${data.sub_type}`, Date.now())
          data.user_id = i.uid
          data.nickname = i.nickname
          Bot.makeLog("info", `群成员${data.sub_type === "increase" ? "加入" : "离开"}：[${data.group_id}] ${i.nickname}(${i.uid})`, id)
          Bot.em(`notice.${data.notice_type}.${data.sub_type}`, { ...data })
        }
        return
      }
      case "group.dismiss": {
        data.notice_type = "group"
        data.sub_type = "dismiss"
        data.group_id = event.conversationShortId
        data.operator_id = event.operatorUid
        // 群已解散，清理本地缓存
        Bot[id].gl.delete(data.group_id)
        Bot[id].gml.delete(data.group_id)
        Bot.makeLog("info", `群解散：[${data.group_id}] 操作者：${event.operatorUid || "未知"}`, id)
        break
      }
      case "group.admin": {
        data.notice_type = "group"
        data.sub_type = "admin"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.enabled = event.enabled
        for (const i of event.members) {
          data.user_id = i.uid
          data.nickname = i.nickname
          Bot.makeLog("info", `设为管理员：[${data.group_id}] ${i.nickname}(${i.uid})`, id)
          Bot.em(`notice.${data.notice_type}.${data.sub_type}`, { ...data })
        }
        return
      }
      case "group.name-change": {
        data.notice_type = "group"
        data.sub_type = "name-change"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.name = event.name
        const g = Bot[id].gl.get(event.conversationShortId)
        if (g && event.name) await Bot[id].gl.set(event.conversationShortId, { ...g, group_name: event.name })
        Bot.makeLog("info", `群名变更：[${data.group_id}] ${event.name || ""}`, id)
        break
      }
      case "group.avatar-change": {
        data.notice_type = "group"
        data.sub_type = "avatar-change"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.avatar = event.avatar
        const g = Bot[id].gl.get(event.conversationShortId)
        if (g && event.avatar) await Bot[id].gl.set(event.conversationShortId, { ...g, avatar: event.avatar.replace(/`/g, "") })
        Bot.makeLog("info", `群头像变更：[${data.group_id}]`, id)
        break
      }
      case "im.command":
        Bot.makeLog("debug", ["IM 命令", event], id)
        return
      default:
        Bot.makeLog("debug", ["未知通知", event], id)
        return
    }
    Bot.em(`notice.${data.notice_type}.${data.sub_type}`, data)
  }

  // 消息编辑（编辑重推全文，对自身编辑也触发）：Yunzai 无标准事件，记日志并同步引用缓存
  makeEdited(id, msg) {
    Bot.makeLog("info", `消息编辑：[${msg.senderNickname}(${msg.senderUid})] ${msg.text}`, id)
    if (msg.serverMessageId && Bot[id].replys[msg.serverMessageId]) Bot[id].replys[msg.serverMessageId] = msg
  }

  // 语音/视频来电（仅感知，出站未支持）：Yunzai 无标准事件，仅记日志
  makeVoip(id, event) {
    Bot.makeLog("info", `${event.cameraOff === 1 ? "语音" : "视频"}来电：${event.callerUid} room=${event.roomId}`, id)
  }

  async makeRequest(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "request",
      sub_type: "add",
      comment: event.content || "",
      time: Date.now() / 1000,
    }

    if (event.type === "friend.request") {
      data.request_type = "friend"
      data.user_id = event.applicantUid
      data.nickname = event.applicantUid
      data.approve = () => data.bot.sdk.frd.approve(event.applicantUid)
      data.reject = () => data.bot.sdk.frd.reject(event.applicantUid)
      Bot.makeLog("info", `好友申请：${data.user_id} ${data.comment}`, id)
    } else if (event.type === "group.join-request") {
      data.request_type = "group"
      data.group_id = event.conversationShortId
      // 事件仅携带群信息，需查询申请列表获取申请人及 requestId
      const request = (await data.bot.sdk.grp.requests(event.conversationShortId).catch(() => []))?.find(
        i => i.status === 1 && (i.requestId === event.requestId || !event.requestId),
      )
      data.user_id = request?.applicantUid
      data.nickname = request?.applicantNickname || data.user_id
      data.approve = () => data.bot.sdk.grp.approve(request?.requestId || event.requestId)
      data.reject = () => data.bot.sdk.grp.reject(request?.requestId || event.requestId)
      Bot.makeLog("info", `入群申请：[${data.group_id}] ${data.nickname || ""} ${data.comment}`, id)
    } else {
      return
    }
    // 自动同意开关：按配置自动通过申请，仍入列表并推送事件供其他插件感知
    if (
      (data.request_type === "friend" && config.bot.autoAcceptFriend) ||
      (data.request_type === "group" && config.bot.autoAcceptGroup)
    ) {
      const ret = await data.approve().catch(err => {
        Bot.makeLog("warn", ["自动同意申请失败", data.user_id, err], id)
        return undefined
      })
      data.autoAccepted = !!ret
      Bot.makeLog(
        data.autoAccepted ? "mark" : "warn",
        `自动同意${data.request_type === "friend" ? "好友" : "入群"}申请${data.autoAccepted ? "成功" : "失败"}：${data.user_id}`,
        id,
      )
    }
    Bot[id].request_list.push(data)
    Bot.em(`request.${data.request_type}`, data)
  }

  // 断开并移除账号：清刷新定时器、关闭 leveldb、登出、删 Bot、清 Bot.uin 残留（防核心遍历无效 id 抛错）
  async removeBot(id) {
    clearInterval(this.refreshes[id])
    delete this.refreshes[id]
    const bot = Bot[id]
    if (bot) {
      // 关闭已打开的好友/群/成员 leveldb 句柄，否则同一账号重连（重复登录/断线重连）时
      // 再次 getMap 打开同目录会因 LOCK 文件占用报 LEVEL_LOCKED（Database failed to open）
      await Promise.all(
        [bot.fl, bot.gl, bot.gml].map(m =>
          m?.db?.close?.().catch(err => Bot.makeLog("warn", ["关闭数据库错误", err], id)),
        ),
      )
    }
    bot?.logout()
    delete Bot[id]
    const idx = Bot.uin.indexOf(id)
    if (idx !== -1) Bot.uin.splice(idx, 1)
  }

  // 断线自动重连：延迟 5 秒，最多 5 次，登录成功后重置计数
  async reconnect(id, event) {
    const count = (this.reconnects[id] || 0) + 1
    if (this.noReconnect.has(id) || count > 5) {
      delete this.reconnects[id]
      if (!this.noReconnect.has(id))
        Bot.makeLog("error", `${this.name}(${id}) 断线重连超过 5 次，放弃重连，请重启或重新登录`, this.id)
      return
    }
    this.reconnects[id] = count
    Bot.makeLog("warn", [`${this.name}(${id}) 连接断开，5 秒后第 ${count} 次重连`, event], this.id)
    await Bot.sleep(5000)
    const token = config.token.find(i => i.startsWith(`${id}:`))
    if (!token) {
      delete this.reconnects[id]
      return Bot.makeLog("error", `${this.name}(${id}) 不在账号列表，无法重连`, this.id)
    }
    if (await this.connect(token)) delete this.reconnects[id]
    else this.reconnect(id)
  }

  async connect(token) {
    const [id, cookie] = token.split(/:(.+)/s)
    if (!id || !cookie) {
      Bot.makeLog("error", "账号格式错误，应为 uid:cookie", this.id)
      return false
    }
    Bot.makeLog("debug", `开始连接账号 ${id}`, this.id)

    // 重复登录时先断开旧连接，避免双连接；必须等待旧连接的 leveldb 关闭，
    // 否则下方重建 Bot 后 getMap 再次打开同目录会因 LOCK 占用报 LEVEL_LOCKED
    if (Bot[id]?.sdk) {
      Bot.makeLog("warn", `账号 ${id} 已连接，正在断开旧连接`, this.id)
      await this.removeBot(id)
    }

    const opts = {
      ...config.bot,
      cookie,
      userId: id,
      // 注入已持久化设备身份（douyin.ts 0.6.6）：跳过设备注册，避免每次启动重新注册导致身份不稳定触发登录二次验证
      device: this.loadDevice(id),
      log: this.makeSDKLog(id),
    }

    // 登录状态校验前移：先完成登录并做一次轻量 cookie 校验，失效则不注册 Bot[id]，避免失效账号进入在线态
    const sdk = new douyin.Bot(opts)
    let self
    let friends = []
    let groups = []
    try {
      // 设备身份由 SDK 内部注册：未注入 device 时 start() 自动注册，注入（device.json）则跳过
      await sdk.start()
      // 取回本次使用的设备身份并落盘，供下次构造/登录复用，避免重复注册
      this.saveDevice(id, sdk.device)
      // cookie 校验只用一次「群列表」（原生通道 listNativeGroups）：cookie 失效时首个请求即返回
      // unexpected session length 并抛错（无重试），秒级失败，账号在注册 Bot[id] 前被挡下；
      // 校验通过时该结果直接用于群缓存，避免与 loadGroup 重复全量翻页。
      // 好友列表走 cookie 通道，失效时会静默重试 3 次（约 3s）且异常被 SDK 吞掉，不可靠，
      // 故仅在群校验通过后再与自身资料一并拉取，且结果同样复用，整体仅拉一次。
      groups = await sdk.grp.list()
      ;[friends, self] = await Promise.all([sdk.frd.list(), sdk.user.self()])
    } catch (err) {
      const invalid = /session length/i.test(String(err?.message || err))
      // cookie 失效（session length）时 SDK 反复重试已产生大量 debug 噪音，此处不再重复大堆栈，只提示重登
      if (!invalid)
        Bot.makeLog("error", [`${this.name}(${this.id}) ${this.version} 连接失败`, err], id)
      if (invalid)
        Bot.makeLog("error", `${id} 登录状态已失效（cookie 校验失败），账号未注册，请使用 #抖音bot登录 重新扫码`, id)
      this.noReconnect.add(id)
      sdk.stop()
      return false
    }
    this.noReconnect.delete(id)

    Bot[id] = {
      adapter: this,
      sdk,
      login: () => sdk.start(),
      logout() {
        // 主动登出标记，避免 close 事件触发自动重连
        this.adapter.noReconnect.add(id)
        this.sdk.stop()
      },

      uin: id,
      info: {
        id,
        ...opts,
        ...self,
      },
      get nickname() {
        return this.info.nickname || this.uin
      },
      get avatar() {
        return this.info.avatar
      },

      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: {
        start_time: Date.now() / 1000,
        recv_msg_cnt: 0,
        sent_msg_cnt: 0,
      },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      getFriendArray() {
        return [...this.fl.values()]
      },
      getFriendList() {
        return [...this.fl.keys()]
      },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() {
        return this.gl
      },
      getGroupArray() {
        return [...this.gl.values()]
      },
      getGroupList() {
        return [...this.gl.keys()]
      },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),
      getGroupMemberMap(group_id) {
        return this.gml.get(String(group_id))
      },
      getGroupMemberArray(group_id) {
        return [...(this.gml.get(String(group_id))?.values() || [])]
      },
      getGroupMemberList(group_id) {
        return [...(this.gml.get(String(group_id))?.keys() || [])]
      },

      // 好友/群申请列表（makeRequest 时存入），供插件查询与标准接口处理
      request_list: [],
      getSystemMsg() {
        return this.request_list
      },
      // flag 为好友 uid / 群申请 requestId
      setFriendAddRequest: (flag, approve) => (approve ? sdk.frd.approve(flag) : sdk.frd.reject(flag)),
      setGroupAddRequest: (flag, approve) => (approve ? sdk.grp.approve(flag) : sdk.grp.reject(flag)),
      getCookies() {
        return this.info.cookie
      },
      getCsrfToken: () => "",

      replys: {},
    }

    // 注册到核心账号列表（Bot.uin.toString 随机取号、Bot.xxx 重定向依赖）；
    // 移至 cookie 校验通过后才注册，避免失效账号进入在线态
    if (!Bot.uin.includes(id)) Bot.uin.push(id)

    // 在线状态开关 + im 活跃心跳（登录后打一次）
    if (config.bot.activeStatus)
      Bot[id].sdk.user.activeSwitch().catch(err => Bot.makeLog("warn", ["在线状态上报失败", err], id))
    Bot[id].sdk.user.heartbeat().catch(err => Bot.makeLog("debug", ["心跳上报失败", err], id))

    // 将 SDK 中 Yunzai 未覆盖的 API 挂到 bot 上，插件可通过 e.bot.xxx 直接调用
    Object.assign(Bot[id], {
      // msg：输入状态/语音通话/表情回应/已读/编辑
      sendTyping: (chatId, typing) => sdk.msg.sendTyping(chatId, typing),
      callVoice: (chatId, uid) => sdk.msg.call(chatId, uid),
      reactMsg: (chatId, msgId, emoji, isSet = true) => sdk.msg.react(chatId, msgId, emoji, isSet),
      readMsg: (chatId, msg) => sdk.msg.read(chatId, msg),
      editMsg: (chatId, clientMessageId, body) => sdk.msg.edit(chatId, clientMessageId, body),
      // media：上传/视频地址/作品详情/表情资源
      uploadImage: input => sdk.media.image(input),
      uploadVideo: input => sdk.media.video(input),
      uploadFile: (input, name) => sdk.media.file(input, name),
      getVideoUrl: tkey => sdk.media.videoUrl(tkey),
      getAwemeDetail: (ids, opts) => sdk.media.awemeDetail(ids, opts),
      getPeer: req => sdk.media.getPeer(req),
      getEmojiList: () => sdk.media.emojiList(),
      // frd：好友申请
      getFriendRequests: status => sdk.frd.requests(status),
      approveFriend: uid => sdk.frd.approve(uid),
      rejectFriend: uid => sdk.frd.reject(uid),
      // grp：入群申请/拉人/建群（改名/踢人/退群在 pickGroup 上）
      getGroupRequests: chatId => sdk.grp.requests(chatId),
      approveGroup: requestId => sdk.grp.approve(requestId),
      rejectGroup: requestId => sdk.grp.reject(requestId),
      addGroupMembers: (chatId, uids) => sdk.grp.addMembers(chatId, uids),
      createGroup: opts => sdk.grp.create(opts),
      // chat：会话管理与游标
      getChatInfo: chatId => sdk.chat.info(chatId),
      getStrangers: () => sdk.chat.strangers(),
      getStrangerConversations: () => sdk.chat.strangerConversations(),
      getReadIndex: chatId => sdk.chat.readIndex(chatId),
      getMinIndex: chatId => sdk.chat.minIndex(chatId),
      getUserMessageStat: req => sdk.chat.userMessageStat(req),
      ackMsg: (chatId, msgId) => sdk.chat.ack(chatId, msgId),
      readSwitch: (chatId, msgs) => sdk.chat.readSwitch(chatId, msgs),
      deleteChat: chatId => sdk.chat.delete(chatId),
      setChatSetting: (chatId, input) => sdk.chat.setting(chatId, input),
      batchReadIndex: chatId => sdk.chat.batchReadIndex(chatId),
      // user：资料/在线状态
      getUserProfile: secUid => sdk.user.profileScene(secUid),
      getUserProfileOther: secUid => sdk.user.profileOther(secUid),
      // 按 secUid 批量查用户资料（昵称/头像/签名/抖音号/关系，50/批），比逐个 profileScene 快
      getUserInfo: secUids => sdk.user.info(secUids),
      getOnlineStatus: (ids, source) => sdk.user.onlineStatus(ids, source),
      heartbeat: () => sdk.user.heartbeat(),
      activeSwitch: () => sdk.user.activeSwitch(),
      // sticker：表情面板
      getStickerList: opts => sdk.sticker.list(opts),
      getStickerFavs: () => sdk.sticker.favs(),
      getStickerGifs: () => sdk.sticker.gifs(),
      collectSticker: (ids, opts) => sdk.sticker.collect(ids, opts),
      getTrendingSticker: opts => sdk.sticker.trending(opts),
      getStickerStrategy: scenes => sdk.sticker.strategy(scenes),
    })

    // 事件监听须在 loadFriend/loadGroup 之前注册，否则启动窗口期内推送的消息会被静默丢弃
    Bot[id].sdk.on("message", msg => this.makeMessage(id, msg))
    Bot[id].sdk.on("message:edited", msg => this.makeEdited(id, msg))
    Bot[id].sdk.on("notice", event => this.makeNotice(id, event))
    Bot[id].sdk.on("voip", event => this.makeVoip(id, event))
    Bot[id].sdk.on("status", event => this.makeStatus(id, event))
    Bot[id].sdk.on("request", event => this.makeRequest(id, event))
    Bot[id].sdk.on("read", event => Bot.makeLog("debug", ["单聊已读回执", event], id))
    Bot[id].sdk.on("reconnecting", event => {
      Bot.makeLog("debug", ["连接重连中", event], id)
      // 重连期间趁机校验 cookie：失效（session length）时 loadFriend 内部会移除账号，避免反复重试刷报错
      this.loadFriend(id)
    })
    Bot[id].sdk.on("close", event => this.reconnect(id, event))

    Bot.makeLog(
      "debug",
      ["自动已读", config.bot.autoRead, "在线状态", config.bot.activeStatus, "合并转发转图片", config.bot.forwardToImage],
      id,
    )

    // 复用 cookie 校验阶段已拉取的好友/群列表写入缓存，避免二次全量翻页
    await this.loadFriend(id, friends)
    await this.loadGroup(id, groups)
    // 列表拉取阶段 cookie 失效时 loadFriend/loadGroup 内部已移除账号，不再标记已连接
    if (!Bot[id]) return false

    // 后台批量补全好友抖音号等资料（50/批），不阻塞启动
    this.enrichFriends(id).catch(err => Bot.makeLog("warn", ["好友资料补全失败", err], id))

    // 每 30 分钟全量刷新好友/群列表，防止缓存漂移（先清理旧定时器，避免重连后累积）
    clearInterval(this.refreshes[id])
    const refresh = setInterval(() => {
      if (!Bot[id]) return clearInterval(refresh)
      this.loadFriend(id)
      this.loadGroup(id)
      this.enrichFriends(id)
    }, 30 * 60000)
    refresh.unref?.()
    this.refreshes[id] = refresh

    Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async load() {
    // 账号已在插件加载阶段开始连接，这里等待连接完成
    Bot.makeLog("debug", "适配器加载阶段，等待账号连接完成", this.id)
    await connecting
  }
})()

Bot.adapter.push(adapter)

// 插件加载即开始并行连接所有账号，核心在适配器加载阶段调用 load 时才等待，缩短启动耗时
Bot.makeLog("debug", `插件加载阶段开始连接 ${config.token.length} 个账号`, "DouYin")
const connecting = Promise.allSettled(config.token.map(token => adapter.connect(token)))

// config 热重载感知：定时对比 token 列表，新增/变更的账号自动重连，删除的账号自动断开
let oldTokens = new Map(config.token.map(i => [i.split(/:(.+)/s)[0], i]))
setInterval(() => {
  const cur = new Map(config.token.map(i => [i.split(/:(.+)/s)[0], i]))
  for (const [id, token] of cur)
    if (oldTokens.get(id) !== token) adapter.connect(token)
  for (const id of oldTokens.keys())
    if (!cur.has(id)) adapter.removeBot(id).catch(err => Bot.makeLog("warn", ["移除账号数据库错误", err], id))
  oldTokens = cur
}, 30000).unref?.()

// 近期经插件指令发出的消息（消息 id → 会话上下文），供 #抖音bot撤回 / #抖音bot发送记录 使用
const sentRecall = new Map()
function trackSent(bot, data, rets) {
  for (const mid of rets.message_id) {
    sentRecall.set(mid, { self_id: bot.uin, user_id: data.user_id, group_id: data.group_id, chatId: data.chatId, time: Date.now() })
    if (sentRecall.size > 200) sentRecall.delete(sentRecall.keys().next().value)
  }
}

export class DouYinAdapter extends plugin {
  constructor() {
    super({
      name: "DouYinAdapter",
      dsc: "DouYin 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot账号$|^#抖音bot账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot登录$|^#抖音bot登录$",
          fnc: "Login",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot更新$|^#抖音bot更新$",
          fnc: "Update",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot更新日志$|^#抖音bot更新日志$",
          fnc: "UpdateLog",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot删除[0-9]+$|^#抖音bot删除[0-9]+$",
          fnc: "Del",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot状态$|^#抖音bot状态$",
          fnc: "Status",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot重连[0-9]*$|^#抖音bot重连[0-9]*$",
          fnc: "Reconnect",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot好友列表[0-9]*$|^#抖音bot好友列表[0-9]*$",
          fnc: "FriendList",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot群列表[0-9]*$|^#抖音bot群列表[0-9]*$",
          fnc: "GroupList",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot查用户.+|^#抖音bot查用户.+",
          fnc: "FindUser",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot发消息.+|^#抖音bot发消息.+",
          fnc: "SendTo",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot发群消息.+|^#抖音bot发群消息.+",
          fnc: "SendGroupTo",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot帮助$|^#抖音bot帮助$|^#[Dd]ou[Yy]in[Bb]ot菜单$|^#抖音bot菜单$",
          fnc: "Help",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot好友申请$|^#抖音bot好友申请$",
          fnc: "FriendRequests",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot同意好友[0-9]+$|^#抖音bot同意好友[0-9]+$",
          fnc: "ApproveFriend",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot拒绝好友[0-9]+$|^#抖音bot拒绝好友[0-9]+$",
          fnc: "RejectFriend",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot入群申请[0-9]*$|^#抖音bot入群申请[0-9]*$",
          fnc: "GroupRequests",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot同意入群[0-9]+$|^#抖音bot同意入群[0-9]+$",
          fnc: "ApproveGroup",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot拒绝入群[0-9]+$|^#抖音bot拒绝入群[0-9]+$",
          fnc: "RejectGroup",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot群资料[0-9]+$|^#抖音bot群资料[0-9]+$",
          fnc: "GroupInfo",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot群成员[0-9]+(\\s+[0-9]+)?$|^#抖音bot群成员[0-9]+(\\s+[0-9]+)?$",
          fnc: "GroupMembers",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot找群.+|^#抖音bot找群.+",
          fnc: "GroupSearch",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot改群名[0-9]+.+|^#抖音bot改群名[0-9]+.+",
          fnc: "SetGroupName",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot踢人[0-9]+.+|^#抖音bot踢人[0-9]+.+",
          fnc: "KickMember",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot拉人[0-9]+.+|^#抖音bot拉人[0-9]+.+",
          fnc: "InviteMembers",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot退群[0-9]+(\\s*确认)?$|^#抖音bot退群[0-9]+(\\s*确认)?$",
          fnc: "QuitGroup",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot聊天记录[0-9]+(\\s+[0-9]+)?$|^#抖音bot聊天记录[0-9]+(\\s+[0-9]+)?$",
          fnc: "ChatHistory",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot头像[0-9]+$|^#抖音bot头像[0-9]+$",
          fnc: "Avatar",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot群头像[0-9]+$|^#抖音bot群头像[0-9]+$",
          fnc: "GroupAvatar",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot撤回[0-9]+(\\s+[0-9]+)?$|^#抖音bot撤回[0-9]+(\\s+[0-9]+)?$",
          fnc: "RecallSent",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot发送记录$|^#抖音bot发送记录$",
          fnc: "SentLog",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot陌生人$|^#抖音bot陌生人$",
          fnc: "Strangers",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot发图片.+|^#抖音bot发图片.+",
          fnc: "SendImage",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot群发图片.+|^#抖音bot群发图片.+",
          fnc: "SendGroupImage",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot拨打语音[0-9]+$|^#抖音bot拨打语音[0-9]+$",
          fnc: "CallVoice",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot正在输入[0-9]+$|^#抖音bot正在输入[0-9]+$",
          fnc: "SendTyping",
          permission: config.permission,
        },
      ],
    })
  }

  List() {
    this.reply(
      `共${config.token.length}个账号：\n${config.token.map(i => i.split(/:(.+)/s)[0]).join("\n")}`,
      true,
    )
  }

  /** 选定操作账号：优先事件来源账号，stdin 等场景回退第一个已连接账号 */
  botOf() {
    const self = Bot[this.e.self_id]
    if (self?.sdk) return self
    for (const token of config.token) {
      const b = Bot[token.split(/:(.+)/s)[0]]
      if (b?.sdk) return b
    }
    return undefined
  }

  /** 秒数转「X时Y分Z秒」 */
  fmtDuration(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    return `${h}时${m}分${s}秒`
  }

  async Status() {
    if (!config.token.length) return this.reply("暂无账号，请先使用 #抖音bot登录 扫码登录", true)
    const lines = [`DouYin 适配器（${adapter.version}）账号状态：`]
    for (const token of config.token) {
      const id = token.split(/:(.+)/s)[0]
      const b = Bot[id]
      if (!b) {
        lines.push(`\n▪ ${id}：离线（未连接或 cookie 已失效，请重新登录）`)
        continue
      }
      lines.push(
        [
          `\n▪ ${id}（${b.nickname}）：在线`,
          `运行时长：${this.fmtDuration(Date.now() / 1000 - b.stat.start_time)}`,
          `收发消息：收 ${b.stat.recv_msg_cnt} / 发 ${b.stat.sent_msg_cnt}`,
        ].join("\n"),
      )
    }
    const retry = Object.entries(adapter.reconnects).filter(([, n]) => n)
    if (retry.length) lines.push(`\n重连重试中：${retry.map(([id, n]) => `${id}（${n}次）`).join("、")}`)
    return this.reply(lines.join("\n"), true)
  }

  async Reconnect() {
    const id = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot重连|^#抖音bot重连/, "").trim()
    if (id) {
      const token = config.token.find(i => i.startsWith(`${id}:`))
      if (!token) return this.reply(`账号 ${id} 不存在`, true)
      this.reply(`正在重连账号 ${id}...`, true)
      const ok = await adapter.connect(token)
      return this.reply(ok ? `账号 ${id} 重连成功` : `账号 ${id} 重连失败，请检查日志或重新登录`, true)
    }
    if (!config.token.length) return this.reply("暂无账号", true)
    this.reply(`正在重连全部 ${config.token.length} 个账号...`, true)
    const rets = await Promise.allSettled(config.token.map(token => adapter.connect(token)))
    const ok = rets.filter(i => i.status === "fulfilled" && i.value).length
    return this.reply(`重连完成：成功 ${ok} / 共 ${config.token.length}`, true)
  }

  async FriendList() {
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const page = Math.max(1, Number(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot好友列表|^#抖音bot好友列表/, "").trim()) || 1)
    const friends = bot.getFriendArray()
    if (!friends.length) return this.reply("账号暂无好友或列表尚未加载完成", true)
    const size = 50
    const pages = Math.ceil(friends.length / size)
    if (page > pages) return this.reply(`共 ${pages} 页，请输入 1-${pages} 之间的页码`, true)
    const lines = friends
      .slice((page - 1) * size, page * size)
      .map(i => `${i.user_id} ${i.nickname}${i.uniqueId ? `（抖音号 ${i.uniqueId}）` : ""}`)
    return this.reply(`共 ${friends.length} 个好友，第 ${page}/${pages} 页：\n${lines.join("\n")}`)
  }

  async GroupList() {
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const page = Math.max(1, Number(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot群列表|^#抖音bot群列表/, "").trim()) || 1)
    const groups = bot.getGroupArray()
    if (!groups.length) return this.reply("账号暂无群聊或列表尚未加载完成", true)
    const size = 50
    const pages = Math.ceil(groups.length / size)
    if (page > pages) return this.reply(`共 ${pages} 页，请输入 1-${pages} 之间的页码`, true)
    const lines = groups
      .slice((page - 1) * size, page * size)
      .map(i => `${i.group_id} ${i.group_name}${i.member_count ? `（${i.member_count}人）` : ""}`)
    return this.reply(`共 ${groups.length} 个群聊，第 ${page}/${pages} 页：\n${lines.join("\n")}`)
  }

  async FindUser() {
    const key = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot查用户|^#抖音bot查用户/, "").trim()
    if (!key) return this.reply("用法：#抖音bot查用户 <uid|抖音号|短号|昵称>", true)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)

    let f = bot.fl.get(key)
    if (!f)
      for (const i of bot.fl.values())
        if (i.uniqueId === key || i.shortId === key || i.nickname === key) {
          f = i
          break
        }
    if (!f) {
      // 精确匹配失败时昵称模糊兜底，多命中仅提示候选
      const hit = [...bot.fl.values()].filter(i => i.nickname?.includes(key))
      if (!hit.length) return this.reply(`未找到「${key}」对应的用户`, true)
      if (hit.length > 1)
        return this.reply(
          `匹配到 ${hit.length} 个用户，请精确输入：\n${hit.slice(0, 5).map(i => `${i.user_id} ${i.nickname}`).join("\n")}`,
        )
      f = hit[0]
    }

    // 有 secUid 时拉实时资料补全签名/抖音号，失败回落缓存
    let profile
    if (f.secUid) {
      try {
        ;[profile] = await bot.sdk.user.info([f.secUid])
      } catch {}
    }
    const info = { ...f, ...profile }
    return this.reply(
      [
        "用户信息：",
        `昵称：${info.nickname}`,
        `uid：${info.user_id || f.uid}`,
        info.uniqueId ? `抖音号：${info.uniqueId}` : undefined,
        info.shortId ? `短号：${info.shortId}` : undefined,
        info.signature ? `签名：${info.signature}` : undefined,
        info.secUid ? `secUid：${info.secUid}` : undefined,
      ]
        .filter(s => s !== undefined)
        .join("\n"),
      true,
    )
  }

  async SendTo() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot发消息|^#抖音bot发消息/, "").trim()
    const match = raw.match(/^([0-9]+)[\s\n]+([\s\S]+)/)
    if (!match) return this.reply("用法：#抖音bot发消息 uid 内容", true)
    const [, uid, text] = match
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.fl.has(uid)) return this.reply(`账号 ${bot.uin} 的好友列表中不存在 ${uid}，可先 #抖音bot查用户${uid} 确认`, true)
    const ret = await bot.pickFriend(uid).sendMsg(text)
    if (!ret || ret.error?.length) return this.reply(`发送失败：${ret?.error?.[0]?.message || "未知错误"}`, true)
    trackSent(bot, { ...bot.fl.get(uid), user_id: uid }, ret)
    const mid = ret.message_id?.[0]
    return this.reply(`已向 ${uid} 发送消息${mid ? `（消息id：${mid}，可用 #抖音bot撤回 撤回）` : ""}`, true)
  }

  async SendGroupTo() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot发群消息|^#抖音bot发群消息/, "").trim()
    const match = raw.match(/^([0-9]+)[\s\n]+([\s\S]+)/)
    if (!match) return this.reply("用法：#抖音bot发群消息 群号 内容", true)
    const [, gid, text] = match
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.gl.has(gid)) return this.reply(`账号 ${bot.uin} 的群列表中不存在 ${gid}，可先 #抖音bot群列表 确认`, true)
    const ret = await bot.pickGroup(gid).sendMsg(text)
    if (!ret || ret.error?.length) return this.reply(`发送失败：${ret?.error?.[0]?.message || "未知错误"}`, true)
    trackSent(bot, { ...bot.gl.get(gid), group_id: gid }, ret)
    const mid = ret.message_id?.[0]
    return this.reply(`已向群 ${gid} 发送消息${mid ? `（消息id：${mid}，可用 #抖音bot撤回 撤回）` : ""}`, true)
  }

  /** 解析「数字id [数字参数]」形态，返回 [id, 参数] */
  parseIds(str) {
    const m = String(str).trim().match(/^([0-9]+)(?:[\s\n]+([0-9]+))?/)
    return m ? [m[1], m[2]] : []
  }

  async FriendRequests() {
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    let list
    try {
      // status 1 为待处理（与入群申请一致）
      list = await bot.sdk.frd.requests(1)
    } catch {}
    // SDK 通道失败或返回异常时，回落运行期事件累积的申请列表
    if (!Array.isArray(list))
      list = bot.request_list
        .filter(i => i.request_type === "friend")
        .map(i => ({ applicantUid: i.user_id, applicantNickname: i.nickname, content: i.comment }))
    list = list.filter(i => i.status === undefined || i.status === 1)
    if (!list.length) return this.reply("暂无待处理的好友申请", true)
    const lines = list
      .slice(0, 20)
      .map(i => `${i.applicantUid} ${i.applicantNickname || ""}${i.content ? `：${i.content}` : ""}`)
    return this.reply(
      `共 ${list.length} 条好友申请${list.length > 20 ? "（仅显示前 20 条）" : ""}：\n${lines.join("\n")}\n处理：#抖音bot同意好友/拒绝好友uid`,
      true,
    )
  }

  async handleFriendRequest(approve) {
    const uid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot(同意|拒绝)好友|^#抖音bot(同意|拒绝)好友/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    try {
      const ret = approve ? await bot.approveFriend(uid) : await bot.rejectFriend(uid)
      if (!ret) return this.reply(`处理失败：${uid}（申请可能已失效）`, true)
      // 同意后刷新好友列表缓存
      if (approve) adapter.loadFriend(bot.uin).catch(() => {})
      return this.reply(`已${approve ? "同意" : "拒绝"}好友申请：${uid}`, true)
    } catch (err) {
      return this.reply(`处理失败：${err.message || err}`, true)
    }
  }

  async ApproveFriend() {
    return this.handleFriendRequest(true)
  }

  async RejectFriend() {
    return this.handleFriendRequest(false)
  }

  async GroupRequests() {
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const gid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot入群申请|^#抖音bot入群申请/, "").trim()
    let list = []
    if (gid) {
      if (!bot.gl.has(gid)) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
      // 与 makeRequest 一致：入群申请按群（conversationShortId）查询，仅取待处理（status 1）
      list = (await bot.sdk.grp.requests(gid).catch(() => [])) || []
      list = list.filter(i => i.status === 1)
    } else {
      // 未指定群号时展示运行期收到的申请
      list = bot.request_list
        .filter(i => i.request_type === "group")
        .map(i => ({ requestId: i.raw?.requestId, applicantUid: i.user_id, applicantNickname: i.nickname, content: i.comment }))
    }
    if (!list.length)
      return this.reply(gid ? `群 ${gid} 暂无待处理的入群申请` : "暂无入群申请记录，指定群号可查询全量待处理列表：#抖音bot入群申请<群号>", true)
    const lines = list
      .slice(0, 20)
      .map(i => `${i.requestId || "?"} ${i.applicantUid || "?"} ${i.applicantNickname || ""}${i.content ? `：${i.content}` : ""}`)
    return this.reply(
      `共 ${list.length} 条入群申请${list.length > 20 ? "（仅显示前 20 条）" : ""}：\n${lines.join("\n")}\n处理：#抖音bot同意入群/拒绝入群requestId`,
      true,
    )
  }

  async handleGroupRequest(approve) {
    const requestId = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot(同意|拒绝)入群|^#抖音bot(同意|拒绝)入群/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    try {
      const ret = approve ? await bot.approveGroup(requestId) : await bot.rejectGroup(requestId)
      if (!ret) return this.reply(`处理失败：${requestId}（申请可能已失效）`, true)
      return this.reply(`已${approve ? "同意" : "拒绝"}入群申请：${requestId}`, true)
    } catch (err) {
      return this.reply(`处理失败：${err.message || err}`, true)
    }
  }

  async ApproveGroup() {
    return this.handleGroupRequest(true)
  }

  async RejectGroup() {
    return this.handleGroupRequest(false)
  }

  async GroupInfo() {
    const [gid] = this.parseIds(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot群资料|^#抖音bot群资料/, ""))
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!gid || !bot.gl.has(gid)) return this.reply("用法：#抖音bot群资料 群号", true)
    const info = await bot.pickGroup(gid).getInfo().catch(err => (Bot.makeLog("warn", ["群资料获取失败", err], bot.uin), undefined))
    if (!info?.group_id) return this.reply("群资料获取失败", true)
    const ownerNick = bot.fl.get(info.ownerUid)?.nickname || bot.gml.get(gid)?.get(info.ownerUid)?.nickname
    return this.reply(
      [
        "群资料：",
        `群号：${gid}`,
        `名称：${info.group_name || "未知"}`,
        info.member_count ? `成员数：${info.member_count}` : undefined,
        info.ownerUid ? `群主：${info.ownerUid}${ownerNick ? `（${ownerNick}）` : ""}` : undefined,
      ]
        .filter(s => s !== undefined)
        .join("\n"),
      true,
    )
  }

  async GroupMembers() {
    const [gid, pageArg] = this.parseIds(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot群成员|^#抖音bot群成员/, ""))
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!gid || !bot.gl.has(gid)) return this.reply("用法：#抖音bot群成员 群号 [页码]", true)
    const chatId = bot.gl.get(gid)?.chatId
    let members = await bot.sdk.grp.members(chatId).catch(err => (Bot.makeLog("warn", ["群成员列表获取失败", err], bot.uin), undefined))
    // 实时列表失败时回落 gml 缓存
    if (!Array.isArray(members) || !members.length) {
      members = [...(bot.gml.get(gid)?.values() || [])]
      if (!members.length) return this.reply("群成员列表获取失败", true)
    }
    // 成员列表（605）不含昵称：优先 gml/fl 缓存，缺昵称的按 secUid 批量补全（50/批）并落库
    const gml = bot.gml.get(gid)
    const infoMap = await adapter.fetchUserInfo(
      bot.uin,
      members.filter(i => i.secUid && !gml?.get(i.uid)?.nickname && !bot.fl.get(i.uid)?.nickname).map(i => i.secUid),
    )
    const rows = members.map(i => {
      const cached = gml?.get(i.uid)
      const u = infoMap.get(i.secUid)
      return { user_id: i.uid, nickname: cached?.nickname || bot.fl.get(i.uid)?.nickname || u?.nickname || i.uid, role: i.role ?? cached?.role }
    })
    if (gml)
      for (const [idx, m] of members.entries())
        if (m.secUid && !gml.get(m.uid)?.nickname)
          await gml
            .set(m.uid, { ...gml.get(m.uid), user_id: m.uid, secUid: m.secUid, nickname: rows[idx].nickname, role: m.role ?? gml.get(m.uid)?.role })
            .catch(() => {})
    const page = Math.max(1, Number(pageArg) || 1)
    const size = 50
    const pages = Math.ceil(rows.length / size)
    if (page > pages) return this.reply(`共 ${pages} 页，请输入 1-${pages} 之间的页码`, true)
    const roleText = { 1: "群主", 2: "管理员", 3: "管理员" }
    const lines = rows.slice((page - 1) * size, page * size).map(i => `${i.user_id} ${i.nickname}${roleText[i.role] ? `（${roleText[i.role]}）` : ""}`)
    return this.reply(`群 ${gid} 共 ${rows.length} 名成员，第 ${page}/${pages} 页：\n${lines.join("\n")}`)
  }

  async GroupSearch() {
    const key = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot找群|^#抖音bot找群/, "").trim()
    if (!key) return this.reply("用法：#抖音bot找群 <群名关键词>", true)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const hit = bot.getGroupArray().filter(i => i.group_name?.includes(key))
    if (!hit.length) return this.reply(`未找到群名包含「${key}」的群`, true)
    const lines = hit.slice(0, 20).map(i => `${i.group_id} ${i.group_name}`)
    return this.reply(`匹配到 ${hit.length} 个群${hit.length > 20 ? "（仅显示前 20 个）" : ""}：\n${lines.join("\n")}`, true)
  }

  async SetGroupName() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot改群名|^#抖音bot改群名/, "").trim()
    const m = raw.match(/^([0-9]+)[\s\n]*([\s\S]+)/)
    if (!m) return this.reply("用法：#抖音bot改群名 群号 新群名", true)
    const [, gid, name] = m
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.gl.has(gid)) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    try {
      const ret = await bot.pickGroup(gid).setGroupName(name)
      if (ret?.statusCode !== 0) return this.reply(`改名失败：${ret?.statusMsg || ret?.statusCode || "未知错误"}（需群主/管理员权限）`, true)
      return this.reply(`已将群 ${gid} 改名为「${name}」`, true)
    } catch (err) {
      return this.reply(`改名失败：${err.message || err}（需群主/管理员权限）`, true)
    }
  }

  async KickMember() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot踢人|^#抖音bot踢人/, "").trim()
    const m = raw.match(/^([0-9]+)[\s\n]+([0-9]+)$/)
    if (!m) return this.reply("用法：#抖音bot踢人 群号 uid", true)
    const [, gid, uid] = m
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const chatId = bot.gl.get(gid)?.chatId
    if (!chatId) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    try {
      const ret = await bot.sdk.grp.removeMembers(chatId, [uid])
      if (ret?.statusCode !== undefined && ret.statusCode !== 0)
        return this.reply(`踢出失败：${ret.statusMsg || ret.statusCode}（需群主/管理员权限）`, true)
      return this.reply(`已将 ${uid} 移出群 ${gid}`, true)
    } catch (err) {
      return this.reply(`踢出失败：${err.message || err}（需群主/管理员权限）`, true)
    }
  }

  async InviteMembers() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot拉人|^#抖音bot拉人/, "").trim()
    const m = raw.match(/^([0-9]+)[\s\n]+([0-9][0-9,，、\s\n]*)$/)
    if (!m) return this.reply("用法：#抖音bot拉人 群号 uid[,uid...]", true)
    const [, gid, uidStr] = m
    const uids = uidStr.split(/[,，、\s\n]+/).filter(Boolean)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const chatId = bot.gl.get(gid)?.chatId
    if (!chatId) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    try {
      const ret = await bot.addGroupMembers(chatId, uids)
      if (ret?.statusCode !== undefined && ret.statusCode !== 0)
        return this.reply(`邀请失败：${ret.statusMsg || ret.statusCode}`, true)
      return this.reply(`已向群 ${gid} 邀请 ${uids.length} 名成员`, true)
    } catch (err) {
      return this.reply(`邀请失败：${err.message || err}`, true)
    }
  }

  async QuitGroup() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot退群|^#抖音bot退群/, "").trim()
    const m = raw.match(/^([0-9]+)\s*(确认)?$/)
    if (!m) return this.reply("用法：#抖音bot退群 群号 确认", true)
    const [, gid, sure] = m
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.gl.has(gid)) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    if (!sure)
      return this.reply(
        `将退出群 ${gid}（${bot.gl.get(gid)?.group_name || "未知群名"}），退群后本号无法再接收该群消息，请回复 #抖音bot退群${gid} 确认`,
        true,
      )
    try {
      await bot.pickGroup(gid).quit()
      // 退群后从缓存移除，等待下次刷新同步
      await bot.gl.delete(gid).catch(() => {})
      return this.reply(`已退出群 ${gid}`, true)
    } catch (err) {
      return this.reply(`退群失败：${err.message || err}`, true)
    }
  }

  async ChatHistory() {
    const [id, cntArg] = this.parseIds(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot聊天记录|^#抖音bot聊天记录/, ""))
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!id) return this.reply("用法：#抖音bot聊天记录 uid/群号 [条数]", true)
    const isGroup = bot.gl.has(id)
    if (!isGroup && !bot.fl.has(id)) return this.reply(`${id} 不在好友/群列表中，可先 #抖音bot群列表 或 #抖音bot好友列表 确认`, true)
    const cnt = Math.min(20, Math.max(1, Number(cntArg) || 10))
    const msgs = await (isGroup ? bot.pickGroup(id) : bot.pickFriend(id))
      .getChatHistory(cnt)
      .catch(err => (Bot.makeLog("warn", ["聊天记录获取失败", err], bot.uin), undefined))
    if (!msgs?.length) return this.reply("聊天记录获取失败或暂无记录", true)
    const lines = msgs.map(i => {
      const nick = bot.fl.get(i.user_id)?.nickname || bot.gml.get(id)?.get(i.user_id)?.nickname || i.user_id
      const time = i.time ? `[${new Date(i.time * 1000).toLocaleString("zh-CN", { hour12: false })}] ` : ""
      return `${time}${nick}：${i.raw_message || "[空消息]"}`
    })
    return this.reply(`最近 ${msgs.length} 条记录${isGroup ? `（群 ${id}）` : ""}：\n${lines.join("\n")}`)
  }

  async Avatar() {
    const uid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot头像|^#抖音bot头像/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.fl.has(uid)) return this.reply(`好友 ${uid} 不在列表中，可先 #抖音bot好友列表 确认`, true)
    const url = await bot.pickFriend(uid).getAvatarUrl().catch(() => undefined)
    if (!url) return this.reply("头像获取失败", true)
    return this.reply([`用户 ${uid} 头像：`, segment.image(url)], true)
  }

  async GroupAvatar() {
    const gid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot群头像|^#抖音bot群头像/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.gl.has(gid)) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    const url = bot.pickGroup(gid).getAvatarUrl()
    if (!url) return this.reply("群头像尚未缓存，可先 #抖音bot群资料<群号> 拉取后再试", true)
    return this.reply([`群 ${gid} 头像：`, segment.image(url)], true)
  }

  async RecallSent() {
    const [a, b] = this.parseIds(this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot撤回|^#抖音bot撤回/, ""))
    if (!a) return this.reply("用法：#抖音bot撤回 消息id，或 #抖音bot撤回 uid/群号 消息id", true)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    let mid = a
    let data
    if (b) {
      // 指定会话：uid/群号 + 消息id
      const chatId = bot.fl.get(a)?.chatId || bot.gl.get(a)?.chatId
      if (!chatId) return this.reply(`${a} 不在好友/群列表中，无法定位会话`, true)
      data = {
        bot,
        self_id: bot.uin,
        ...(bot.gl.has(a) ? { group_id: a } : { user_id: a }),
        chatId,
      }
      mid = b
    } else {
      const rec = sentRecall.get(mid)
      if (!rec)
        return this.reply(`未找到消息 ${mid} 的发送记录，仅支持撤回本插件指令发送的消息（保留最近 200 条），或指定会话：#抖音bot撤回 uid 消息id`, true)
      const owner = Bot[rec.self_id]
      if (!owner?.sdk) return this.reply("消息所属账号已离线，无法撤回", true)
      data = { bot: owner, ...rec }
    }
    const rets = await adapter.recallMsg(data, mid)
    if (!rets?.[0]) return this.reply(`撤回失败：${mid}（可能超出时限或无权限）`, true)
    sentRecall.delete(mid)
    return this.reply(`已撤回消息 ${mid}`, true)
  }

  async SentLog() {
    if (!sentRecall.size) return this.reply("暂无经指令发送的消息记录", true)
    const lines = [...sentRecall.entries()]
      .slice(-20)
      .reverse()
      .map(
        ([mid, r]) =>
          `${mid} → ${r.group_id ? `群 ${r.group_id}` : `好友 ${r.user_id}`}（${new Date(r.time).toLocaleString("zh-CN", { hour12: false })}）`,
      )
    return this.reply(
      `共 ${sentRecall.size} 条发送记录（最近 20 条）：\n${lines.join("\n")}\n撤回：#抖音bot撤回<消息id>`,
      true,
    )
  }

  async Strangers() {
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const list = await bot.getStrangers().catch(() => undefined)
    if (!Array.isArray(list)) return this.reply("陌生人列表获取失败", true)
    if (!list.length) return this.reply("暂无陌生人会话", true)
    const lines = list
      .slice(0, 20)
      .map(i => `${i.uid || i.userId || i.user_id || "?"} ${i.nickname || ""}`.trim())
    return this.reply(
      `共 ${list.length} 个陌生人${list.length > 20 ? "（仅显示前 20 个）" : ""}：\n${lines.join("\n")}`,
      true,
    )
  }

  async SendImage() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot发图片|^#抖音bot发图片/, "").trim()
    const m = raw.match(/^([0-9]+)[\s\n]+(\S+)/)
    if (!m) return this.reply("用法：#抖音bot发图片 uid 图片链接", true)
    const [, uid, url] = m
    if (!/^https?:\/\//i.test(url)) return this.reply("仅支持 http(s) 图片链接", true)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.fl.has(uid)) return this.reply(`好友 ${uid} 不在列表中，可先 #抖音bot好友列表 确认`, true)
    const ret = await bot.pickFriend(uid).sendMsg([segment.image(url)])
    if (!ret || ret.error?.length) return this.reply(`发送失败：${ret?.error?.[0]?.message || "未知错误"}`, true)
    trackSent(bot, { ...bot.fl.get(uid), user_id: uid }, ret)
    return this.reply(`已向 ${uid} 发送图片`, true)
  }

  async SendGroupImage() {
    const raw = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot群发图片|^#抖音bot群发图片/, "").trim()
    const m = raw.match(/^([0-9]+)[\s\n]+(\S+)/)
    if (!m) return this.reply("用法：#抖音bot群发图片 群号 图片链接", true)
    const [, gid, url] = m
    if (!/^https?:\/\//i.test(url)) return this.reply("仅支持 http(s) 图片链接", true)
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    if (!bot.gl.has(gid)) return this.reply(`群 ${gid} 不在群列表中，可先 #抖音bot群列表 确认`, true)
    const ret = await bot.pickGroup(gid).sendMsg([segment.image(url)])
    if (!ret || ret.error?.length) return this.reply(`发送失败：${ret?.error?.[0]?.message || "未知错误"}`, true)
    trackSent(bot, { ...bot.gl.get(gid), group_id: gid }, ret)
    return this.reply(`已向群 ${gid} 发送图片`, true)
  }

  async CallVoice() {
    const uid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot拨打语音|^#抖音bot拨打语音/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const chatId = bot.fl.get(uid)?.chatId
    if (!chatId) return this.reply(`好友 ${uid} 不在列表中或无会话信息`, true)
    try {
      await bot.callVoice(chatId, uid)
      return this.reply(`已向 ${uid} 发起语音通话邀请`, true)
    } catch (err) {
      return this.reply(`语音通话发起失败：${err.message || err}`, true)
    }
  }

  async SendTyping() {
    const uid = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot正在输入|^#抖音bot正在输入/, "").trim()
    const bot = this.botOf()
    if (!bot) return this.reply("暂无在线账号", true)
    const chatId = bot.fl.get(uid)?.chatId
    if (!chatId) return this.reply(`好友 ${uid} 不在列表中或无会话信息`, true)
    try {
      await bot.sendTyping(chatId, true)
      return this.reply(`已向 ${uid} 展示「正在输入」状态`, true)
    } catch (err) {
      return this.reply(`发送输入状态失败：${err.message || err}`, true)
    }
  }

  Help() {
    return this.reply(
      [
        "DouYin 适配器指令：",
        "—— 账号 ——",
        "#抖音bot账号 查看账号列表",
        "#抖音bot登录 扫码登录账号",
        "#抖音bot状态 查看在线状态与收发统计",
        "#抖音bot重连[uid] 重连指定或全部账号",
        "#抖音bot删除uid 删除账号并断开连接",
        "—— 列表查询 ——",
        "#抖音bot好友列表[页码] 查看好友列表",
        "#抖音bot群列表[页码] 查看群列表",
        "#抖音bot群成员<群号>[页码] 查看群成员",
        "#抖音bot群资料<群号> 查看群资料",
        "#抖音bot查用户<uid|抖音号|昵称> 查询用户信息",
        "#抖音bot找群<群名关键词> 搜索群聊",
        "#抖音bot头像<uid> / 群头像<群号> 查看头像",
        "#抖音bot聊天记录<uid|群号>[条数] 查看聊天记录",
        "#抖音bot陌生人 查看陌生人会话",
        "—— 消息 ——",
        "#抖音bot发消息<uid><内容> 给好友发消息",
        "#抖音bot发群消息<群号><内容> 给群发消息",
        "#抖音bot发图片<uid><链接> / 群发图片<群号><链接>",
        "#抖音bot撤回<消息id> 撤回已发送消息",
        "#抖音bot发送记录 查看近期发送记录",
        "—— 申请 ——",
        "#抖音bot好友申请 / 入群申请[群号] 查看申请",
        "#抖音bot同意好友/拒绝好友<uid> 处理好友申请",
        "#抖音bot同意入群/拒绝入群<requestId> 处理入群申请",
        "—— 群管理 ——",
        "#抖音bot改群名<群号><名称> 修改群名",
        "#抖音bot踢人<群号><uid> 移出成员",
        "#抖音bot拉人<群号><uid,uid> 邀请成员",
        "#抖音bot退群<群号>确认 退出群聊",
        "—— 其他 ——",
        "#抖音bot拨打语音<uid> 发起语音通话",
        "#抖音bot正在输入<uid> 展示输入状态",
        "#抖音bot更新 / 更新日志 更新插件",
      ].join("\n"),
      true,
    )
  }

  async Login() {
    if (adapter.logining) return this.reply("已有登录流程进行中", true)
    // 登录频控冷却：check_qrconnect error_code=7 后服务端持续限流，冷却期内重试只会续住频控
    if (adapter.loginCooldown > Date.now())
      return this.reply(`登录触发频控冷却，服务端限流一般 10-30 分钟解除，请 ${Math.ceil((adapter.loginCooldown - Date.now()) / 60000)} 分钟后再试`, true)
    adapter.logining = true

    try {
      const session = await douyin.login({
        onQr: async qr => {
          if (this.e.adapter_id === "stdin") {
            logger.info(`请使用抖音 App 扫码登录\n${await QRCode.toString(qr.url, { type: "terminal", small: true })}`)
            return
          }
          const base64 = (qr.base64 || (await QRCode.toBuffer(qr.url)).toString("base64")).replace(
            /^data:image\/\w+;base64,/,
            "",
          )
          this.reply(["请使用抖音 App 扫码登录", segment.image(`base64://${base64}`)])
        },
        // 触发短信/密码二次验证：交互式等待用户直接回复验证码/密码，5 分钟超时
        onMfa: info =>
          new Promise((resolve, reject) => {
            const wait = { kind: info.kind, resolve, reject, userId: this.e.user_id }
            if (info.kind === "password")
              this.reply("登录触发密码二次验证，请直接回复账号密码完成验证", true)
            else
              this.reply(
                `登录触发短信二次验证，验证码已发送${info.maskedMobile ? `（尾号 ${info.maskedMobile.slice(-4)}）` : ""}，请直接回复 6 位验证码`,
                true,
              )
            adapter.mfaWait = wait
            setTimeout(() => {
              if (adapter.mfaWait !== wait) return
              adapter.mfaWait = null
              reject(new Error("二次验证等待超时"))
            }, 5 * 60000)
          }),
      })

      // 落盘本次登录使用的设备身份（未注入时由 login 注册），供紧随其后的 connect 复用，避免重复注册触发二次验证
      adapter.saveDevice(session.userId, session.device)

      const token = `${session.userId}:${session.cookie}`
      if (await adapter.connect(token)) {
        config.token = config.token.filter(i => !i.startsWith(`${session.userId}:`))
        config.token.push(token)
        this.reply(`账号 ${session.userId} 连接成功`, true)
        return configSave()
      }
      this.reply("账号连接失败", true)
      return false
    } catch (err) {
      // 抖音服务端频控（error_code=7 访问太频繁）：多由短时间内反复扫码/发码重试、同 IP 多账号叠加请求触发，
      // SDK 已按致命错误终止轮询；此处设置冷却并给出指引，避免立即重试加重限流
      if (/error_code=7|访问太频繁/.test(String(err.message || err))) {
        adapter.loginCooldown = Date.now() + 10 * 60000
        this.reply(
          [
            "登录触发抖音服务端频控（访问太频繁）",
            "常见原因：短时间内多次扫码重试、发验证码后请求过密、同 IP 多账号连接时叠加登录",
            "服务端限流一般 10-30 分钟自行解除，已设置 10 分钟登录冷却",
            "期间请勿反复扫码重试，冷却结束后再 #抖音bot登录",
          ].join("\n"),
          true,
        )
        return false
      }
      this.reply(`登录失败：${err.message || err}`, true)
      return false
    } finally {
      adapter.logining = false
    }
  }

  /** 登录二次验证交互：等待期间直接回复验证码/密码即可，无需额外命令 */
  async accept(e) {
    const wait = adapter.mfaWait
    if (!wait) return
    // 仅拦截登录发起者本人的消息；无法确认发起者（如终端登录）时不限制
    if (wait.userId && e.user_id && String(e.user_id) !== String(wait.userId)) return
    const msg = e.msg?.trim()
    if (!msg || msg.startsWith("#")) return
    // 短信验证码要求纯数字（4-6 位），密码等其他验证接受任意非指令文本
    if (wait.kind === "sms" && !/^\d{4,6}$/.test(msg)) return
    adapter.mfaWait = null
    wait.resolve(msg)
    // 拦截该消息，避免验证码被其他插件当作普通消息处理
    return "return"
  }

  async Update() {
    // 复用核心更新插件（#更新DouYin），支持更新日志、依赖更新与更新后自动重启
    // 核心 update 类构造不接收参数，this.e 需按加载器 Object.assign(new ..., { e }) 方式手动绑定
    this.e.msg = "#更新DouYin"
    return Object.assign(new update(), { e: this.e }).update()
  }

  async UpdateLog() {
    this.e.msg = "#更新日志DouYin"
    return Object.assign(new update(), { e: this.e }).updateLog()
  }

  async Del() {
    const id = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot删除|^#抖音bot删除/, "").trim()
    const token = config.token.find(i => i.startsWith(`${id}:`))
    if (!token) return this.reply("账号不存在", true)

    config.token = config.token.filter(i => i !== token)
    await this.removeBot(id)
    this.reply(`账号已删除，共${config.token.length}个账号`, true)
    return configSave()
  }
}

logger.info(logger.green("- DouYin 适配器插件 加载完成"))
