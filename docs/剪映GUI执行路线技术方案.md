# 剪映 GUI 执行路线技术方案

> 文档状态：推荐设计，作为 Gate B（剪映 GUI PoC）实施输入
> 版本：v0.2
> 范围：当前 macOS、官方剪映专业版、UI-TARS 候选底座、全自动 Vlog 成片导出
> 非范围：剪映草稿 JSON 读写、FFmpeg 最终渲染、CapCut Web、云端 Windows 工作机

## 1. 路线结论

首期不把 UI-TARS 视为已验证能力。它只作为本机 GUI Agent 的候选视觉/推理底座，必须经 Gate B 通过后才可冻结执行路线。

全自动化不等于让模型拥有任意桌面控制权。模型只能提出候选操作；本机原生组件必须验证操作对象、窗口、路径、状态证据和动作预算后才执行。所有编辑和最终导出均真实发生在本机官方剪映专业版的 GUI 中。

## 2. 组件职责

| 组件 | 职责 | 不能做什么 |
| --- | --- | --- |
| Task Orchestrator | 创建任务、冻结输入快照、状态编排、持久化证据 | 不直接点击剪映、不直接写草稿文件 |
| ClipPlan | 把素材分析结果表示为镜头顺序、裁剪意图、字幕/音频/导出规格 | 不是剪映草稿 JSON，不能被直接导入剪映 |
| Jianying Operator Skill | 将当前状态和 ClipPlan 转成受限 GUI 候选动作 | 不能绕过 Action Gateway 或任意执行 shell 指令 |
| UI-TARS Adapter | 提供截图理解、目标定位和候选动作建议 | `END`、自然语言回复或模型自报成功均不能视作任务成功 |
| Action Gateway | 校验并执行每一个受类型约束的原生 GUI 输入，记录证据 | 不向终端、浏览器、系统设置、付款或未知应用输入；不执行裸坐标点击或任意文本粘贴 |
| RunManifest | 固化一次执行尝试、工程归属、lease、检查点、导出目标和动作序号 | 不是剪映草稿格式，不能被剪映导入 |
| Evidence Store | 保存截图、窗口识别、动作、导出文件和 QA 报告的 hash 链 | 不替代 SQLite 的任务状态真相 |
| Independent Media QA | 用独立 Oracle 检查导出文件和冻结的 QAManifest 一致性 | 不参与 Planner/Operator 的决策或最终渲染 |

SQLite 仅由本机 Server 写入。Runner、Skill 与 QA Worker 只能经本机 API/IPC 使用幂等事件和 lease/fencing token 上报。

每个执行尝试有唯一 `attemptId`、`runId` 和 `leaseEpoch`。同一显示器只能存在一个未终态 `ExecutionLock`；Gateway 每个输入前均验证令牌未过期且 epoch 匹配。令牌失效、旧 Runner 存活或锁无法取得时立即硬停止输入，先封存旧尝试再允许新尝试。

## 3. 受控执行链路

```text
冻结任务输入 + StyleProfile 快照
  → ClipPlan
  → PRECHECK
  → IMPORT
  → ASSEMBLE
  → AUDIO_SUBTITLE
  → PREVIEW_QA
  → EXPORT
  → EXPORT_QA
  → SUCCESS
```

每个状态至少有以下约束：

1. 前置条件：前台 app、窗口、屏幕、权限、素材路径和上一状态证据均匹配；
2. 输入：只接受该状态声明的 ClipPlan 子集和 Typed Action DSL；
3. 动作预算：状态超时、最大 GUI 动作数、有限重试次数；
4. 证据：操作前后截图、窗口/控件识别、Gateway 决策、剪映 GUI 或文件可验证结果；证据按单调动作序号和前一条 hash 形成 append-only 链；
5. 退出：进入下一状态、`FAILED_QA`、`BLOCKED_TECHNICAL` 或 `CANCELLED`。

模型无法确定当前状态、界面与预期不一致、或预算耗尽时，必须停止。不得为了“完成率”盲目重复点击、继续旧工程或把技术问题变成人工剪辑审核。

## 4. Action Gateway 与 Typed Action DSL

Gateway 是唯一可以产生鼠标、键盘、拖放和文件选择原生输入的组件。UI-TARS 不能提交任意坐标、任意键盘组合或任意剪贴板文本，只能提交由当前状态允许的类型化动作，例如 `ImportFiles`、`SetCanvasRatio`、`PlaceClip`、`TrimClip`、`AddCaption`、`AttachAudio`、`Preview`、`Export`。每条动作包含不可变 `stateId`、`attemptId`、`leaseEpoch`、允许参数、目标控件证据、前置断言、后置断言和超时。

每个候选动作执行前必须同时通过：

