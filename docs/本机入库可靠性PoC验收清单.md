# 本机入库可靠性 PoC 验收清单

> 文档状态：执行前验收基线
> 版本：v0.2
> 适用范围：Tauri 2 iOS/Android 手机端 + WebRTC DataChannel + 本机 Server + SQLite + 本机/外置素材盘
> 前置关系：本 PoC 是剪映 GUI 自动化 PoC 的前置 Gate；未通过前不得让整理器、分析器或剪辑任务读取未验证素材。

## 1. 目标与边界

验证手机在公网通过 WebRTC 上传素材时，本机系统能够在断网、切后台、Server 重启、磁盘异常和设备撤销下保持文件、SQLite 逻辑引用和任务可见性的一致。

本 PoC 不验证剪映编辑质量，也不承诺移动系统在 App 被强杀后自动唤醒。手机不能续传时，用户下次打开 App 后可继续；系统不建设云端素材收件箱。

## 2. 不可变安全与数据规则

- 信令只使用 TLS/WSS；传输只允许 STUN 协助的 WebRTC 直连，不签发 TURN 凭据。公网服务不持久化素材、项目或业务数据。
- 每次上传必须使用短时、绑定设备、`uploadId`、项目和素材分类的令牌，以及一次性 nonce。重放、越权项目/分类和过期令牌必须拒绝。
- 配对及每次上传均要求手机用配对私钥签名 nonce；grant 绑定 `deviceId`、`uploadId`、目标、文件摘要、过期时间、`jti` 和 DTLS fingerprint。只有 DataChannel 内签名验证通过后才创建/恢复 manifest。
- 设备私钥/密钥材料放在 iOS Keychain 或 Android Keystore；Mac 保存配对公钥或受保护会话材料。
- 素材仅在以下状态可被后续模块读取：`queued → transferring → staged → hash_verified → committed → ready` 中的 `ready`。
- 原始素材和已提交引用不能被本 PoC 自动删除；仅可清理已过期、未提交的暂存分块，并保留审计记录。

## 3. 入库提交协议与崩溃恢复

每个上传创建持久化 `UploadManifest`，至少包含：

- `uploadId`、已绑定设备和目标项目/素材分类；
- 预期文件大小、SHA-256、分块大小、已确认位图和已确认偏移；
- 素材盘卷 UUID、文件系统、规范化暂存/目标路径；
- 提交阶段、最后错误、目标物理文件 ID 和 SQLite 逻辑素材引用 ID；
- 创建/更新时间、令牌过期时间和审计事件序列。

提交顺序必须为：

1. 在目标素材盘同一卷的暂存目录写入分块并同步文件；
2. 按 manifest 校验完整大小与 SHA-256，进入 `hash_verified`；
3. 原子改名至正式素材路径并同步目录，进入 `committed`；
4. 在 SQLite 事务中建立或复用物理文件记录和逻辑素材引用，更新 manifest 后才进入 `ready`。

Server 启动及 Worker 领取素材前，必须以 SQLite、manifest、物理文件和完整哈希共同恢复状态：继续传输、回退 `staged` 重校验、完成缺失逻辑引用，或保留待诊断状态。不能仅根据文件存在或目录扫描把素材标记为 `ready`，也不能将 manifest 指向的文件按普通孤儿清理。

单个分块的持久化确认顺序固定为：范围/摘要验证 → 指定 offset 写入 → 文件同步 → manifest 位图和单调 `ackEpoch` 持久化并同步 → 返回 `ack(ackEpoch, bitmapDigest)`。恢复时只承认已持久化 epoch。

## 4. 存储与容量预检

- 素材根目录配置必须验证卷 UUID、文件系统和规范化路径；卷缺失、卷 UUID 改变或不受支持文件系统均为 `STORAGE_UNAVAILABLE`。
- 外置盘断开时，上传、分析和剪辑任务暂停；不得写入内置盘的同名路径。
- 上传开始前为素材盘预留完整文件、暂存和元数据所需容量；任务开始前还须为内置系统盘和剪映缓存盘预留代理/导出空间。
- 剩余空间低于 `max(10%, 50GB)` 告警，低于 `max(5%, 20GB)` 停止新上传与新任务；运行中写入失败以 `IO_INTERRUPTED` 或 `STORAGE_UNAVAILABLE` 作为原因码，保留 manifest 和恢复上下文。

## 5. SQLite、并发与可见性规则

