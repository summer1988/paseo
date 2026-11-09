---
title: DeepSeek Harness
description: 在 Paseo 中使用已安装的 DeepSeek Harness 或 DSH NEXT 客户端。
nav: DeepSeek Harness
---

# DeepSeek Harness {#deepseek-harness}

Paseo 通过内置的 `dsh-provider` 插件把 DeepSeek Harness 当作 coding agent 驱动。登录、模型和 API key 留在你选中的客户端 home 里。Paseo 不嵌入该客户端的窗口。

模型菜单先列出已启用的提供方，提供方在配置文件上面。新开聊天时在这里选择 DeepSeek Harness。已经开始的聊天里选中它，会把这个提供方和模型留给下一次新聊天。

## 安装 {#install}

在运行 Paseo daemon 的机器上安装以下之一：

- 官方 DeepSeek Harness：`dsh` 命令，或 DeepSeek Harness 桌面应用。参见 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- [DSH NEXT](https://github.com/anywhere-labs/dsh-desktop)，社区桌面客户端。它不是 DeepSeek 的产品。

Paseo 检索 `PATH`、npm 全局前缀和已安装的桌面应用。它不会再下载一份 `@deepseek-ai/dsh`。

## 选择客户端 {#choose-a-client}

在 Paseo 中打开设置，选中这台主机，进入 Providers，再打开 DeepSeek Harness。在这个面板里粘贴本机浏览器地址，或选择已安装的客户端。诊断视图里有同样的控件。内置插件不会出现在插件列表里，所以这个 Provider 面板就是设置界面。每一行有两个动作。在你选择之前，什么都不会启动。

## 用安装构建 {#build-from-an-install}

**Build from this client** 用该安装自己的 Host 入口、profile 和 home 启动一个由 Paseo 拥有的 Host。官方 CLI 使用 `web` profile。官方桌面和 DSH NEXT 使用 `desktop` profile，通过应用里的 `dsh-desktop-host` 入口启动，而不是 `dsh web`。关闭 Paseo 只会停掉这个 Host。你原本开着的桌面应用继续运行。

## 直接使用正在运行的客户端 {#use-a-running-client}

**Use this running client** 连接到一个已经在监听的 Host。贴上本机登录链接。Paseo 立刻换取登录，不保存链接和 token。登录留在这台电脑上，所以 Paseo 自己重启后会重新连上。Host 自己重启后需要再贴一次新链接。

设置页顶部的 **Add this address** 接受浏览器地址栏里的本机地址，例如 `http://127.0.0.1:55461/?token=…`。已选中的客户端可以直接使用时用它，否则用唯一一个可以直接使用的客户端。有多个可以接受地址的客户端时，用正在运行的那一行。地址和 token 都不保存。

- `dsh web` 会在自己的终端里打印链接。
- DSH NEXT 在你打开本地浏览器访问之后，于桌面设置里给出链接。
- 官方 DeepSeek Harness 桌面不提供登录链接。这一行没有直接使用动作。改用该安装构建。

Paseo 不读取另一个进程的输出、Electron IPC 或 cookie 库来获取 token。

## 登录 {#login}

在你选中的那个客户端的 home 里登录。缺少凭据时会显示 `session/provider-credentials-unavailable`。如果另一个客户端正在写某个会话，Paseo 显示 `session/writer-held`，不会另开一个空会话代替它。

## 导入工作区 {#import-workspaces}

打开导入会话。DeepSeek Harness 已连接时，表单列出它的工作区。勾选要导入的工作区。Paseo 把这些目录里的用户会话导入到对应目录的工作区。已归档会话、空白会话和子代理会话不导入。一次工作区导入停在 200 条，这是导入分页的上限。

## 限制 {#limits}

Paseo 的 MCP 工具不会被注入。当前 DeepSeek Harness 构建里记录到的 Host 入口没有这项注入的启动参数，而 Paseo 没有启动的客户端也不能在启动之后再加 server。Hub 无人值守保持关闭。Paseo 只在关闭自己启动的连接时停掉构建出来的 Host；你直接使用的客户端不会被杀掉。
