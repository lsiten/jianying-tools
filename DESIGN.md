# 剪映自动剪辑 Design System

## 0. Research Log

- Embedded refs: shortlisted Linear, Vercel, and Notion → picked Linear-inspired operational surfaces with the `layout-skill` mechanics: the product needs a calm, dense local control plane rather than a marketing page.
- Lazyweb: skipped — the UI is a local-first control surface and no external product screen is needed to define its task flow.
- Imagen drafts: skipped — this is an operational application shell; generated hero imagery would not improve the primary transfer and material-management tasks.

## 1. Atmosphere & Identity

这是一个安静而有把握的本机创作控制台：深色底色让素材、传输状态和操作顺序浮在清晰的层次上。标志性体验是“本机仍掌控一切”——公网只显示窄小的连接状态，项目、素材和成片始终被表现为在 Mac 上的对象，而非云端资产。

## 2. Color

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Canvas | `--surface-canvas` | `#08090a` | 页面背景 |
| Panel | `--surface-panel` | `#0f1011` | 侧栏与表单区域 |
| Raised | `--surface-raised` | `#191a1b` | 卡片与重点内容 |
| Hover | `--surface-hover` | `#28282c` | 可操作表面悬停 |
| Primary text | `--text-primary` | `#f7f8f8` | 标题与关键数据 |
| Secondary text | `--text-secondary` | `#d0d6e0` | 正文与控件文本 |
| Muted text | `--text-muted` | `#8a8f98` | 辅助说明 |
| Quiet text | `--text-quiet` | `#62666d` | 元数据与禁用态 |
| Border subtle | `--border-subtle` | `rgba(255, 255, 255, 0.05)` | 结构分界 |
| Border default | `--border-default` | `rgba(255, 255, 255, 0.08)` | 输入与卡片 |
| Accent | `--accent-primary` | `#5e6ad2` | 主操作与焦点 |
| Accent hover | `--accent-hover` | `#828fff` | 主操作悬停 |
| Success | `--status-success` | `#27a644` | 本机连接成功与完成 |
| Warning | `--status-warning` | `#d99219` | 需要注意的可恢复状态 |
| Error | `--status-error` | `#d9534f` | 失败与阻断状态 |

颜色只可通过这些 token 使用；强调色只用于能直接改变状态的交互元素。

## 3. Typography

| Level | Token | Size / line-height | Weight | Usage |
| --- | --- | --- | --- | --- |
| Page title | `--type-page` | `clamp(2rem, 3.4vw, 2.75rem) / 1.1` | 590 | 页面标题 |
| Section title | `--type-section` | `1.5rem / 1.33` | 590 | 卡片标题 |
| Body | `--type-body` | `1rem / 1.5` | 400 | 默认正文 |
| Small | `--type-small` | `0.875rem / 1.5` | 400 | 表单和说明 |
| Label | `--type-label` | `0.75rem / 1.4` | 510 | 标签与状态 |
| Mono | `--type-mono` | `0.8125rem / 1.5` | 400 | 地址、ID 与技术状态 |

- Primary: `Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。
- Mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`。
- 全局采用 `"cv01", "ss03"` 字形特性；正文不低于 14px。

## 4. Spacing & Layout

基础单位为 4px：`--space-1` 4px，`--space-2` 8px，`--space-3` 12px，`--space-4` 16px，`--space-5` 20px，`--space-6` 24px，`--space-8` 32px，`--space-10` 40px，`--space-12` 48px，`--space-16` 64px。

- 使用 `fixed-sidenav-shell`：侧栏保持固定，主内容区为唯一垂直滚动所有者，`100dvb` 限高且主区使用 `min-block-size: 0`。
- 主内容的最大宽度为 1200px；内容网格采用 `repeat(auto-fit, minmax(min(18rem, 100%), 1fr))`，在窄屏自动收为单列。
- 手机、平板、桌面分别在 375px、768px、1280px 复核；长名称与无空格 URL 必须可换行或截断，不产生主内容横向滚动。
- `mobile-upload-shell` 是独立的单列滚动页：页面文档为唯一滚动所有者。页首只显示当前目录与配对状态；未配对时将 Key 连接流程放到首屏，已配对时将“选择素材”和“录制视频”作为唯一的两张主行动卡，队列紧随其后。目录切换在当前目标旁边，添加 Key 收入低频折叠区；不使用重复的底部粘性行动栏，并为 iOS 安全区预留 `env(safe-area-inset-bottom)`；不复用桌面侧栏。

## 5. Components

### App Shell

- **Structure**: `aside` + `main` 的 `fixed-sidenav-shell`。
- **States**: 收窄视口时侧栏改为顶部信息区；空状态仍保留下一步说明。
- **Accessibility**: `main` 有可见标题，导航为语义化链接；键盘焦点始终可见。
- **Motion**: 仅色彩与透明度在 150ms 内变化；减少动态偏好时禁用。

### Action Button

- **Structure**: 原生 `button`，文本优先，必要时带状态说明。
- **Variants**: primary、secondary、danger。
- **Spacing**: `--space-2` × `--space-4`。
- **States**: default、hover、active、focus-visible、disabled、loading、error。
- **Accessibility**: 最小 44px 触控高度，禁用态不可聚焦，加载状态有文字反馈。

### Field Group

