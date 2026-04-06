# 天炬订单处理工具

用于处理订单 JSON、优化拣货批次、下载面单，并生成最终的批次 PDF。

## 环境要求

- Node.js 20.x 或更高版本
- 已安装项目依赖：`pdfkit`、`pdf-lib`

安装依赖：

```bash
pnpm install
```

如果没有 `pnpm`，也可以使用：

```bash
npm install
```

## 主要脚本

### `process-ordersV4.js`
当前主入口。

功能：
- 读取订单 JSON
- 先执行拣货优化
- 用优化后的结果覆盖原始 JSON
- 下载面单
- 生成拣货单 PDF
- 合并为每批的 `merged.pdf`

命令格式：

```bash
node process-ordersV4.js <json文件> [输出文件夹名] [-JSON=true] [--box-size=15] [--skip-optimize]
```

参数说明：
- `<json文件>`：输入订单 JSON 文件
- `[输出文件夹名]`：输出目录，默认是 `output`
- `-JSON=true`：在每个批次目录中保留 `order.json`
- `--box-size=15`：优化阶段每批最大 UPC 类别数
- `--skip-optimize`：跳过优化；跳过时不会覆盖原 JSON，也不会被当成输出文件夹
- 除 `-JSON=true`、`--box-size=...`、`--skip-optimize` 外，其它未识别位置参数会被当成输出文件夹名

示例：

```bash
node process-ordersV4.js tianju_orders_1774711163123.json
node process-ordersV4.js tianju_orders_1774711163123.json output -JSON=true
node process-ordersV4.js tianju_orders_1774711163123.json output --box-size=15
node process-ordersV4.js tianju_orders_1774711163123.json output --skip-optimize
node process-ordersV4.js tianju_orders_1774711163123.json --skip-optimize
```

最后一条命令会跳过优化，并继续输出到默认目录 `output`，不会生成名为 `--skip-optimize` 的文件夹。

### `optimize-pick-batches.js`
单独执行拣货优化，不生成 PDF。

命令格式：

```bash
node optimize-pick-batches.js <输入JSON> [输出JSON] [--box-size=15]
```

功能：
- 保持 `upcUniqueList` 与 `orders` 的索引关系不变
- `single` / `multiple` 分开优化
- 优先按 `zoneName` 聚合
- 尽量让同一批次靠近同一 `shelfName`
- `single` 中每组 `orders` 按数量从大到小排序

示例：

```bash
node optimize-pick-batches.js tianju_orders_1774711163123.json
node optimize-pick-batches.js tianju_orders_1774711163123.json optimized.json
```

## 输出结构

```text
output/
├── single/
│   ├── Batch_1/
│   │   ├── merged.pdf
│   │   └── order.json
│   ├── Batch_2/
│   └── ...
└── multiple/
    ├── Batch_1/
    ├── Batch_2/
    └── ...
```

说明：
- 默认最终保留 `merged.pdf`
- 只有传入 `-JSON=true` 时才会保留批次 `order.json`
- 中间下载的 PDF、cover、pick-list 会在合并完成后自动删除

## 数据结构说明

输入 JSON 主要包含：
- `single`
- `multiple`

每个批次内包含：
- `upcUniqueList`
- `orders`
- `orderNoList`
- `pickNo`
- `labelDesc`

其中：
- `upcUniqueList[i]` 对应 `orders[i]`
- `labelDesc` 表示仓库中的分区与货架位置

## 注意事项

1. 默认会覆盖输入 JSON，请先确认是否接受该行为。
2. 如果不希望覆盖原文件，请使用 `--skip-optimize`，或者先手动备份原 JSON。
3. 需要稳定网络以下载 `expressLabelUrl` 对应的 PDF。
4. 请确保当前目录已正确安装依赖，否则可能出现 `Cannot find module 'pdfkit'` 等错误。

## 历史脚本

- `process-ordersV2.js`：旧版 JSON 结构
- `process-ordersV3.js`：中间版本
- 当前推荐使用：`process-ordersV4.js`
