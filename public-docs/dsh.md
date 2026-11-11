---
title: DeepSeek Harness
description: Use an installed DeepSeek Harness or DSH NEXT client from Paseo.
nav: DeepSeek Harness
order: 26
category: Providers
---

# DeepSeek Harness

Paseo drives DeepSeek Harness as a coding agent through the bundled `dsh-provider` plugin. Login, models, and API keys stay in the client home you select. Paseo does not embed the client's window.

The model menu lists every enabled provider before its models, with providers above profiles. Choose DeepSeek Harness there when you start a chat. Choosing it from a chat that is already running keeps that provider and model for the next new chat.

## Install

Install one of these on the machine running the Paseo daemon:

- Official DeepSeek Harness: the `dsh` command, or the DeepSeek Harness desktop app. See [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- [DSH NEXT](https://github.com/anywhere-labs/dsh-desktop), a community desktop client. It is not a DeepSeek product.

Paseo searches `PATH`, the npm global prefix, and installed desktop apps. It does not download another copy of `@deepseek-ai/dsh`.

## Choose a client

In Paseo, open Settings, choose this host, then Providers, then DeepSeek Harness. That sheet is where you paste a loopback browser address or pick an installed client. Its Diagnostic view has the same controls. Built-in plugins are not listed under Plugins, so this provider sheet is the setup screen. Each install row has two actions. Nothing starts until you choose.

## Build from an install

**Build from this client** starts a host that Paseo owns, using that install's host entry, profile, and home. The official CLI uses the `web` profile. Official desktop and DSH NEXT use the `desktop` profile, started through the app's `dsh-desktop-host` entry rather than `dsh web`. Closing Paseo stops only that host. A desktop app you already had open keeps running.

## Use a running client

**Use this running client** connects to a host that is already listening. Paste the loopback login link. Paseo exchanges it immediately and does not save the link or the token. The login stays on this computer, so Paseo reconnects after it restarts. Paste a new link after the host itself restarts.

**Add this address**, at the top of the same settings screen, takes the value from the browser address bar, for example `http://127.0.0.1:55461/?token=…`. It uses the selected client when that client can be used directly, and otherwise the only such client. When several clients can accept an address, use the row for the one that is running. The address and token are not saved.

- `dsh web` prints the link in its own terminal.
- DSH NEXT shows the link in desktop settings after you enable local browser access.
- Official DeepSeek Harness desktop does not publish a login link. That row has no direct-use action. Build from the install instead.

Paseo does not read another process's output, Electron IPC, or cookie store to obtain a token.

## Login

Sign in with the client whose home you selected. A missing credential surfaces as `session/provider-credentials-unavailable`. If another client is already writing a session, Paseo shows `session/writer-held` and does not open a blank replacement.

A new chat is created inside the DeepSeek workspace for the Paseo folder, so DSH NEXT lists it with that folder. It starts with workspace write. The access control beside the mode switches that session between workspace write and full access. Resuming a session leaves its workspace alone.

## Import workspaces

Open Import session. When DeepSeek Harness is connected, the sheet lists its workspaces. Check the ones to bring in. Paseo imports each user session in those directories into the workspace for that directory. Archived sessions, blank sessions, and subagent sessions stay out. A workspace import stops at 200 sessions, the import page limit.

## Team

Subagents and teammates show in that chat's subagents track. The list is the session catalog, so a child that has scrolled off the recent log page is still there, and its timeline includes the older pages of its own log. The row name is the catalog label, or the session id when a one-shot child has no label. Status follows the host: running while the host says so, completed when the child is idle and its last turn finished, and not running when it is idle for any other reason. A turn that ended in error does not mark the child failed. A teammate whose phase is failed stays failed. The subtitle is the session title, the mode, that activity, the token total, and how long the child has been active. An approval asked by a child appears on the parent chat under that child's name. Shared team tasks show in the task list with their pending, in-progress, or completed status, and a deleted task leaves the list. Other plugins read the same roster with `dsh.session.roster`, passing the DeepSeek session id or the provider session id. `dsh.session.roster.watch` pushes the roster when it changes.

## Limits

Paseo MCP tools are not injected. The host entry recorded from current DeepSeek Harness builds has no startup flag for that injection, and a client Paseo did not start cannot be given new servers after launch. Hub unattended execution stays off. A built host is stopped only when Paseo closes the connection it started; a client you attached to is never killed.
