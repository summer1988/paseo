---
title: DeepSeek Harness
description: 在 Paseo 中使用已安装的 DeepSeek Harness 或 DSH NEXT 客户端。
nav: DeepSeek Harness
---

# DeepSeek Harness {#deepseek-harness}

Paseo 通过内置的 `dsh-provider` 插件把 DeepSeek Harness 当作 coding agent 驱动。登录、模型和 API key 留在你选中的客户端 home 里。Paseo 不嵌入该客户端的窗口。

## 安装 {#install}

在运行 Paseo daemon 的机器上安装以下之一：

- 官方 DeepSeek Harness：`dsh` 命令，或 DeepSeek Harness 桌面应用。参见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- [DSH NEXT](https://github.com/anywhere-labs/dsh-desktop)，社区桌面客户端。它不是 DeepSeek 的产品。

Paseo 检索 `PATH`、npm 全局前缀和已安装的桌面应用。它不会再下载一份 `@deepseek-ai/dsh`。

## 选择客户端 {#choose-a-client}

在 Paseo 中打开 DeepSeek Harness 插件设置，搜索已安装的客户端。每一行有两个动作。在你选择之前，什么都不会启动。

## 用安装构建 {#build-from-an-install}

**Build from this client** 用该安装自己的 Host 入口、profile 和 home 启动一个由 Paseo 拥有的 Host。官方 CLI 使用 `web` profile。官方桌面和 DSH NEXT 使用 `desktop` profile，通过应用里的 `dsh-desktop-host` 入口启动，而不是 `dsh web`。关闭 Paseo 只会停掉这个 Host。你原本开着的桌面应用继续运行。

## 直接使用正在运行的客户端 {#use-a-running-client}

**Use this running client** 连接到一个已经在监听的 Host。贴上本机登录链接。Paseo 立刻用它换 cookie，不保存链接、token 或 cookie。Host 重启后需要再贴一次新链接。

- `dsh web` 会在自己的终端里打印链接。
- DSH NEXT 在你打开本地浏览器访问之后，于桌面设置里给出链接。
- 官方 DeepSeek Harness 桌面不提供登录链接。这一行没有直接使用动作。改用该安装构建。

Paseo 不读取另一个进程的输出、Electron IPC 或 cookie 库来获取 token。

## 登录 {#login}

在你选中的那个客户端的 home 里登录。缺少凭据时会显示 `session/provider-credentials-unavailable`。如果另一个客户端正在写某个会话，Paseo 显示 `session/writer-held`，不会另开一个空会话代替它。

## 限制 {#limits}

Paseo 的 MCP 工具不会被注入。当前 DeepSeek Harness 构建里记录到的 Host 入口没有这项注入的启动参数，而 Paseo 没有启动的客户端也不能在启动之后再加 server。Hub 无人值守保持关闭。Paseo 只在关闭自己启动的连接时停掉构建出来的 Host；你直接使用的客户端不会被杀掉。
