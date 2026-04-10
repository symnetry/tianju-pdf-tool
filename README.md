# 天聚订单处理工具

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
- **UPC 大小写不敏感匹配**（2026-04-08 更新）：
  - 匹配时忽略大小写差异
  - 例如："Ody-Marshmallow" 和 "Ody-marshmallow" 会被正确匹配
- **orderNo 不可信处理**（2026-04-09 更新）：
  - 当同一个 UPC 以不同大小写形式出现时，orderNo 已不可信
  - single 类型也使用 `outputItemKeySet` 来计算 slot 占用
  - 使用 `outputItemKey` 来聚合拣货单（UPC 和 SKU 都转成小写）
- **single 类型 UPC 大小写合并**（2026-04-09 更新）：
  - 合并大小写相同且 upcDescList 完全相同的 UPC
  - 按 UPC 小写 + upcDescList 精确匹配分组
  - 例如："AAA*3" 和 "AAA*1" 会被分到不同组，分别生成 cover
- **single 类型批次优化**（2026-04-09 更新）：
  - 先把所有 single 批次合并成一个大批次
  - 使用 `outputItemKeySet` 去重计算 slot 占用
  - 确保每批尽量填满 15 个不同 SKU
- **single 类型拣货单聚合**（2026-04-09 更新）：
  - single 类型也做拣货单聚合
  - 与 multiple 类型保持一致的聚合逻辑
- **single 类型 labelDesc 获取方式修复**（2026-04-09 更新）：
  - 发现 shared labelDesc item 的问题：多个只是大小写不同的 UPC 共享同一个 labelDesc item
  - 改回使用 `allocateLabelItemsByDemand` 获取 labelItems，而不是用 `collectLabelItems`
  - 不传 fallbackOrderNo，让它用原始 item 的 orderNo
- **preprocessBatch 合并逻辑优化**（2026-04-09 更新）：
  - 直接从 batch.labelDesc 中查找 UPC 匹配的 item，而不是用 orderNo 去匹配
  - 按 UPC 小写 + 库位信息作为合并 key
  - 正确合并像 "Shiliu-lv" 和 "shiliu-lv" 这种共享 labelDesc item 的 UPC

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
5. **UPC 大小写处理**（2026-04-08 更新）：
   - multiple 类型的 UPC 匹配已改为大小写不敏感
   - 例如："Ody-Marshmallow" 和 "Ody-marshmallow" 会被正确匹配
   - 最终拣货单中 UPC 的大小写原样保留，不会被统一转换
6. **orderNo 不可信**（2026-04-09 更新）：
   - 当同一个 UPC 以不同大小写形式出现在 upcUniqueList 中时（如 "Shiliu-lv" 和 "shiliu-lv"）
   - 根据订单号获取拣货单时，只会返回一个整合了的拣货单
   - 所以 single 类型也不能使用 orderNo 来做匹配了
   - 现在 single 类型也使用 `outputItemKeySet` 来计算 slot 占用
   - 使用 `outputItemKey` 来聚合拣货单（UPC 和 SKU 都转成小写）
7. **single 类型 UPC 大小写合并**（2026-04-09 更新）：
   - 合并大小写相同且 upcDescList 完全相同的 UPC
   - 按 UPC 小写 + upcDescList 精确匹配分组
   - 例如："AAA*3" 和 "AAA*1" 会被分到不同组，分别生成 cover
8. **single 类型批次优化**（2026-04-09 更新）：
   - 先把所有 single 批次合并成一个大批次
   - 使用 `outputItemKeySet` 去重计算 slot 占用
   - 确保每批尽量填满 15 个不同 SKU
   - 相同的 UPC 不会被切分到不同批次
   - 不会出现数据丢失问题
9. **labelDesc 中的 orderNo 不重要**（2026-04-09 更新）：
   - 拣货单不打印 orderNo，所以 labelDesc 中的 orderNo 字段不重要
   - 当多个只是大小写不同的 UPC 共享同一个 labelDesc item 时，orderNo 只是其中一个订单号
   - 只要拣货单中的库位、UPC、数量正确就行
10. **preprocessBatch 合并逻辑**（2026-04-09 更新）：
    - 直接从 batch.labelDesc 中查找 UPC 匹配的 item，而不是用 orderNo 去匹配
    - 按 UPC 小写 + 库位信息作为合并 key
    - 正确合并像 "Shiliu-lv" 和 "shiliu-lv" 这种共享 labelDesc item 的 UPC

## 历史脚本

- `process-ordersV2.js`：旧版 JSON 结构
- `process-ordersV3.js`：中间版本
- 当前推荐使用：`process-ordersV4.js`

