# 星间中继网络 · 路由演练台（Interstellar Relay BGP Drill）

链路切换后，值班员逐步复核**乱序抵达**的路径通告与撤销的演练系统。零第三方依赖，仅使用 Node.js 20 内置模块。

## 它保证什么

- **至多 8 台路由器**（标识 0–7）、**至多 64 项事件**（通告 / 撤销 / 断开 / 重连 / 投递）。
- 有向邻接带**本地偏好（localPref）**与**链路纪元（epoch）**。
- 消息分两阶段：`announce`/`withdraw` 事件让消息进入“在途队列”，`deliver` 事件才在接收端处理——因此可以任意制造乱序。
- **投递前纪元核验**：接收端邻接当前纪元必须等于消息发送纪元，否则判定为“过期消息忽略”（stale）。断开 / 重连各自将纪元 +1；重连不恢复任何旧通告。
- **断开即摘除**：链路断开的瞬间，接收端来自该邻居的旧纪元入站路由全部清除，已断开邻居不会继续参与任何路由器的选路。
- **撤销语义**：仅移除同一邻居、同一前缀的对应通告；撤销先到则记录“无匹配”，不影响其它邻居。
- **环路拒绝**：AS 路径中含接收路由器标识的通告一律拒绝，不安装、不入选路。
- **稳定裁决**：本地偏好（高者）→ 路径长度（短者）→ 下一跳标识（小者）→ 通告序号，结果完全确定。
- **后台串行执行 + 检查点**：所有操作经队列串行处理，检查点以临时文件 + 原子 rename 落盘；每个演练有 `runId` 与单调保存序号，**迟到的旧演练写入不会覆盖新演练**。
- **页面重开恢复**：重开 / 重启后从检查点重放至最后完整步骤；每次返回状态都附带 `replayConsistent`，逐字节比对“实时推进”与“检查点重放”的 RIB/最优路径/在途队列，证明恢复回放与不中断回放收敛一致。

页面明确展示四类关键结果：`过期消息忽略`、`环路拒绝`、`撤销生效/无匹配`、`通告接受`，以及回放一致性徽标。

## 目录

```
server/engine.js   仿真引擎（校验、事件、纪元、撤销、环路、选路、检查点重放）
server/store.js    后台队列 + 原子检查点存储 + 迟到写防护
server/index.js    HTTP 服务（静态站点、API、/healthz）
public/            单页前端（无构建步骤）
test/              node:test 代码测试（20 项）
scripts/build.js   页面构建检查
scripts/verify.js  验收编排（测试 + 构建 + HTTP 冒烟）
```

## 本地运行

```bash
node server/index.js
# 自定义宿主端口 / 数据目录
PORT=9090 HOST=0.0.0.0 DATA_DIR=./data node server/index.js
```

打开 http://localhost:8080 ：左侧编辑 / 加载 JSON 配置，可单步、一次跑完、拖动定位任意一步；右侧查看邻接纪元、在途消息（过期项置灰划线）、各路由器入站路由与最优路径、事件复核日志。

### 配置格式

```json
{
  "routers": [0, 1, 2],
  "adjacencies": [{ "from": 0, "to": 1, "localPref": 100 }],
  "events": [
    { "type": "announce",   "from": 0, "to": 1, "prefix": "10.0.0.0/24", "asPath": [0] },
    { "type": "deliver",    "msgId": 1 },
    { "type": "withdraw",   "from": 0, "to": 1, "prefix": "10.0.0.0/24" },
    { "type": "disconnect", "from": 0, "to": 1 },
    { "type": "reconnect",  "from": 0, "to": 1 }
  ]
}
```

通告的 `asPath` 末跳必须为发送端；`msgId` 使用在途消息进入队列时的编号（页面表格第一列）。

## HTTP 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/healthz` | GET | 健康检查，含 `status` / `runId` / `step` / `uptime` |
| `/api/state` | GET | 当前完整状态（页面重开即调它恢复） |
| `/api/step` | POST | 执行下一步并落检查点 |
| `/api/run` | POST | 执行至收敛 |
| `/api/seek` | POST `{step}` | 从输入重放到指定步 |
| `/api/reset` | POST `{input?}` | 开始新演练（缺省为内置示例），产生新 runId |
| `/api/default-scenario` | GET | 内置示例 |

## Docker Compose

```bash
# 可配置宿主端口
HOST_PORT=9090 docker compose up -d --build
curl -s http://localhost:9090/healthz

# 验收服务：围绕旧纪元撤销、环路拒绝和恢复收敛运行代码测试，
# 检查页面构建并对站点及 /healthz 进行 HTTP 冒烟；
# 执行完成后退出，并以退出码报告验收结果（0 通过 / 1 失败）
docker compose run --rm verify
```

## 不使用 Docker 的验收

```bash
node scripts/verify.js   # = 代码测试 + 构建检查 + 真实起服 HTTP 冒烟
node --test test/        # 仅代码测试
node scripts/build.js    # 仅构建检查
```

内置示例场景（18 步）依次演示：偏好/长度裁决、环路拒绝、旧纪元撤销被忽略、断开摘除、新纪元重通告与同纪元撤销生效。