- 当前前台 PID 与 bundle ID 是官方剪映，或是允许的系统文件选择器；
- 当前窗口标题、边界、显示器参数和 UI 语言符合任务静态兼容性指纹；
- 最近截图/布局证据能够证明目标控件仍然存在，且动作坐标位于允许区域；
- 文件读取路径是任务素材根目录或已验证生成素材目录；文件写入路径是任务导出目录；
- 未出现验证码、更新、付费、权限、原始素材删除或未知弹窗；
- 本状态动作预算和单次操作前置条件仍未耗尽。
- 当前 `ExecutionLock`、`runId` 和 `leaseEpoch` 未过期且与 Server 记录一致。

执行后必须在动作超时内验证后置断言，才可推进状态。Gateway 记录候选操作、应用、窗口、路径、坐标、截图哈希、放行/拒绝结论和原因码。拒绝一律不执行，并使任务进入 `BLOCKED_TECHNICAL`；此行为是正常安全结果，不计为用户内容审核。

## 5. 固定运行环境

- 独立标准 macOS 用户，无管理员权限；
- 单一主显示器、固定分辨率/缩放、固定剪映窗口位置/尺寸、固定 UI 语言；
- Runner 有辅助功能与屏幕录制权限；这些权限和剪映登录只在首次配置完成；
- 运行时不能存在未受控的终端、浏览器或系统设置会话；
- macOS 锁屏、屏保、睡眠、切换用户、剪映更新或任意未知模态框均终止当前自动动作。

单一 `CompatibilityManifest` 将兼容性拆为三类：GUI 语义静态项（macOS/硬件、剪映构建、UI-TARS/模型及参数、Operator Skill/系统提示词哈希、Runner、显示器与 UI 布局）、可自动恢复运行项（窗口位置、登录和屏保状态）、存储可用性项（卷身份、路径、空间）。只有第一类变化触发对应回归；后两类仅阻断当前任务或触发恢复，不混入回归判定。

## 6. 失败与恢复

| 情形 | 处理方式 |
| --- | --- |
| 预检失败、权限/登录/更新/未知弹窗 | `BLOCKED_TECHNICAL`；不点击猜测按钮，不修改系统设置。 |
| Runner 或剪映崩溃 | 封存旧 `attemptId`；不在旧工程盲目续跑。仅从 RunManifest 中有后置证据的检查点恢复，否则新建隔离工程、唯一工程标识和唯一导出路径，从持久化 ClipPlan 重建。 |
| 状态超时或动作预算耗尽 | 停止、记录原因；不得无限循环。 |
| 导出完成但媒体 QA 失败 | `FAILED_QA`；不展示为最终成品。 |
| 原始素材盘离线或空间不足 | 以 `STORAGE_UNAVAILABLE` / `IO_INTERRUPTED` 原因码安全停止，保留任务与入库证据。 |

只有 `SUCCESS` 可以在 Web 中作为最终成片展示。用户只在成片完成后查看；技术阻塞不是正常流程中的人工接管入口。

每个 RunManifest 至少包含 `taskId`、`attemptId`、`runId`、`leaseEpoch`、ClipPlan hash、工程标识、已验证状态、动作序号、导出目标、证据 manifest hash 和 QA 报告 hash。导出路径为不可复用的 `taskId/attemptId` 目录，Gateway 禁止覆盖现存文件；先以 `.partial` 落地并完成稳定性检测、哈希和 QA，再由 SQLite 事务发布为可见成片。失败尝试永不覆盖既有成功版本。

## 7. Gate B 实施顺序

1. 在固定环境中验证 Runner 能读取窗口、截图和权限状态，但不操作剪映。
2. 验证 Gateway 能拒绝终端、浏览器、系统设置、未知窗口和越界文件路径。
3. 用少量隔离工程验证导入、画幅、基础裁剪、字幕/BGM、导出和证据链。
4. 建立 `InputEnvelope`、`QAManifest`、RunManifest、故障注入方式及 CompatibilityManifest；先用带已知错序、黑帧、静音和错字幕的盲测 fixture 验证独立 QA Oracle。
5. 在 60 个校准任务执行可行性 Gate；通过后冻结配置并运行独立留出集。
6. 只有路线冻结 Gate 通过，才将此路线接入首期自动任务；否则保持为 PoC，不以其他方案绕过“实际操作剪映”的约束。

## 8. Gate B 必须给出的结论

- 实际支持的剪映构建、macOS、显示器和 UI-TARS/模型组合；
- 已验证动作的允许表与各状态动作预算；
- 留出集开始前已冻结并哈希的统计协议：样本/顺序/随机种子、输入边界配额、成功分母、首轮与恢复后计数、技术阻塞计数、故障矩阵和 No-Go 条件；
- 任务一次通过率、恢复后通过率、`FAILED_QA` 率和 `BLOCKED_TECHNICAL` 率；
- 60 个校准任务及独立留出集的可追溯证据；
- 是否满足正式路线冻结条件，或必须停止该路线并重新评估候选底座。
