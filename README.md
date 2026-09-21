# 早期学习困难儿童筛查与干预系统 · 移动端

面向 Android 平板的教师端。沿用 React、TypeScript、Vite、Capacitor 和 SQLite。当前已接入公共契约、数据库基础和启动状态页；业务模块尚待实现。

## 项目目录

以下按当前仓库结构列出主要目录和文件；Android 图标、启动图等重复资源合并展示，依赖和构建产物不展开。

```text
early-learning-mobile/
├── README.md                         # 项目说明、开发命令与目录索引
├── AGENTS.md                         # 开发指引、业务边界与验收要求
├── .gitignore                        # Git 忽略规则
├── .nvmrc                            # Node.js 版本约定
├── package.json                      # 依赖、运行环境与 npm 脚本
├── package-lock.json                 # npm 依赖版本锁定
├── index.html                        # Web 页面入口与 React 挂载节点
├── vite.config.ts                    # Vite 与 React 构建配置
├── capacitor.config.ts               # 应用标识、名称与 Web 产物目录
├── eslint.config.js                  # 源码、测试及配置文件的 lint 规则
├── tsconfig.json                     # TypeScript 项目引用入口
├── tsconfig.app.json                 # 前端源码的 TypeScript 配置
├── tsconfig.node.json                # 工具与 Capacitor 配置的类型检查
├── docs/
│   ├── 技术方案.md                    # 数据表、五份 JSON 契约与评分说明
│   └── 公共工程基础.md                # 分层职责、事务接入及正式资料链接
├── public/                           # Web 静态资源
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── main.tsx                      # React 挂载入口，启用 StrictMode
│   ├── App.tsx                       # 转导出 app/Application
│   ├── App.css                       # 应用页面样式
│   ├── index.css                     # 全局基础样式
│   ├── app/                          # 应用启动、页面入口与依赖组装
│   │   ├── Application.tsx           # 数据库启动状态、浏览器预览与失败重试
│   │   └── database.ts               # 唯一生产数据库实例的组装入口
│   ├── infrastructure/               # 平台能力适配
│   │   ├── database/
│   │   │   ├── index.ts              # 数据库公共导出
│   │   │   ├── types.ts              # 驱动、读取、事务与迁移接口
│   │   │   ├── database.ts           # 连接生命周期、串行访问与事务控制
│   │   │   ├── capacitor-driver.ts   # Capacitor SQLite 插件适配
│   │   │   ├── migrate.ts            # 迁移执行、版本与完整性检查
│   │   │   └── migrations/
│   │   │       └── 001_initial_sqlite.sql # 初始 18 张业务表及约束
│   │   ├── filesystem/               # 文件系统适配（当前为空）
│   │   ├── http/                     # HTTP 与网络层适配（当前为空）
│   │   └── media/                    # 录音、播放等媒体适配（当前为空）
│   ├── modules/                      # 业务模块；当前均为待实现骨架
│   │   ├── ai/                       # 转写与 AI 评分
│   │   ├── assessments/              # 前测、初筛与复评
│   │   ├── auth/                     # 注册激活、本地登录与凭证管理
│   │   ├── cases/                    # 儿童个案与阶段管理
│   │   ├── classroom/                # 课堂执行、活动结果与教师评价
│   │   ├── course-progress/          # 儿童课程进度与恢复位置
│   │   ├── courses/                  # 官方及私人课程、活动配置
│   │   ├── dictionary/               # 词语释义与课程文本位置
│   │   ├── files/                    # 本地文件元数据与业务引用
│   │   ├── grammar/                  # 语法要素定义与图标
│   │   ├── groups/                   # 小组及成员管理
│   │   ├── plans/                    # 个人、小组计划与课程编排
│   │   ├── reports/                  # 报告生成与展示
│   │   ├── statistics/               # 课次、问答及语法要素统计
│   │   └── sync/                     # 官方内容单向下载与本地更新
│   └── shared/
│       ├── contracts/                # 公共类型、状态与运行时校验
│       │   ├── index.ts              # 公共契约统一导出
│       │   ├── primitives.ts         # 本地 ID、日期与时间戳约定
│       │   ├── errors.ts             # AppError 与稳定错误码
│       │   ├── states.ts             # 冻结状态类型，不负责业务状态推进
│       │   ├── codes/
│       │   │   └── index.ts          # 文件、语法、词条及官方内容 Code 类型
│       │   └── json/
│       │       ├── index.ts          # JSON 类型与校验入口导出
│       │       ├── parse.ts          # 公共解析工具与契约错误
│       │       ├── activity-config.ts # 活动配置契约
│       │       ├── activity-result.ts # 活动结果契约
│       │       ├── ai-score.ts       # 叙述 AI 评分契约
│       │       ├── scale-scores.ts   # 教师十题评价结果契约
│       │       └── resume-state.ts   # 课程恢复位置契约
│       └── ui/                       # 公共 UI 组件（当前为空）
├── scripts/                          # Node 内置测试
│   ├── contracts.test.mjs            # JSON 契约与边界校验
│   ├── database.test.mjs             # SQLite 建库、迁移、事务与驱动适配
│   └── primitives.test.mjs           # ID、日期与公共错误
└── android/                          # Capacitor Android 原生工程
    ├── .gitignore                    # 原生产物与本机配置忽略规则
    ├── build.gradle                 # 工程级构建配置
    ├── settings.gradle              # Gradle 模块注册
    ├── variables.gradle             # Android SDK 等共享版本配置
    ├── gradle.properties            # Gradle 构建属性
    ├── capacitor.settings.gradle    # Capacitor 插件模块配置
    ├── gradlew                      # Unix Gradle Wrapper 入口
    ├── gradlew.bat                  # Windows Gradle Wrapper 入口
    ├── gradle/wrapper/              # Gradle Wrapper 程序与版本配置
    └── app/
        ├── .gitignore
        ├── build.gradle             # 应用构建配置与依赖
        ├── capacitor.build.gradle   # Capacitor 生成的应用构建配置
        ├── proguard-rules.pro       # 混淆规则
        └── src/
            ├── main/
            │   ├── AndroidManifest.xml # 权限、Activity 与应用声明
            │   ├── java/com/example/earlylearning/
            │   │   └── MainActivity.java # Capacitor 原生 Activity
            │   └── res/             # 启动图、图标、布局、字符串与文件路径配置
            ├── test/                # Android 工程自带的单元测试示例
            └── androidTest/         # Android 工程自带的仪器测试示例
```

