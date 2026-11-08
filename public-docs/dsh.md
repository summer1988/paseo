---
title: DeepSeek Harness
description: Use an installed DeepSeek Harness or DSH NEXT client from Paseo.
nav: DeepSeek Harness
order: 26
category: Providers
---

# DeepSeek Harness

Paseo drives DeepSeek Harness as a coding agent through the bundled `dsh-provider` plugin. Login, models, and API keys stay in the client home you select. Paseo does not embed the client's window.

## Install

Install one of these on the machine running the Paseo daemon:

- Official DeepSeek Harness: the `dsh` command, or the DeepSeek Harness desktop app. See [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- [DSH NEXT](https://github.com/anywhere-labs/dsh-desktop), a community desktop client. It is not a DeepSeek product.

Paseo searches `PATH`, the npm global prefix, and installed desktop apps. It does not download another copy of `@deepseek-ai/dsh`.

## Choose a client

In Paseo, open the DeepSeek Harness plugin settings and search for installed clients. Each row has two actions. Nothing starts until you choose.

## Build from an install

**Build from this client** starts a host that Paseo owns, using that install's host entry, profile, and home. The official CLI uses the `web` profile. Official desktop and DSH NEXT use the `desktop` profile, started through the app's `dsh-desktop-host` entry rather than `dsh web`. Closing Paseo stops only that host. A desktop app you already had open keeps running.

## Use a running client

**Use this running client** connects to a host that is already listening. Paste the loopback login link. Paseo exchanges it for a cookie immediately and does not save the link, the token, or the cookie. Paste a new link after the host restarts.

- `dsh web` prints the link in its own terminal.
- DSH NEXT shows the link in desktop settings after you enable local browser access.
- Official DeepSeek Harness desktop does not publish a login link. That row has no direct-use action. Build from the install instead.

Paseo does not read another process's output, Electron IPC, or cookie store to obtain a token.

## Login

Sign in with the client whose home you selected. A missing credential surfaces as `session/provider-credentials-unavailable`. If another client is already writing a session, Paseo shows `session/writer-held` and does not open a blank replacement.

## Limits

Paseo MCP tools are not injected. The host entry recorded from current DeepSeek Harness builds has no startup flag for that injection, and a client Paseo did not start cannot be given new servers after launch. Hub unattended execution stays off. A built host is stopped only when Paseo closes the connection it started; a client you attached to is never killed.