- SQLite 使用 WAL，只有本机 Server 可写；手机接收器、整理 Worker 和 Runner 通过本机 API/IPC 提交幂等事件。
- 上传、引用创建和后续任务领取必须带幂等键、可过期 lease/fencing token；重复分块、重复完成请求和 Server 重放不得生成第二个物理文件或第二条逻辑引用。
- Server 启动必须做 WAL/完整性检查、过期 lease 回收和 manifest 对账。数据库故障不能被解释为上传完成。
- 同一 SHA-256 的完整原文件只能保留一个物理 blob，允许多个项目/分类逻辑引用；该去重必须在完整性校验后发生。

## 6. 必测故障矩阵

每个测试记录注入时机、状态、恢复动作、文件 SHA-256、SQLite 记录、manifest、审计日志和最终结论。至少覆盖下表：

| 故障/场景 | 注入阶段 | 必须满足的结果 |
| --- | --- | --- |
| 手机切后台、锁屏、强杀、Wi-Fi/蜂窝切换 | `queued` / `transferring` | 队列、位图和偏移不丢；在系统允许或下次打开 App 后安全续传。 |
| NAT 变化或网络要求 TURN 中继 | `connecting` / `transferring` | Mac 与手机获得同一会话的短期 ICE 凭据；连接/信令失败后自动申请一次 resume 会话并安全续传，长期 Key/API Token 仅在 Worker Secret。 |
| 重放令牌、重复分块、并发同一上传 | `transferring` | 不越权、不重复计量、不生成第二份物理文件或引用。 |
| 在分块写入、文件同步、manifest 更新、ack 之间强杀 Server | `transferring` | 重启后只承认已持久化 `ackEpoch`；手机不会跳过未安全落盘的分块。 |
| 杀死 Server | `staged` / `hash_verified` / `committed` | 重启后依据 manifest + 哈希恢复；不出现错误 `ready`。 |
| 在改名或 SQLite 事务边界杀死进程 | `committed` | 可检测并完成或回退到安全状态；不产生半提交可见素材。 |
| 素材盘写满 | 写入与提交 | 停止写入，状态可解释；不覆盖已有原始文件。 |
| 外置素材盘拔出/重新挂载 | 写入、校验、提交 | 无回退写入内置盘；卷身份相符后才允许恢复。 |
| SQLite/WAL 异常或重启 | 引用创建 | 不把物理文件误报为 `ready`；对账结果可审计。 |
| 设备撤销 | 活动会话 | 关闭活动会话并拒绝后续 DataChannel；未提交 manifest 保留供安全恢复/过期回收。 |
| 设备撤销后复用旧信令会话或上传 grant | 信令建连/传输 | 旧会话、上传 grant 和新会话申请均被拒绝；短期 TURN 凭据不能跨上传会话复用。 |
| 未配置 TURN 的连接失败 | `connecting` | 将准确 `uploadId` 持久化为可恢复网络暂停，返回 `CONNECTION_FAILED`；不无限重试。 |
| Cloudflare TURN 凭据生成失败或响应不完整 | 会话创建前 | 不创建 PeerConnection、不下发长期 Key/API Token；新上传取消容量预留，续传保持可恢复。 |
| 中国大陆蜂窝、普通 Wi-Fi、UDP 受限、仅 TCP/TLS 网络 | `connecting` / `transferring` | 分别记录 STUN/TURN 候选可达性、吞吐和失败原因；配置 TURN 时验证 UDP、TCP、TLS 候选与短期凭据。 |

## 7. 通过门槛（Gate A）

只有同时满足以下条件才可进入剪映 GUI 自动化 PoC：

- 所有故障矩阵均有可复现证据、可解释终态和恢复结论；
- 任意重启/故障后，`ready` 素材均满足文件大小、SHA-256、卷身份和 SQLite 逻辑引用一致；
- 不出现丢失原始素材、重复物理 blob、错误项目/分类引用、半提交 `ready` 素材或外置盘离线时写入内置盘；
- 未授权、撤销或重放设备无法继续上传；
- SQLite 对账、manifest 对账和审计日志完整，临时文件清理不会删除仍被 manifest 引用的候选文件。

任一项失败即为 `No-Go`：先修复入库协议或恢复实现，再重跑受影响矩阵；不得以人工检查目录替代自动一致性验证。

## 8. 结果记录模板

- 测试日期、测试版本、设备/网络环境、素材盘卷 UUID 和文件系统；
- 上传样本 ID、源文件大小/SHA-256、目标项目/分类；
- manifest 快照、SQLite 记录、物理文件路径与最终状态时间线；
- 故障注入步骤、重启/恢复步骤、审计日志和对账结果；
- 吞吐、恢复耗时、重复请求数和失败分布；
- Gate A `Go` / `No-Go` 结论及阻断问题。