- **Structure**: `label`、说明、原生输入控件、内联错误文字。
- **Spacing**: 采用 `stack`，间距 `--space-2`。
- **States**: default、focus-visible、invalid、disabled。
- **Accessibility**: 显式 `for`/`id` 关联，错误通过 `aria-describedby` 暴露。

### Status Card

- **Structure**: 标题、状态徽标、说明与行动区。
- **Variants**: online、offline、warning、error。
- **States**: default、empty、loading、error。
- **Accessibility**: 状态文本不只依赖颜色；异步状态区使用 `aria-live="polite"`。

### Paired Key Selector

- **Structure**: 当前目录名称、在线/等待状态、原生 `select` 切换器与“添加 Key”行动；Key 本体绝不在已配对列表中回显或存储。
- **States**: empty、redeeming、ready、offline、rejected；切换只影响新加入的文件，已在队列中的文件继续持有其创建时的目录绑定。
- **Accessibility**: 当前目录用文本陈述；`select` 具备可见标签；兑换与错误消息通过 `aria-live="polite"` 传达。

### Project Upload Key Issuer

- **Structure**: 桌面端选择已创建的项目/素材分类，填写该 Key 对应的目录名，然后生成一次性 Key；Key 仅在此卡片当前会话展示，并提供显式复制与关闭行动。
- **States**: no-target、ready、creating、created、copy-failed、rejected；一个项目/分类可创建任意多个 Key，但每次都必须明确一个独立目录名。
- **Accessibility**: 目标选择器、目录输入和复制按钮均有可见标签；复制与创建结果通过 `aria-live="polite"` 传达；原始 Key 通过只读文本框而非颜色或二维码单独表达。

### Upload launchpad & queue

- **Structure**: 未配对时先展示单一的 Key 连接表单；已配对后，页首只陈述“上传到电脑”与配对状态，当前目录收为一行上下文，紧接着只提供“从手机选择”和“现在录制”两个同等层级的主行动。手机上二者纵向连续呈现，平板起才并列；存在多个目录时在当前目录行内切换；按文件排列的队列仅在有传输时出现，添加新 Key 收在低频的折叠区。视觉隐藏的原生文件输入不可进入键盘 Tab 顺序，键盘用户只进入可见的上传动作。
- **States**: awaiting-key、queued、hashing、negotiating、transferring、awaiting-file、completed、failed；每个状态都有文字，绝不只以色彩或动画表达。文件选择和单次批量均不设数量上限；最多 3 个文件同时直传，其余保持有序排队。
- **Resumption**: 每个文件在建立传输前持久化独立续传元数据。`CONNECTION_FAILED` 或 `SIGNALING_TIMED_OUT` 时，页面会自动为同一 `uploadId` 请求一次新的 resume 会话和短期 ICE 凭据；刷新页面后，用户重新选择原文件即可按完整内容哈希匹配并继续。相同文件名/大小但内容不同的文件绝不复用彼此会话，未匹配的待续传项继续保留在队列中。
- **Accessibility**: 每个文件项最小触控高度 44px；进度使用原生 `progress` 与文字百分比；失败项保留可重试的原因和键盘可达按钮。

### Camera Recorder

- **Structure**: 与“选择素材上传”并列的“录制视频上传”主行动、仅在录制时出现的静音实时预览，以及“停止录制并上传”行动。
- **States**: unavailable、requesting-permission、recording、stopping、failed；停录后生成的 `File` 走与选择文件完全相同的受控并发、WebRTC 与续传链路。
- **Accessibility**: 录制状态及失败原因通过 `aria-live="polite"` 传达；预览始终 `muted` 且 `playsinline`，操作控件最小触控高度 44px；停止、失败或空片段时释放摄像头和麦克风轨道。

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
| --- | --- | --- | --- |
| Micro | 150ms | ease-out | 按钮与输入焦点 |
| Standard | 220ms | ease-in-out | 状态卡更新 |

- 只动画 `opacity`、`transform` 与颜色；不动画布局属性。
- 键盘焦点、鼠标悬停和触控按下都有明确反馈。
- `prefers-reduced-motion: reduce` 时不执行非必要过渡。
- Key 兑换、目录切换和文件状态仅采用 150ms 的颜色/透明度变化；不引入额外动画库。交互机制参照 beui 的 `file-upload` 状态队列理念，但其源码端点在本次网络环境无法取得，因此使用平台原生控件与 CSS 的减少动态降级路径。

## 7. Depth & Surface

采用“tonal-shift + subtle border”：层级主要由 `canvas → panel → raised` 的亮度递进建立，只使用细微边线，不使用投影作为信息层级。卡片为 8px 圆角，输入与按钮为 6px 圆角；不把大圆角作为通用装饰。

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- 目标为 WCAG 2.2 AA：正文对比度至少 4.5:1，所有交互控件具备可见焦点与键盘可达性。
- 支持中文长文本、200% 缩放、系统减少动态偏好与触控 44px 目标。
- 传输失败必须以清晰原因和恢复路径呈现；已配置的 TURN 使用会话级短期凭据，未配置或连接失败不得伪装成“正在重试”。
- 配对 Key 仅在兑换请求内短暂存在；兑换成功、失败或超时后均从内存输入状态清空，持久化数据只保存受保护设备密钥、Key ID、目录名、目标与选择状态。

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| 移动端相机扫码 | 配对流程 | 初期保留手动粘贴 Key，避免在没有相机授权与二维码格式验收前提供伪扫码入口 | 后续以同一 Key 兑换协议实现扫码输入 |
