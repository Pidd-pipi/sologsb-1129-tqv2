# 活字字模与铅字档案（gbmovabletype）

面向活字印刷体验馆、铅字工坊与字体研究者的字模 / 字盘 / 试印档案工具：登记字模的字体、字号与材质，在行列网格上编辑字盘落位，记录缺笔磨损等损耗并据此停用或补刻；字模可整批借往巡展，借调批次记录原格位与目标字盘、用乐观锁防止多标签页互相覆盖。**纯前端单页应用**，数据全部保存在浏览器本地，不依赖任何后端服务、数据库或外部接口。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:21829**

其它常用命令：

```bash
docker compose ps          # 查看容器状态（healthy 即就绪）
docker compose logs -f     # 查看 nginx 日志
docker compose down        # 停止并移除容器（数据在浏览器本地，不受影响）
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript（严格模式） |
| 构建 | Vite 6，`npm run build` = `tsc -b && vite build`（含类型检查） |
| 样式 | Tailwind CSS v3 + PostCSS + Autoprefixer（无 UI 组件库，样式自写） |
| 状态 | Zustand（筛选偏好走 persist） |
| 路由 | React Router 6（`createBrowserRouter`） |
| 本地存储 | IndexedDB（Dexie，库名 `gbmovabletype-db`）+ localStorage（表单 / 布局 / 借调编排草稿），跨标签页用 `storage` 事件做乐观锁通知 |
| 部署 | 多阶段 Docker：`node:20-alpine` 构建 → `nginx:alpine` 托管静态产物 |

## 数据模型（`src/types/` 四个独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| TypeMatrix 字模 | `src/types/matrix.ts` | 字模编号、字符、字体（宋体/楷体/仿宋）、字号（初号 42pt … 八号 5pt 共 16 档）、材质（铜模/木活字/铅合金）、字面尺寸 mm、字身高度 mm、制作年代、刻工、可用性（可用/停用/待补刻/借调中） |
| TypeCase 字盘 | `src/types/case.ts` | 字盘编号、类型（常用字盘/生僻字盘）、行数、列数、格位布局（行/列/字符/字模 id）、所在工位、容量 |
| LoanBatch 借调批次 | `src/types/loan.ts` | 批次编号、巡展、经办人、出库/归还日期、明细（字模、原格位、目标字盘与目标格位、借出前可用性）、状态（进行中/待复核/已完成/已取消）、乐观锁 version、多值索引 matrixIds |
| DefectLog 缺损记录 | `src/types/defect.ts` | 字模 id、缺损类型（缺笔/磨损/变形/锈蚀/断裂）、程度（轻/中/重）、发现日期、处理方式、可用性（可用/停用/待补刻） |
| ProofRecord 试印记录 | `src/types/proof.ts` | 字符或字盘、压力 kg、用墨、印次、样张编号、清晰度评价（清晰/偏淡/糊版）、试印日期 |

### IndexedDB 版本与升级迁移（Dexie）

- **v1**：建 `matrices` 表（含 code / character / font / sizeName / material / availability 索引）
- **v2**：加 `cases` 表与 `matrixId` 多值索引；升级时按 `slots` 回填历史字盘的 `matrixId`
- **v3**：加 `defects`、`proofs` 表；升级时为「停用 / 待补刻」的历史字模回填缺损原因记录（同时预先声明 `loans` 表，保证 v4 升级不丢旧数据）
- **v4**：加 `loans` 表（借调批次，含 `*matrixIds` 多值索引）；升级时补齐明细字段与 `matrixIds`，**凡缺少乐观锁 `version` 的未结束批次一律转为「待复核」，绝不自动完成**，需人工核对原格位引用后复核通过或取消重建

### 借调批次的一致性规则

- **建批即冻结**：批次建立后成员字模可用性转为「借调中」，原格位在字盘编辑器中标记冻结，不能再落位 / 取出 / 调换；总览与字模详情可随时追溯到批次。
- **唯一占用**：同一字模不能同时留在两个未结束（进行中 / 待复核）批次，应用层与数据库事务双重校验。
- **乐观锁**：批次带 `version`，每次保存 +1；两个标签页同时编辑时，后保存者若版本过期会收到版本冲突，先保存的结果不会被覆盖。保存成功的标签页通过 `storage` 事件通知其它标签页刷新。
- **目标格位编排**：校验边界容量、同批格位重复、目标盘现存引用与同盘借调腾出的格位；任一冲突即拒绝，不留下半成品。
- **完成批次**：单个 IndexedDB 事务内同步「原格位取出 → 目标格位落位（重建 matrixId 索引）→ 字模恢复借出前可用性 → 批次置为已完成」，任一步失败整体回滚。
- **关页可续**：批次本身落库，目标格位编排同时存 localStorage 草稿（`gbmovabletype-draft:loan-*`），关闭页面后重新打开仍可继续。

首次打开且库为空时会写入一批示例档案（16 枚字模、2 个字盘、5 条缺损、6 条试印），便于直接体验；已有数据则跳过。

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | `Overview` | 字模总览：按字体 / 字号 / 材质 / 可用性筛选，卡片显示字符大样与缺损角标，可按部首笔画排序 |
| `/matrices/new` | `MatrixNew` | 字模登记：字符选择器按部首与笔画校验并给出候选，填写字体、字号、材质、尺寸与年代 |
| `/matrices/:id` | `MatrixDetail` | 字模详情：字面信息、所在字盘格位、缺损历史、试印记录，可就地新增缺损或试印、补刻恢复可用 |
| `/cases` | `CaseEditor` | 字盘布局编辑器：行列网格点击落位 / 取出 / 调换，实时提示空格与重复落位；借调批次冻结的原格位不可改动 |
| `/loans` | `LoanBoard` | 巡展借调批次：总览统计（出库中 / 进行中 / 待复核 / 已完成）、新增批次（选字模 + 记录原格位与目标字盘）、取消与复核 |
| `/loans/:id` | `LoanDetail` | 批次编排：目标字盘格位分配、容量与引用冲突提示、乐观锁版本冲突横幅、完成批次（原子同步字盘 / 字模 / 批次） |
| `/defects` | `DefectBoard` | 缺损登记：提交后自动停用字模并进入待补刻清单，补刻完成一键恢复 |
| `/proofs` | `ProofList` | 试印记录：登记压力、用墨与清晰度，按样张编号回溯试印批次 |

## 目录结构

```
.
├── docker-compose.yml        # 无 version 字段；顶层 name: gbmovabletype
├── .env.example              # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine → nginx:alpine
    ├── nginx.conf            # try_files 前端路由兜底 + gzip
    ├── index.html
    ├── package.json          # build = tsc -b && vite build
    ├── tailwind.config.js / postcss.config.js / vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{matrix,case,loan,defect,proof}.ts
        ├── db/index.ts       # Dexie 库、版本迁移（v1–v4）、示例档案
        ├── stores/{matrixStore,caseStore,loanStore,uiStore}.ts
        ├── hooks/{useMatrixSearch,useLocalDraft,useCaseSlots,useLoanEditor}.ts
        ├── components/common/{MatrixCell,LayoutGrid,CharacterPicker,DefectBadge,EmptyState}.tsx
        ├── components/loan/LoanCreateWizard.tsx
        ├── layouts/AppShell.tsx
        ├── pages/{Overview,MatrixNew,MatrixDetail,CaseEditor,LoanBoard,LoanDetail,DefectBoard,ProofList}.tsx
        ├── router/index.tsx
        └── utils/{charIndex,layout,format}.ts
