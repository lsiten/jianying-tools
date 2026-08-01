# video-autopilot-kit 评估与复用边界

> 文档状态：已确认的第三方参考策略
> 评估对象：[`Hao0321/video-autopilot-kit`](https://github.com/Hao0321/video-autopilot-kit)
> 固定评估提交：[`f081e99`](https://github.com/Hao0321/video-autopilot-kit/tree/f081e99ed169b5aba1156a2aa6a80b748c39fbc9)
> 许可证：MIT
> 结论：受控参考源，不作为运行时依赖、Git submodule 或剪映执行模块

## 1. 与本项目的边界

该仓库提供两类路径：跨平台的纯程序化 FFmpeg 流水线，以及 Windows 优先、对版本敏感的 CapCut 草稿 JSON/Computer Use 路径。其 README 明确说明 Mac 上的 Computer Use GUI 自动化不可用，且 CapCut 草稿直改对版本敏感；这与本项目“当前 macOS、实际操作官方剪映 GUI、非草稿 JSON 核心、剪映完成最终导出”的既定边界不兼容。

因此以下内容禁止直接接入：

- `capcut_helpers/draft_io.py` 及任何草稿 JSON 读写、生成或导入；
- `silent_vlog_maker`、`longform_maker` 的 FFmpeg 最终剪辑/渲染流水线；
- Windows/CapCut Computer Use 导出逻辑；
- 将该仓库作为 submodule、fork 后自动合并上游，或把其配置/脚本作为生产运行时依赖。

## 2. 可借鉴内容与本项目映射

| 上游内容 | 本项目中的受控落点 | 采用方式 |
| --- | --- | --- |
| `src/teardown.py` 的剪点/刀距分布、换句节奏、LUFS 分析 | `ReferenceStyleProfile` | 只吸收指标和测试方法；使用本地 ffprobe/抽帧/可选 OCR 实现，不复制其剪辑流水线。 |
| `src/capcut_helpers/delivery_qa.py` 的黑帧、静音、字幕同步、接触表思路 | `Independent Media QA` + `QAManifest` | 按本项目冻结的阈值和盲测 fixture 重新实现；仅做导出后检查，不做剪辑或重编码。 |
| `src/av_util.py` 的 ffprobe、抽帧、接触表辅助思路 | PoC/QA 工具层 | 可在保留 MIT 归属的前提下选择性移植小型无业务耦合工具；每个函数须通过本项目测试。 |
| 风格模板、节奏 Gate、内容合规检查表的方法论 | StyleProfile 与 Planner 的规则输入 | 只作为可解释规则参考，阈值必须以用户自身样本校准，不能照抄上游示例值。 |

`teardown.py` 自己也将 OCR 限定为对已烧录字幕的参考分析，且警告不能把其 OCR 结果用于自动生成品名、价格、规格或人名字幕；本项目沿用这一限制。[teardown.py](https://github.com/Hao0321/video-autopilot-kit/blob/f081e99ed169b5aba1156a2aa6a80b748c39fbc9/src/teardown.py)

## 3. 接入规则

1. 上游仓库只作为证据和设计参考，固定提交为 `f081e99`；生产构建不下载、执行或 import 上游代码。
2. 若选择性移植某个无业务耦合函数，必须复制到本项目受控模块，保留 MIT 许可文本、原作者归属、来源 URL 和固定提交；禁止通过网络在运行时拉取。
3. 移植前必须写本项目接口、单元测试、输入边界、许可证记录和安全审查；通过后才可进入 Gate A/Gate B 的工具层。
4. 所有 FFmpeg/ffprobe 使用仅限素材分析、缩略图/抽帧、代理或独立 QA；禁止作为最终成片渲染器。
5. 所有参考指标必须写入版本化 `ReferenceStyleProfile` 或 `QAManifest`，由用户样本校准；不能以“上游默认阈值”决定本项目成片通过与否。

## 4. 上游更新跟踪

不自动更新。每次考虑吸收上游更新时按以下流程：

1. 记录候选 commit、变更文件、许可证与变更原因；
2. 仅筛选允许类别（参考分析、QA、非业务通用工具）；草稿 JSON、最终渲染和 Windows GUI 自动化一律拒绝；
3. 对允许变更编写本项目适配代码与回归测试，不直接 merge 上游；
4. 在固定输入 fixture 上运行 Reference Analysis / QA 回归；
5. 代码、许可证与 Gate 结果均通过后，才更新本项目的“已评估上游提交”。

这样可以吸收上游方法论与小型工具的改进，而不会让上游的 CapCut 格式、Windows 假设或 FFmpeg 成片路径改变本项目已确认的 macOS 剪映执行边界。

## 5. 证据

- [上游 README：两条路径、平台支持与 CapCut 限制](https://github.com/Hao0321/video-autopilot-kit/blob/f081e99ed169b5aba1156a2aa6a80b748c39fbc9/README.md)
- [上游 delivery_qa.py：导出后 QA 思路](https://github.com/Hao0321/video-autopilot-kit/blob/f081e99ed169b5aba1156a2aa6a80b748c39fbc9/src/capcut_helpers/delivery_qa.py)
- [上游 av_util.py：抽帧与接触表辅助工具](https://github.com/Hao0321/video-autopilot-kit/blob/f081e99ed169b5aba1156a2aa6a80b748c39fbc9/src/av_util.py)
- [上游 MIT License](https://github.com/Hao0321/video-autopilot-kit/blob/f081e99ed169b5aba1156a2aa6a80b748c39fbc9/LICENSE)
