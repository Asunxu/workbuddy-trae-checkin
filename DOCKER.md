# Docker 部署（Orange Pi / 任意 Linux 服务器）

在 Cloudflare Worker 版基础上加了 Node.js 宿主层：`worker.js` 一行不改，
由 `server.mjs` 提供三样平台能力——KV（磁盘 JSON，挂 volume 持久化）、
HTTP 服务、内置 cron 调度器（北京时间）。零 npm 依赖，镜像里只有 Node。

## 一、首次部署

```bash
cd workbuddy-trae-checkin

# 1. 准备配置
cp .env.example .env
# 编辑 .env：填 ADMIN_TOKEN，并生成 MASTER_KEY：
#   openssl rand -base64 32        ← 输出 44 字符、= 结尾，抄进 MASTER_KEY=
#   openssl rand -hex 24           ← 可选，抄进 CRON_SECRET=

# 2. 构建并启动
docker compose up -d --build

# 3. 验证
curl http://127.0.0.1:3009/api/health
```

然后浏览器打开 `http://服务器IP:3009`，用 `ADMIN_TOKEN` 登录，添加账号
（Trae 抖音扫码 / WorkBuddy 微信扫码 / Qoder 设备授权，用法同 Cloudflare 版）。

## 二、日常

```bash
docker compose logs -f --tail 50    # 看日志（含每天定时签到的结果）
docker compose restart              # 重启
docker compose up -d --build        # 改了代码后重建
tar -cf backup.tar data/            # 备份：账号令牌全在 data/kv.json（加密存储）
```

### 改登录密码 / 改任何 .env 变量

```bash
vi .env && docker compose up -d     # compose 会检测到变量变化，自动重建容器
```

> 注意 `docker restart` **不会**重新读取 `--env-file`/compose 环境变量——
> 环境变量在容器创建时就固定了，必须重建（compose 是 `up -d`，原生 docker 是先 `rm -f` 再 `run`）。
> 改密码不影响已添加的账号（令牌在 KV 里，跟登录密码是分开的）。

## 三、定时任务

由容器内置调度器执行，**北京时间**，不用换算 UTC。缺省两条：

- `10 8 * * *` —— 每天 08:10 三个平台各跑一遍
- `20 10 * * *` —— 10:20 给限流/漏签的补一轮（接口幂等，不会重复加分）

想改就在 `.env` 里设 `CRON_SCHEDULES`，多条用 `;` 分隔，改完 `docker compose up -d`。

也可以不靠内置 cron，用宿主机 crontab 调 `/cron` 接口（配 `CRON_SECRET`）：

```cron
10 8 * * * curl -s -X POST http://127.0.0.1:3009/cron -H "X-Cron-Secret: 你的CRON_SECRET" >/dev/null 2>&1
```

## 四、环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | ✅ | 控制台登录密码 |
| `MASTER_KEY` | ✅ | 32 字节 base64，加密所有令牌。**丢了只能全部重新扫码** |
| `CRON_SECRET` | 可选 | `/cron` 独立口令，缺省回落用 `ADMIN_TOKEN` |
| `CRON_SCHEDULES` | 可选 | 北京时间 cron，多条 `;` 分隔 |
| `PORT` | 可选 | 监听端口，缺省 3009 |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | 可选 | Telegram 通知（也可之后在控制台里配，存 KV） |
| `QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_OPENID` / `QQ_SANDBOX` | 可选 | QQ 机器人通知 |
| `QODER_MACHINE_TOKEN` / `QODER_MACHINE_CODE` / `QODER_MACHINE_TYPE` | 可选 | Qoder 设备通行证 |

## 五、与 Cloudflare 版的差异

| | Cloudflare Worker 版 | Docker 版 |
| --- | --- | --- |
| 运行位置 | Cloudflare 边缘节点 | 自己的服务器/Orange Pi |
| KV | Cloudflare KV | `data/kv.json`（同样只存 AES-256-GCM 密文） |
| Cron | UTC 表达式 | 北京时间表达式，容器内置 |
| 启动自检 | 部署后打开页面才知道 | 启动即校验 `MASTER_KEY`/`ADMIN_TOKEN`，错了直接退出并提示 |
| 健康检查 | 无 | `GET /api/health`，免登录 |

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| 接口报 `EACCES ... kv.json.tmp`、添加不了账号 | 宿主机 `data/` 目录属主不对（容器以 uid 100 运行）：`chown -R 100:101 data/` 后重启容器 |
| 容器起来又退出 | `docker compose logs` 看自检输出：多半是 `MASTER_KEY` 格式不对（要 44 字符、`=` 结尾）或没填 `ADMIN_TOKEN` |
| `docker compose` 不认识 | 老版本 Docker 用 `docker-compose`（带横线），或装 `docker-compose-plugin` |
| 页面打不开 | 检查 `ports` 映射和防火墙；云服务器还要在安全组放行 3009 |
| 想换端口 | 改 `docker-compose.yml` 里的映射 `"3009:3009"` 左边那个 |
| Orange Pi 重启后服务没起 | `docker-compose.yml` 已带 `restart: unless-stopped`，确认容器不是被手动 stop 的 |