```

## 数据存储说明

- **业务数据**：IndexedDB（Dexie，库名 `gbmovabletype-db`，共 5 张表 `matrices` / `cases` / `loans` / `defects` / `proofs`）。写入前统一 `toPlain()` 深拷贝，避免响应式对象写库抛 `DataCloneError`。借调批次的完成操作在单事务内同时写 `loans` / `cases` / `matrices`，冲突即整体回滚。
- **草稿数据**：localStorage，前缀 `gbmovabletype-draft:`，覆盖字模登记、字盘布局、缺损登记、试印登记与借调批次编排五处表单，刷新后可恢复。
- **界面偏好**：localStorage，键 `gbmovabletype-ui`（Zustand persist，保存筛选条件与当前选中字盘）。
- **跨标签页通知**：localStorage 键 `gbmovabletype-loan-changed`；任一标签页保存批次后广播，其它标签页重读库，版本过期的编辑器在下次保存时收到乐观锁冲突。
- 容器完全无状态：不挂载命名卷、不连接数据库服务，删除重建容器不影响浏览器里的档案。

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev      # http://localhost:21829
npm run build    # 类型检查 + 生产构建
```

## 说明

- `frontend/public` 下静态资源已 `chmod 644`，Dockerfile 运行阶段额外 `chmod -R a+rX`，避免 nginx worker 读不到导致 favicon 403。
- 所有表单的数值输入均带 `min` / `max` 约束，枚举字段提供固定选项，不在前端做自由文本写入。
