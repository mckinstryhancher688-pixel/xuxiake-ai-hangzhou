# 旅行空间发布操作说明

本文件是待执行的发布步骤，不是生产发布记录。实际服务器尚未操作。保留现有百炼、飞猪和高德服务变量值与Agent配置。

## 构建与运行边界

Dockerfile固定Node 24.20.0，使用内置SQLite，单ECS、单应用进程，不增加Python或向量数据库。不要复用旧Node镜像中的node_modules来跳过本次锁文件安装。

本机已通过npm生产构建，尚未构建Docker镜像。拿到服务器入口后先在备用端口验证镜像及FlyAI CLI的Linux可用性，再切换Nginx。

在独立检出目录中运行：

```bash
docker build -t xuxiake-app:travel-workspace .
```

.dockerignore排除了环境文件、数据库、浏览器记录及私有备份。密钥只在运行时通过现有私有env文件注入，不作为构建参数。

新容器使用node用户。挂载现有卷前检查文件所有者与写权限，不要在未检查的情况下递归修改整个卷的权限。

## 切换前

1. 记录当前镜像、容器、端口、网络、Nginx配置及卷挂载，保留回退容器。
2. 停止写入后备份完整持久化目录，或采用SQLite在线备份加图片备份。包括旧快照、新SQLite、WAL和图片，不能只复制运行中的主数据库。
3. 保留xuxiake-data挂载到/app/.data；设置TRIP_DATA_DIR=/app/.data/trips，原PLAN_SNAPSHOT_FILE值保持。
4. 初次检查用卷的备份副本，TRIPS_ENABLED=0、TRIPS_WORKER_PAUSED=1，在备用端口检查旧页面和快照。不要让新旧两个应用进程同时写生产卷。
5. 准备HTTPS和可信Nginx反代头。新API拒绝生产明文HTTP；应用端口不能直接对公网开放，让客户端伪造x-forwarded-proto。

HTTPS反向代理至少需要：

```nginx
client_max_body_size 6m;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 120s;
```

保留现有/_AMapService路径。先核对证书和域名授权；本文件不替服务器签发证书或变更高德白名单。

## 小范围开放

1. 停止旧应用后，新容器连接正式卷及原网络。前后端来自同一个构建，先保持新入口关闭，验证旧路径、快照恢复和服务状态。
2. HTTPS与卷验证通过后，设置TRIPS_ENABLED=1、TRIPS_WORKER_PAUSED=0，小范围开放新入口。
3. 两个独立浏览器测试邀请、文字／截图整理、私有图片、资料问答、显式报价及真实核验，核对调用账本。
4. 更改个人底线，确认事实齐备时高德新增请求为零、旧确认失效、新版需要分别确认。
5. 重启应用，验证资料、成员、额度与确认恢复。结果未知的在途任务应显示失败待人工处理，不能自动重买。
6. 正式域名验证高德底图和真实折线；本地INVALID_USER_DOMAIN不代表正式域名已通过。
7. 记录部署提交、Build ID和脱敏结果后，才更新README的线上能力描述。

## 回退

关闭新入口并停止新应用，使用保留的旧镜像与原快照路径恢复；新SQLite和图片继续保留。回退不删除数据卷，不改写旧内容哈希，也不将新空间转换成旧JSON快照。
