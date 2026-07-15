# Oh-My-Pi Telegram Search Bot

一个使用 Telegram Long Polling 的频道成员专用搜索 Bot。它将 Oh-My-Pi 嵌入 Bun 进程，支持联网搜索、图片理解、回复链追问和持久任务队列。

## 功能

- 在频道关联讨论群中发送 `@BotUsername 问题`。
- 回复 Bot 的回答直接追问，不必再次提及 Bot。
- 回复其他成员的文字或图片并 `@BotUsername 新问题`。
- 支持 JPEG、PNG、WebP；每张 10 MB、每次最多 4 张。
- 回复链和图片默认保留 24 小时。
- 只允许目标频道的当前成员使用。

## 准备 Telegram

1. 使用 BotFather 创建 Bot，并允许加入群组。
2. 将 Bot 添加为目标频道和关联讨论群的管理员。
3. 记录频道与讨论群的数字 ID（通常以 `-100` 开头）。
4. 本服务启动时会删除该 Bot 现有的 Webhook 配置，但保留尚未处理的 updates。

Bot 必须是讨论群管理员才能收到普通的 `@mention` 文本；业务代码仍会忽略没有提及 Bot 的新消息。

## 配置

```bash
cp .env.example .env
```

填写：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_DISCUSSION_GROUP_ID`
- `OMP_MODEL`，格式通常为 `provider/model-id`
- 模型供应商 API Key
- 至少一个 Oh-My-Pi 搜索供应商 API Key

可选设置 `TELEGRAM_CHANNEL_ID`：设置后，只有该频道的成员能在群里使用 Bot；不设置时，目标群里的成员可以直接使用。

`OMP_MODEL` 应支持图片输入。`OMP_SEARCH_PROVIDER=auto` 会使用 Oh-My-Pi 的可用搜索供应商回退链。
图片默认每张最多 10 MB、每次合计最多 20 MB，可用 `MAX_IMAGE_BYTES` 和 `MAX_TOTAL_IMAGE_BYTES` 调整。

## 本地运行

要求 Bun 1.3.14+：

```bash
bun install
bun run check
bun test
bun run start
```

## Docker

```bash
mkdir -p runtime/data runtime/omp-agent
sudo chown -R 1000:1000 runtime
docker compose pull
docker compose up -d
docker compose logs -f bot
```

也可以直接使用 GitHub Actions 发布到 GHCR 的镜像：

```bash
docker pull ghcr.io/yoisakiknd/omp-search-agent:latest
```

每次推送到 `main` 会运行类型检查和测试，并构建 `linux/amd64`、`linux/arm64` 镜像；`v*` 标签会生成对应版本镜像标签。

服务不监听端口，只需出站访问 Telegram、模型和搜索供应商。SQLite、回复链和标准化图片保存在 `runtime/data`，Oh-My-Pi 的 `models.yml` 放在 `runtime/omp-agent/models.yml`。

## 运维

- 同一个 Bot Token 只能运行一个 polling 实例。
- 如果进程异常退出留下 `/data/bot.lock`，确认没有实例运行后再删除该文件。
- 容器健康检查要求 polling heartbeat 在 60 秒内更新。
- 日志只记录任务 ID、用户 ID、耗时和状态，不记录问题正文、图片或密钥。