每个 `src/modules/<模块>/` 当前都有以下结构；`index.ts` 为空文件，其余为预留空目录，尚无业务实现：

```text
<模块>/
├── index.ts                         # 模块公开入口
├── repositories/                    # 模块私有仓储，通过统一数据库接口访问数据
├── services/                        # 业务用例、状态转换与事务编排
└── ui/                              # 模块私有页面与组件
```

空目录不会被 Git 单独记录，重新克隆后可能不存在，开发相应功能时再创建。`infrastructure/filesystem` 负责平台文件操作，`modules/files` 负责文件元数据与业务引用；`modules/sync` 仅面向官方内容，不承担儿童业务数据的云端同步。

本机或运行命令后还会出现 `node_modules/`（依赖）、`dist/`（Web 构建产物）、`android/.gradle/`（缓存）、`android/build/` 与 `android/app/build/`（原生构建产物）、`android/app/src/main/assets/`（同步的 Web 产物及 Capacitor 配置）。这些生成内容不作为业务源码维护；`android/local.properties` 保存本机 SDK 路径，不入库。

## 开发环境

- Node.js 24.15.x（版本文件见 `.nvmrc`），npm 11.x；依赖以 `package-lock.json` 为准。
- 首次安装：`npm ci`。不要重新初始化项目或更换包管理器。
- Windows PowerShell 如限制执行 npm.ps1，使用 `npm.cmd` / `npx.cmd`，不需要修改系统执行策略。
- Android 工程沿用现有配置；本机 SDK 路径放在不入库的 `android/local.properties`。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 浏览器预览；不会创建或保存本地业务数据库 |
| `npm run typecheck` | 严格 TypeScript 检查，包含 Capacitor 配置 |
| `npm run lint` | 检查源码、测试和工具配置；排除 Android 生成产物 |
| `npm test` | Node 内置测试：JSON 契约、SQLite 迁移/事务、公共日期和 ID |
| `npm run build` | 类型检查与 Web 生产构建 |
| `npm run check` | 顺序运行类型检查、lint、测试、构建 |
| `npm run preview` | 预览已构建的 Web 产物 |

Node 测试中的 SQLite 驱动仅用于验证 SQL 和事务，不代替 Android 原生验收。

## Android 运行

先执行 `npm run build`，再执行 `npm exec -- cap sync android`，将最新 Web 产物和已安装插件同步到原生工程。使用 Android Studio 打开 `android` 并在模拟器或真机运行。

Windows 命令行构建：进入 `android` 后执行 `.\gradlew.bat :app:assembleDebug`。Gradle、SDK 和依赖需要本机已有缓存或可用网络。

应用在 Android 上启动时打开数据库并执行迁移；完成后显示“本地数据已就绪”。浏览器仅显示预览说明。启动失败会保留已有数据并显示错误，不以删库方式自动恢复。

## 分工开发入口

- [公共工程基础](docs/公共工程基础.md)：目录责任、类型和错误约定、事务接入示例、迁移规则和验收边界。
- [技术方案](docs/技术方案.md)：冻结的表结构和五份 JSON 契约；飞书资料入口见公共工程基础。
- [开发指引](AGENTS.md)：业务边界和验证要求。
- `src/modules/*`：各模块入口；当前空入口不代表已有实现。
- `src/app/database.ts`：唯一生产数据库组装点。
- `src/infrastructure/database`：SQLite 适配、迁移和事务。
- `src/shared/contracts`：公共值类型、错误、状态及 JSON 校验。

本批覆盖工程检查、公共约定、SQLite 基础。文件/录音适配、HTTP 与鉴权接入、模块业务接口和 CI 留待后续批次。
