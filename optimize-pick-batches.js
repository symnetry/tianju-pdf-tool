const fs = require("fs");
const path = require("path");

/**
 * 这个脚本的目标不是改业务数据，而是在不破坏 `upcUniqueList[i] <-> orders[i]`
 * 对应关系的前提下，按“更方便拣货”的方式重排 JSON。
 *
 * 核心思路：
 * 1. 把每个 `upcUniqueList[i] + orders[i]` 视为一个不可拆分的 group。
 * 2. 从 `labelDesc` 提取 zone / shelf 信息，判断哪些 group 更接近。
 * 3. 用启发式评分把相近 group 尽量放进同一批，减少跨区、跨货架来回走动。
 * 4. `single` 组内再按件数从大到小排序，优先处理大单。
 *
 * 注意：这里计算的不是仓库里的真实物理距离，而是把货位名映射成一个近似的
 * `travelIndex`（行走顺序索引），用于排序和聚类，让输出更贴近拣货路径。
 */
const DEFAULT_BOX_SIZE = 15;
const SHELF_PREFIX_ORDER = [
	"AA",
	"BB",
	"CC",
	"DD",
	"EE",
	"FF",
	"GG",
	"HH",
	"JJ",
	"KK",
	"LL",
	"MM",
	"NN",
	"PP",
	"QQ",
	"RR",
	"SS",
	"TT",
	"UU",
	"VV",
	"WW",
	"XX",
	"YY",
];
const SHELF_POSITION_CACHE = new Map();
const KNOWN_DOUBLE_PREFIX_RANK = new Map(
	SHELF_PREFIX_ORDER.map((prefix, index) => [prefix, index]),
);

/**
 * 解析命令行参数，并补全默认输出路径。
 *
 * @param {string[]} argv Node.js 原始命令行参数，一般直接传 `process.argv`。
 * @returns {{ inputPath: string, outputPath: string, boxSize: number }}
 * 返回标准化后的输入路径、输出路径和每批最大装箱数。
 */
function parseArgs(argv) {

	const args = argv.slice(2);
	if (args.length < 1) {
		console.error(
			"使用方法: node optimize-pick-batches.js <输入JSON> [输出JSON] [--box-size=15]",
		);
		process.exit(1);
	}

	const options = {
		inputPath: path.resolve(args[0]),
		outputPath: "",
		boxSize: DEFAULT_BOX_SIZE,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--box-size=")) {
			const value = Number(arg.split("=")[1]);
			if (!Number.isFinite(value) || value <= 0) {
				console.error("--box-size 必须是正整数");
				process.exit(1);
			}
			options.boxSize = Math.floor(value);
		} else if (!options.outputPath) {
			options.outputPath = path.resolve(arg);
		}
	}

	if (!options.outputPath) {
		const parsed = path.parse(options.inputPath);
		options.outputPath = path.join(
			parsed.dir,
			`${parsed.name}.optimized${parsed.ext || ".json"}`,
		);
	}

	return options;
}

/**
 * 读取并解析 JSON 文件。
 *
 * @param {string} filePath JSON 文件绝对路径或相对路径。
 * @returns {Record<string, any>} 解析后的订单数据对象。
 */
function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 将优化结果写回 JSON 文件。
 *
 * @param {string} filePath 输出文件路径。
 * @param {Record<string, any>} data 需要写入的 JSON 对象。
 * @returns {void}
 */
function writeJson(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 从 `Shiliu-lv*4` 这类描述中提取件数。
 *
 * @param {string} upcDesc 单个 `upcDescList` 项。
 * @returns {number} 提取到的数量；如果末尾没有 `*数字`，默认返回 `1`。
 */
function parseQuantity(upcDesc) {
	const match = String(upcDesc || "").match(/\*(\d+)$/);
	return match ? Number(match[1]) : 1;
}

/**
 * 统计单个订单的总件数。
 *
 * @param {{ upcDescList?: string[] }} order 订单对象。
 * @returns {number} 订单中所有 `upcDescList` 项累加后的总件数。
 */
function getOrderPieceCount(order) {
	const upcDescList = Array.isArray(order?.upcDescList) ? order.upcDescList : [];
	let total = 0;
	for (const upcDesc of upcDescList) {
		total += parseQuantity(upcDesc);
	}
	return total;
}

/**
 * 按订单总件数从大到小排序；同件数时按订单号稳定排序。
 *
 * @param {Array<{ orderNo?: string, upcDescList?: string[] }>} orders 原始订单数组。
 * @returns {Array<{ orderNo?: string, upcDescList?: string[] }>} 排序后的新数组，不修改原数组。
 */
function sortOrdersByQuantityDesc(orders) {
	return [...orders].sort((a, b) => {
		const quantityDiff = getOrderPieceCount(b) - getOrderPieceCount(a);
		if (quantityDiff !== 0) return quantityDiff;
		return String(a?.orderNo || "").localeCompare(String(b?.orderNo || ""));
	});
}

/**
 * 估算一个 group 在 `single` 模式下占用多少“装箱槽位”。
 *
 * `single` 不做最终聚合，仍沿用原来的单组估算方式；
 * `multiple` 则改为按最终聚合后的输出 key 数来控批，不再直接使用这个值做容量判断。
 *
 * @param {Array<{ upcDescList?: string[] }>} orders 该 group 对应的订单数组。
 * @returns {number} 当前 group 的槽位成本，至少为 `1`。
 */
function getSingleGroupSlotCost(orders) {
	const firstOrder = orders.find((item) => item && Array.isArray(item.upcDescList));
	return Math.max(firstOrder?.upcDescList?.length || 1, 1);
}

/**
 * 构造 `multiple` 最终聚合时使用的唯一 key。
 *
 * 这里必须与 `aggregateOutputLabelItems` 的聚合口径保持一致，这样装箱时限制的
 * 才是“最终拣货单真正会显示出来的明细数”。
 *
 * @param {{ zoneNo?: string, zoneName?: string, shelfNo?: string, shelfName?: string, upc?: string, sku?: string }} rawItem 原始明细项。
 * @returns {string} 可用于去重统计的稳定 key。
 */
function buildAggregatedOutputItemKey(rawItem) {
	const item = normalizeLabelItem(rawItem, rawItem?.zoneName);
	return [
		item.zoneNo,
		item.zoneName,
		item.shelfNo,
		item.shelfName,
		item.upc,
		item.sku,
	].join("||");
}

/**
 * 为一个 group 预先计算“最终聚合后会贡献哪些输出项 key”。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {Array<Record<string, any>>} labelItems 当前 group 的货位明细。
 * @returns {Set<string>} 该 group 的输出项 key 集合。
 */
function buildGroupOutputItemKeySet(type, labelItems) {
	if (type !== "multiple") {
		return new Set();
	}

	const keySet = new Set();
	for (const item of labelItems || []) {
		keySet.add(buildAggregatedOutputItemKey(item));
	}
	return keySet;
}


/**
 * 统一清洗 `labelDesc.items` 中的单条明细，补齐字段兜底值。
 *
 * @param {Record<string, any>} item 原始货位明细项。
 * @param {string} fallbackZoneName 当 `item.zoneName` 缺失时使用的 zone 名称。
 * @returns {{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }}
 * 统一结构后的标签明细。
 */
function normalizeLabelItem(item, fallbackZoneName) {
	return {
		zoneNo: item?.zoneNo || "",
		zoneName: item?.zoneName || fallbackZoneName || "UNKNOWN",
		shelfNo: item?.shelfNo || "",
		shelfName: item?.shelfName || "UNKNOWN",
		upc: item?.upc || item?.sku || "",
		sku: item?.sku || "",
		orderNo: item?.orderNo || "",
		num: Number(item?.num) || 0,
	};
}

/**
 * 从 `MNTZ-D-004*3` 这类描述中提取 UPC 编码。
 *
 * @param {string} upcDesc 单个 `upcDescList` 项。
 * @returns {string} 去掉末尾数量标记后的 UPC 文本。
 */
function extractUpc(upcDesc) {
	return String(upcDesc || "").replace(/\*\d+$/, "").trim();
}

/**
 * 向数量 Map 中累加指定键的数量。
 *
 * @param {Map<string, number>} quantityMap 目标数量表。
 * @param {string} key 需要累加的键。
 * @param {number} qty 本次增加的数量。
 * @returns {void}
 */
function addQuantityToMap(quantityMap, key, qty) {
	if (!key) return;
	const value = Number(qty) || 0;
	if (value <= 0) return;
	quantityMap.set(key, (quantityMap.get(key) || 0) + value);
}

/**
 * 汇总一组订单里的 UPC 需求量。
 *
 * @param {Array<{ upcDescList?: string[] }>} orders 当前 group 对应的订单数组。
 * @returns {Map<string, number>} key 为 UPC，value 为当前 group 需要的总数量。
 */
function buildUpcDemandMap(orders) {
	const demandMap = new Map();
	for (const order of orders || []) {
		for (const upcDesc of Array.isArray(order?.upcDescList) ? order.upcDescList : []) {
			addQuantityToMap(demandMap, extractUpc(upcDesc), parseQuantity(upcDesc));
		}
	}
	return demandMap;
}

/**
 * 扁平化 `labelDesc`，统一得到便于后续分配的货位明细数组。
 *
 * @param {Array<{ zoneName?: string, items?: Array<Record<string, any>> }>} labelDesc 原始批次中的货位明细。
 * @returns {Array<{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }>}
 * 清洗后的扁平化货位明细数组。
 */
function flattenLabelItems(labelDesc) {
	const labelItems = [];
	if (!Array.isArray(labelDesc)) {
		return labelItems;
	}

	for (const zone of labelDesc) {
		const zoneName = zone?.zoneName || "UNKNOWN";
		for (const rawItem of Array.isArray(zone?.items) ? zone.items : []) {
			labelItems.push(normalizeLabelItem(rawItem, zoneName));
		}
	}

	return labelItems;
}

/**
 * 按订单号把 `labelDesc` 建成索引，便于后面快速回收某个 group 的所有货位信息。
 *
 * @param {Array<{ zoneName?: string, items?: Array<Record<string, any>> }>} labelDesc 原始批次中的货位明细。
 * @returns {Map<string, Array<{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }>>}
 * key 为 `orderNo`，value 为该订单对应的所有货位行。
 */
function buildOrderLabelMap(labelDesc) {
	const orderLabelMap = new Map();
	for (const item of flattenLabelItems(labelDesc)) {
		if (!item.orderNo) continue;
		if (!orderLabelMap.has(item.orderNo)) {
			orderLabelMap.set(item.orderNo, []);
		}
		orderLabelMap.get(item.orderNo).push(item);
	}
	return orderLabelMap;
}

/**
 * 为 `multiple` 批次创建一个可递减分配的货位池。
 *
 * @param {Array<{ zoneName?: string, items?: Array<Record<string, any>> }>} labelDesc 原始批次中的货位明细。
 * @returns {Array<{ item: Record<string, any>, remaining: number }>} 可按数量逐步消耗的货位池。
 */
function createLabelPool(labelDesc) {
	return flattenLabelItems(labelDesc).map((item) => ({
		item,
		remaining: Math.max(Number(item.num) || 0, 0),
	}));
}

/**
 * 按 UPC 需求从货位池中切出当前 group 需要的明细。
 *
 * `multiple` 批次里的 `labelDesc.items[].orderNo` 经常只是整批汇总时的代表值，
 * 不能再按订单号反查；这里改为按 UPC 数量从原批次货位池里顺序分配，避免明细丢失。
 *
 * @param {Map<string, number>} demandMap 当前 group 的 UPC 需求量。
 * @param {Array<{ item: Record<string, any>, remaining: number }>} labelPool 原批次剩余可分配的货位池。
 * @param {string} fallbackOrderNo 当前 group 的兜底订单号，仅用于保持输出稳定。
 * @returns {Array<Record<string, any>>} 分配给当前 group 的货位明细。
 */
function allocateLabelItemsByDemand(demandMap, labelPool, fallbackOrderNo = "") {
	const allocatedItems = [];

	for (const [upc, demandQty] of demandMap.entries()) {
		let remainingDemand = Number(demandQty) || 0;
		if (!upc || remainingDemand <= 0) continue;

		for (const entry of labelPool || []) {
			if (remainingDemand <= 0) break;
			if ((entry?.remaining || 0) <= 0) continue;
			const itemUpc = entry?.item?.upc || entry?.item?.sku || "";
			if (itemUpc.toLowerCase() !== upc.toLowerCase()) continue;

			const takeQty = Math.min(entry.remaining, remainingDemand);
			if (takeQty <= 0) continue;

			allocatedItems.push({
				...entry.item,
				orderNo: fallbackOrderNo || entry.item.orderNo,
				num: takeQty,
			});
			entry.remaining -= takeQty;
			remainingDemand -= takeQty;
		}
	}

	return allocatedItems;
}



/**
 * 以“自然排序”比较两个文本值。
 *
 * @param {string} a 左侧文本。
 * @param {string} b 右侧文本。
 * @returns {number} 适用于 `Array.prototype.sort` 的比较结果。
 */
function compareNaturalText(a, b) {
	return String(a || "").localeCompare(String(b || ""), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

/**
 * 把通用字母前缀编码为可比较的序号。
 *
 * @param {string} prefix 例如 `A`、`H`、`TT`。
 * @returns {number} 可用于排序的前缀权重值。
 */
function getGenericPrefixRank(prefix) {
	let rank = 0;
	for (const char of String(prefix || "")) {
		const code = char.charCodeAt(0);
		const normalizedCode = code >= 65 && code <= 90 ? code - 64 : 27;
		rank = rank * 27 + normalizedCode;
	}
	return rank;
}

/**
 * 将数字或特殊标记统一编码为可比较的数值。
 *
 * @param {number|string|undefined} token 拆分出来的单段 token。
 * @param {number} [fallback=999] token 无法识别时的兜底值。
 * @returns {number} 标准化后的数值，用于排序和构造 `travelIndex`。
 */
function encodeTokenValue(token, fallback = 999) {
	if (typeof token === "number" && Number.isFinite(token)) {
		return token;
	}
	if (token === "TOP") {
		return 900;
	}
	return fallback;
}

/**
 * 解析非 2220 仓的通用货位格式。
 *
 * @param {string} prefix 货位前缀字母区，如 `T`、`H`、`A`。
 * @param {string} remainder 去掉前缀后的剩余部分，如 `15_10`、`017-3-1`。
 * @returns {{ prefix: string, number: number, row: number, column: number, side: number, detail: number, travelIndex: number }}
 * 统一后的货位位置对象。
 */
function parseGenericShelfPosition(prefix, remainder) {
	// 兼容 `T10`、`H15_1`、`H15_10`、`A017-3-1`、`A016-TOP` 这类非 2220 仓格式。
	// 规则上按“字母区 + 主编号 + 子位/层位”做自然排序，用于近似拣货路径。
	const tokens = String(remainder || "").match(/[A-Z]+|\d+/g) || [];

	const parsedTokens = tokens.map((token) =>
		/^\d+$/.test(token) ? Number(token) : token,
	);
	const number = encodeTokenValue(parsedTokens[0]);
	const side = encodeTokenValue(parsedTokens[1], 0);
	const detail = encodeTokenValue(parsedTokens[2], 0);
	const row = 1000 + getGenericPrefixRank(prefix);
	return {
		prefix,
		number,
		row,
		column: number,
		side,
		detail,
		travelIndex: row * 1000000 + number * 10000 + side * 100 + detail,
	};
}

/**
 * 解析货位名称，并转换为统一可比较的位置对象。
 *
 * @param {string} shelfName 原始货位名，如 `AA001`、`T10`、`H15_10`。
 * @returns {{ prefix: string, number: number, row: number, column: number, side: number, detail: number, travelIndex: number }}
 * 供货位比较、路径估算和聚类评分使用的标准位置对象。
 */
function parseShelfPosition(shelfName) {
	// 把货架编码映射成“相对行走顺序”，用于近似判断两个货位是否靠近。
	// 这不是精确物理距离，但足够支撑批次聚类和拣货顺序优化。
	const normalized = String(shelfName || "").trim().toUpperCase();
	if (SHELF_POSITION_CACHE.has(normalized)) {
		return SHELF_POSITION_CACHE.get(normalized);
	}

	let position;
	const knownDoubleMatch = normalized.match(/^([A-Z]{2})(\d{3})$/);
	if (knownDoubleMatch && KNOWN_DOUBLE_PREFIX_RANK.has(knownDoubleMatch[1])) {
		const [, prefix, numStr] = knownDoubleMatch;
		const number = Number(numStr);
		const row = KNOWN_DOUBLE_PREFIX_RANK.get(prefix);
		// 2220 仓这类 `AA001` / `BB014` / `CC030` 货位，按前缀分区后直接使用数字升序。
		// 不再假设同一字母区内部走蛇形路径，避免出现 `AA017` 被排在 `AA001` 前面。
		position = {
			prefix,
			number,
			row,
			column: number,
			side: 0,
			detail: 0,
			travelIndex: row * 1000000 + number * 100,
		};
	} else {
		const genericMatch = normalized.match(/^([A-Z]+)(.*)$/);
		if (genericMatch) {
			const [, prefix, remainder] = genericMatch;
			position = parseGenericShelfPosition(prefix, remainder);
		} else if (/^\d+$/.test(normalized)) {
			const number = Number(normalized);
			position = {
				prefix: "NUM",
				number,
				row: 5000,
				column: number,
				side: 0,
				detail: 0,
				travelIndex: 5000 * 1000000 + number * 10000,
			};
		} else {
			position = {
				prefix: "ZZ",
				number: 999,
				row: 9999,
				column: 999,
				side: 999,
				detail: 999,
				travelIndex: 9999999999,
			};
		}
	}

	SHELF_POSITION_CACHE.set(normalized, position);
	return position;
}

/**
 * 按统一货位规则比较两个 `shelfName`。
 *
 * @param {string} a 左侧货位名。
 * @param {string} b 右侧货位名。
 * @returns {number} 适用于排序的比较结果。
 */
function compareShelves(a, b) {
	const pa = parseShelfPosition(a);
	const pb = parseShelfPosition(b);
	if (pa.row !== pb.row) return pa.row - pb.row;
	if (pa.column !== pb.column) return pa.column - pb.column;
	if (pa.side !== pb.side) return pa.side - pb.side;
	if (pa.detail !== pb.detail) return pa.detail - pb.detail;
	return compareNaturalText(a, b);
}

/**
 * 比较两个 zone 名称，采用数值友好的自然顺序。
 *
 * @param {string} a 左侧 zone 名。
 * @param {string} b 右侧 zone 名。
 * @returns {number} 适用于排序的比较结果。
 */
function compareZones(a, b) {
	return String(a || "").localeCompare(String(b || ""), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

/**
 * 用于 `labelDesc.items` 的最终排序：先 zone，再 shelf，再 upc，最后 orderNo。
 *
 * @param {{ zoneName?: string, shelfName?: string, upc?: string, orderNo?: string }} a 左侧明细。
 * @param {{ zoneName?: string, shelfName?: string, upc?: string, orderNo?: string }} b 右侧明细。
 * @returns {number} 适用于排序的比较结果。
 */
function compareLabelItems(a, b) {
	const zoneCompare = compareZones(a.zoneName, b.zoneName);
	if (zoneCompare !== 0) return zoneCompare;
	const shelfCompare = compareShelves(a.shelfName, b.shelfName);
	if (shelfCompare !== 0) return shelfCompare;
	const upcCompare = String(a.upc || "").localeCompare(String(b.upc || ""));
	if (upcCompare !== 0) return upcCompare;
	return String(a.orderNo || "").localeCompare(String(b.orderNo || ""));
}

/**
 * 汇总一个 group 的货位特征，用于后续排序、聚类和评分。
 *
 * @param {Array<{ zoneName?: string, shelfName?: string, num?: number }>} labelItems 当前 group 关联到的全部货位明细。
 * @returns {{
 *   zoneSet: Set<string>,
 *   shelfSet: Set<string>,
 *   prefixSet: Set<string>,
 *   zoneNames: string[],
 *   shelfNames: string[],
 *   dominantZone: string,
 *   dominantShelf: string,
 *   anchorShelfKey: string,
 *   anchorPosition: { prefix: string, number: number, row: number, column: number, side: number, detail: number, travelIndex: number },
 *   totalQty: number,
 *   minTravelIndex: number,
 *   maxTravelIndex: number,
 *   avgTravelIndex: number
 * }} 该 group 的位置摘要信息。
 */
function buildLocationSummary(labelItems) {
	const zoneWeights = new Map();
	const shelfWeights = new Map();
	const zoneShelfWeights = new Map();
	const zoneSet = new Set();
	const shelfSet = new Set();
	const prefixSet = new Set();
	let totalQty = 0;
	let weightedTravelIndex = 0;
	let minTravelIndex = Infinity;
	let maxTravelIndex = -Infinity;

	for (const item of labelItems) {
		const qty = Number(item.num) || 1;
		const zoneName = item.zoneName || "UNKNOWN";
		const shelfName = item.shelfName || "UNKNOWN";
		const shelfKey = `${zoneName}__${shelfName}`;
		const position = parseShelfPosition(shelfName);

		totalQty += qty;
		weightedTravelIndex += position.travelIndex * qty;
		minTravelIndex = Math.min(minTravelIndex, position.travelIndex);
		maxTravelIndex = Math.max(maxTravelIndex, position.travelIndex);
		zoneSet.add(zoneName);
		shelfSet.add(shelfName);
		prefixSet.add(position.prefix);
		zoneWeights.set(zoneName, (zoneWeights.get(zoneName) || 0) + qty);
		shelfWeights.set(shelfName, (shelfWeights.get(shelfName) || 0) + qty);
		zoneShelfWeights.set(shelfKey, (zoneShelfWeights.get(shelfKey) || 0) + qty);
	}

	const dominantZone = pickMaxKey(zoneWeights) || "UNKNOWN";
	const dominantShelf = pickMaxKey(shelfWeights) || "UNKNOWN";
	const anchorShelfKey = pickMaxKey(zoneShelfWeights) || `${dominantZone}__${dominantShelf}`;
	const [, anchorShelfName = dominantShelf] = anchorShelfKey.split("__");
	const anchorPosition = parseShelfPosition(anchorShelfName);
	const fallbackTravelIndex = anchorPosition.travelIndex;

	return {
		zoneSet,
		shelfSet,
		prefixSet,
		zoneNames: [...zoneSet].sort(compareZones),
		shelfNames: [...shelfSet].sort(compareShelves),
		dominantZone,
		dominantShelf,
		anchorShelfKey,
		anchorPosition,
		totalQty,
		minTravelIndex: Number.isFinite(minTravelIndex)
			? minTravelIndex
			: fallbackTravelIndex,
		maxTravelIndex: Number.isFinite(maxTravelIndex)
			? maxTravelIndex
			: fallbackTravelIndex,
		avgTravelIndex:
			totalQty > 0 ? weightedTravelIndex / totalQty : fallbackTravelIndex,
	};
}


/**
 * 从权重 Map 中找出权重最大的 key。
 *
 * @param {Map<string, number>} weightMap 权重表。
 * @returns {string} 权重最大的 key；如果为空 Map，则返回空字符串。
 */
function pickMaxKey(weightMap) {
	let bestKey = "";
	let bestValue = -Infinity;
	for (const [key, value] of weightMap.entries()) {
		if (value > bestValue) {
			bestKey = key;
			bestValue = value;
		}
	}
	return bestKey;
}

/**
 * 汇总一个 group 中订单相关的基础信息。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {Array<{ orderNo?: string, upcDescList?: string[] }>} rawOrders 原始订单数组。
 * @returns {{ orders: Array<Record<string, any>>, orderNoList: string[], pieceCount: number }}
 * 返回排序后的订单数组、去重订单号列表和总件数。
 */
function summarizeOrders(type, rawOrders) {
	const orders = type === "single" ? sortOrdersByQuantityDesc(rawOrders) : [...rawOrders];
	const orderNoSet = new Set();
	let pieceCount = 0;

	for (const order of orders) {
		if (order?.orderNo) {
			orderNoSet.add(order.orderNo);
		}
		const upcDescList = Array.isArray(order?.upcDescList) ? order.upcDescList : [];
		for (const upcDesc of upcDescList) {
			pieceCount += parseQuantity(upcDesc);
		}
	}

	return {
		orders,
		orderNoList: [...orderNoSet],
		pieceCount,
	};
}

/**
 * 按订单号列表从 `orderLabelMap` 中回收当前 group 对应的全部货位行。
 *
 * @param {string[]} orderNoList 当前 group 的订单号列表。
 * @param {Map<string, Array<Record<string, any>>>} orderLabelMap 按订单号建立的货位索引。
 * @returns {Array<Record<string, any>>} 当前 group 对应的全部 `labelItems`。
 */
function collectLabelItems(orderNoList, orderLabelMap) {
	const labelItems = [];
	for (const orderNo of orderNoList) {
		const items = orderLabelMap.get(orderNo);
		if (items?.length) {
			labelItems.push(...items);
		}
	}
	return labelItems;
}

/**
 * 将原始批次拆成可稳定重排的 group 列表。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {Array<Record<string, any>>} batches 原始批次数组。
 * @returns {Array<{
 *   id: string,
 *   type: string,
 *   originalBatchIndex: number,
 *   upcUnique: string,
 *   orders: Array<Record<string, any>>,
 *   orderNoList: string[],
 *   labelItems: Array<Record<string, any>>,
 *   slotCost: number,
 *   pieceCount: number,
 *   location: ReturnType<typeof buildLocationSummary>
 * }>} 可直接用于后续优化的 group 列表。
 */
function buildGroups(type, batches) {
	// 这里的 group 就是一个稳定重排单元：`upcUniqueList[i] + orders[i]`。
	// 后续无论怎么换批次、换顺序，都不会把这个对应关系拆开。
	const groups = [];

	for (let batchIndex = 0; batchIndex < (batches || []).length; batchIndex++) {
		const batch = batches[batchIndex] || {};
		const orderLabelMap = type === "single" ? buildOrderLabelMap(batch.labelDesc) : null;
		const labelPool = type === "multiple" ? createLabelPool(batch.labelDesc) : null;
		const upcUniqueList = Array.isArray(batch.upcUniqueList) ? batch.upcUniqueList : [];
		const ordersList = Array.isArray(batch.orders) ? batch.orders : [];

		for (let groupIndex = 0; groupIndex < upcUniqueList.length; groupIndex++) {
			const upcUnique = upcUniqueList[groupIndex];
			const rawOrders = Array.isArray(ordersList[groupIndex]) ? ordersList[groupIndex] : [];
			if (!rawOrders.length) continue;

			const { orders, orderNoList, pieceCount } = summarizeOrders(type, rawOrders);
			const labelItems = type === "multiple"
				? allocateLabelItemsByDemand(buildUpcDemandMap(orders), labelPool, orderNoList[0] || "")
				: collectLabelItems(orderNoList, orderLabelMap);
			const outputItemKeySet = buildGroupOutputItemKeySet(type, labelItems);

			groups.push({
				id: `${type}-${batchIndex}-${groupIndex}`,
				type,
				originalBatchIndex: batchIndex,
				upcUnique,
				orders,
				orderNoList,
				labelItems,
				slotCost: type === "multiple" ? outputItemKeySet.size : getSingleGroupSlotCost(orders),
				outputItemKeySet,
				pieceCount,
				location: buildLocationSummary(labelItems),
			});

		}
	}

	return groups;
}


/**
 * 按 group 的主导 zone、锚点 shelf 和件数，对 group 做稳定排序。
 *
 * @param {{ location: ReturnType<typeof buildLocationSummary>, upcUnique: string }} a 左侧 group。
 * @param {{ location: ReturnType<typeof buildLocationSummary>, upcUnique: string }} b 右侧 group。
 * @returns {number} 适用于排序的比较结果。
 */
function compareGroupsByAnchor(a, b) {
	if (a.location.dominantZone !== b.location.dominantZone) {
		return compareZones(a.location.dominantZone, b.location.dominantZone);
	}
	if (a.location.anchorPosition.row !== b.location.anchorPosition.row) {
		return a.location.anchorPosition.row - b.location.anchorPosition.row;
	}
	if (a.location.anchorPosition.column !== b.location.anchorPosition.column) {
		return a.location.anchorPosition.column - b.location.anchorPosition.column;
	}
	if (a.location.anchorPosition.side !== b.location.anchorPosition.side) {
		return a.location.anchorPosition.side - b.location.anchorPosition.side;
	}
	if (b.location.totalQty !== a.location.totalQty) {
		return b.location.totalQty - a.location.totalQty;
	}
	return String(a.upcUnique).localeCompare(String(b.upcUnique));
}

/**
 * 按 group 在仓内路径上的起止位置做线性排序，适用于 `single` 的全局顺序规划。
 *
 * `single` 的目标更接近“沿仓库路径单向扫过去”，因此优先比较最早触达的货位，
 * 再比较该 group 的结束位置；同一路径段内再让件数更大的 group 靠前。
 *
 * @param {{ location: ReturnType<typeof buildLocationSummary>, pieceCount: number, upcUnique: string }} a 左侧 group。
 * @param {{ location: ReturnType<typeof buildLocationSummary>, pieceCount: number, upcUnique: string }} b 右侧 group。
 * @returns {number} 适用于 `single` 排序的比较结果。
 */
function compareSingleGroupsByPath(a, b) {
	if (a.location.minTravelIndex !== b.location.minTravelIndex) {
		return a.location.minTravelIndex - b.location.minTravelIndex;
	}
	if (a.location.maxTravelIndex !== b.location.maxTravelIndex) {
		return a.location.maxTravelIndex - b.location.maxTravelIndex;
	}
	if (a.location.anchorPosition.travelIndex !== b.location.anchorPosition.travelIndex) {
		return a.location.anchorPosition.travelIndex - b.location.anchorPosition.travelIndex;
	}
	if (b.pieceCount !== a.pieceCount) {
		return b.pieceCount - a.pieceCount;
	}
	return String(a.upcUnique).localeCompare(String(b.upcUnique));
}

function getGroupSortComparator(type) {
	return type === "single" ? compareSingleGroupsByPath : compareGroupsByAnchor;
}

/**
 * 创建一个空的批次上下文，用于增量装填 group。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @returns {{
 *   type: "single"|"multiple",
 *   groups: Array<Record<string, any>>,
 *   usedSlots: number,
 *   outputItemKeySet: Set<string>,
 *   zoneSet: Set<string>,
 *   shelfSet: Set<string>,
 *   prefixSet: Set<string>,
 *   avgTravelIndex: number,
 *   weightedQty: number
 * }} 新的批次上下文对象。
 */
function createBatchContext(type) {
	return {
		type,
		groups: [],
		usedSlots: 0,
		outputItemKeySet: new Set(),
		zoneSet: new Set(),
		shelfSet: new Set(),
		prefixSet: new Set(),
		avgTravelIndex: 0,
		weightedQty: 0,
	};
}

/**
 * 把一个集合中的全部值合并到另一个集合。
 *
 * @param {Set<string>} target 目标集合。
 * @param {Set<string>} source 来源集合。
 * @returns {void}
 */
function mergeSet(target, source) {
	for (const value of source) {
		target.add(value);
	}
}

/**
 * 计算候选 group 放入当前批次后的实际占用数。
 *
 * `multiple` 必须按最终聚合后的输出 key 去重统计；
 * `single` 则继续沿用已有的单组槽位成本。
 *
 * @param {ReturnType<typeof createBatchContext>} context 当前批次上下文。
 * @param {{ slotCost: number, outputItemKeySet: Set<string> }} candidate 候选 group。
 * @returns {number} 放入候选项后的实际占用数。
 */
function calcCandidateNextUsedSlots(context, candidate) {
	if (context.type !== "multiple") {
		return context.usedSlots + candidate.slotCost;
	}

	let addedCount = 0;
	for (const key of candidate.outputItemKeySet) {
		if (!context.outputItemKeySet.has(key)) {
			addedCount += 1;
		}
	}
	return context.usedSlots + addedCount;
}

/**
 * 将一个 group 放入当前批次上下文，并同步更新统计特征。
 *
 * @param {ReturnType<typeof createBatchContext>} context 当前批次上下文。
 * @param {{ slotCost: number, outputItemKeySet: Set<string>, location: ReturnType<typeof buildLocationSummary> }} group 待加入的 group。
 * @returns {void}
 */
function updateBatchContext(context, group) {
	context.groups.push(group);
	if (context.type === "multiple") {
		mergeSet(context.outputItemKeySet, group.outputItemKeySet);
		context.usedSlots = context.outputItemKeySet.size;
	} else {
		context.usedSlots += group.slotCost;
	}
	mergeSet(context.zoneSet, group.location.zoneSet);
	mergeSet(context.shelfSet, group.location.shelfSet);
	mergeSet(context.prefixSet, group.location.prefixSet);

	const qty = Math.max(group.location.totalQty, 1);
	context.avgTravelIndex =
		(context.avgTravelIndex * context.weightedQty + group.location.avgTravelIndex * qty) /
		(context.weightedQty + qty);
	context.weightedQty += qty;
}

/**
 * 计算两个集合的交集大小。
 *
 * @param {Set<string>} left 左侧集合。
 * @param {Set<string>} right 右侧集合。
 * @returns {number} 两个集合中相同元素的数量。
 */
function calcSetIntersectionSize(left, right) {
	const smaller = left.size <= right.size ? left : right;
	const larger = smaller === left ? right : left;
	let count = 0;
	for (const value of smaller) {
		if (larger.has(value)) {
			count += 1;
		}
	}
	return count;
}

/**
 * 评估一个候选 group 放入当前批次后的适配程度。
 *
 * @param {{ slotCost: number, outputItemKeySet: Set<string>, location: ReturnType<typeof buildLocationSummary> }} candidate 候选 group。
 * @param {ReturnType<typeof createBatchContext>} context 当前批次上下文。
 * @param {number} boxSize 每批最大槽位数。
 * @returns {number} 评分越高越适合；若超出 `boxSize`，返回 `-Infinity`。
 */
function scoreCandidate(candidate, context, boxSize) {
	const nextUsedSlots = calcCandidateNextUsedSlots(context, candidate);
	if (nextUsedSlots > boxSize) {
		return -Infinity;
	}

	const addedSlots = nextUsedSlots - context.usedSlots;
	if (context.groups.length === 0) {
		return (
			candidate.location.totalQty * 10 -
			candidate.location.anchorPosition.travelIndex -
			addedSlots
		);
	}

	const sharedZones = calcSetIntersectionSize(candidate.location.zoneSet, context.zoneSet);
	const sharedShelves = calcSetIntersectionSize(candidate.location.shelfSet, context.shelfSet);
	const sharedPrefixes = calcSetIntersectionSize(candidate.location.prefixSet, context.prefixSet);
	const distance = Math.abs(candidate.location.avgTravelIndex - context.avgTravelIndex);
	const remains = boxSize - nextUsedSlots;

	let score = 0;
	score += sharedShelves * 4000;
	score += sharedPrefixes * 10000;
	score += sharedZones * 900;
	if (context.shelfSet.has(candidate.location.dominantShelf)) {
		score += 3000;
	}
	if (context.zoneSet.has(candidate.location.dominantZone)) {
		score += 1800;
	}

	if (sharedPrefixes === 0) {
		score -= 10000;
	}

	score += Math.max(0, 1200 - distance * 15);
	score += Math.max(0, 600 - candidate.location.anchorPosition.row * 20);
	score += Math.max(0, 150 - remains * 10);
	score += Math.max(0, 300 - addedSlots * 20);
	score += candidate.location.totalQty * 5;
	return score;
}


/**
 * 输出前复制一份 `labelItem`，确保只保留最终 JSON 需要的字段。
 *
 * @param {{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }} item 原始 labelItem。
 * @returns {{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }} 可直接写入 JSON 的明细对象。
 */
function toOutputLabelItem(item) {
	return {
		zoneNo: item.zoneNo,
		zoneName: item.zoneName,
		shelfNo: item.shelfNo,
		shelfName: item.shelfName,
		upc: item.upc,
		sku: item.sku,
		orderNo: item.orderNo,
		num: item.num,
	};
}

/**
 * 在最终输出前按货位与 UPC 合并同类明细，避免同一拣货点重复多行。
 *
 * 仅对 `multiple` 批次启用：`single` 的 `labelDesc.items[].orderNo` 仍可按真实订单反查，
 * 保持原样可以避免改变既有语义。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {Array<{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }>} items 当前 zone 下的明细列表。
 * @returns {Array<{ zoneNo: string, zoneName: string, shelfNo: string, shelfName: string, upc: string, sku: string, orderNo: string, num: number }>}
 * 可直接用于输出和统计的明细列表。
 */
function aggregateOutputLabelItems(type, items) {
	if (type !== "multiple") {
		return [...items];
	}

	const aggregatedMap = new Map();

	for (const rawItem of items) {
		const item = normalizeLabelItem(rawItem, rawItem?.zoneName);
		const key = buildAggregatedOutputItemKey(item);


		if (!aggregatedMap.has(key)) {
			aggregatedMap.set(key, { ...item });
			continue;
		}

		aggregatedMap.get(key).num += item.num;
	}

	return [...aggregatedMap.values()];
}

/**
 * 将一批已选中的 groups 重建为最终输出批次，同时顺手统计切换次数。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {number} batchNo 新批次序号，从 `1` 开始。
 * @param {Array<Record<string, any>>} groups 组成该批次的 group 列表。
 * @returns {{
 *   batch: { upcUniqueList: string[], orders: Array<Array<Record<string, any>>>, orderNoList: string[], pickNo: string, labelDesc: Array<{ zoneName: string, items: Array<Record<string, any>> }> },
 *   metrics: { totalZoneSwitches: number, totalShelfSwitches: number, totalItems: number }
 * }} 最终批次对象及其统计信息。
 */
function buildBatchFromGroups(type, batchNo, groups) {
	const sortedGroups = [...groups].sort(getGroupSortComparator(type));
	const upcUniqueList = [];
	const orders = [];
	const orderNoSet = new Set();
	const zoneMap = new Map();

	for (const group of sortedGroups) {
		upcUniqueList.push(group.upcUnique);
		orders.push(group.orders);
		for (const orderNo of group.orderNoList) {
			if (orderNo) {
				orderNoSet.add(orderNo);
			}
		}
		for (const item of group.labelItems) {
			const zoneName = item.zoneName || "UNKNOWN";
			if (!zoneMap.has(zoneName)) {
				zoneMap.set(zoneName, []);
			}
			zoneMap.get(zoneName).push(item);
		}
	}

	const labelDesc = [];
	let totalZoneSwitches = 0;
	let totalShelfSwitches = 0;
	let totalItems = 0;
	let previousItem = null;

	for (const [zoneName, rawItems] of [...zoneMap.entries()].sort(([zoneA], [zoneB]) => compareZones(zoneA, zoneB))) {
		const items = aggregateOutputLabelItems(type, rawItems).sort(compareLabelItems);
		totalItems += items.length;

		for (const item of items) {
			if (previousItem) {
				if (item.zoneName !== previousItem.zoneName) {
					totalZoneSwitches += 1;
				}
				if (item.shelfName !== previousItem.shelfName) {
					totalShelfSwitches += 1;
				}
			}
			previousItem = item;
		}

		labelDesc.push({
			zoneName,
			items: items.map(toOutputLabelItem),
		});
	}


	return {
		batch: {
			upcUniqueList,
			orders,
			orderNoList: [...orderNoSet],
			pickNo: `OPT-${type.toUpperCase().slice(0, 3)}-${String(batchNo).padStart(3, "0")}`,
			labelDesc,
		},
		metrics: {
			totalZoneSwitches,
			totalShelfSwitches,
			totalItems,
		},
	};
}


/**
 * 对 `single` 批次执行“全局路径排序 + 连续分批”。
 *
 * `single` 的组之间没有 `multiple` 那种组合绑定约束，更适合先按仓内路径排成一条线，
 * 再按容量顺序切批，避免种子选择把同一路径上的组打散。
 *
 * @param {Array<Record<string, any>>} batches 原始 `single` 批次数组。
 * @param {number} boxSize 每个优化后批次允许的最大槽位数。
 * @returns {{
 *   groups: Array<Record<string, any>>,
 *   optimizedBatches: Array<Record<string, any>>,
 *   metrics: { totalZoneSwitches: number, totalShelfSwitches: number, totalItems: number }
 * }} 原始 group 列表、优化后的批次列表及统计信息。
 */
function optimizeSingleBatchesByPath(batches, boxSize) {
	const groups = buildGroups("single", batches).sort(compareSingleGroupsByPath);
	const optimizedBatches = [];
	const metrics = {
		totalZoneSwitches: 0,
		totalShelfSwitches: 0,
		totalItems: 0,
	};
	let currentGroups = [];
	let currentUsedSlots = 0;

	const flushCurrentBatch = () => {
		if (currentGroups.length === 0) {
			return;
		}
		const { batch, metrics: batchMetrics } = buildBatchFromGroups(
			"single",
			optimizedBatches.length + 1,
			currentGroups,
		);
		optimizedBatches.push(batch);
		metrics.totalZoneSwitches += batchMetrics.totalZoneSwitches;
		metrics.totalShelfSwitches += batchMetrics.totalShelfSwitches;
		metrics.totalItems += batchMetrics.totalItems;
		currentGroups = [];
		currentUsedSlots = 0;
	};

	for (const group of groups) {
		const nextUsedSlots = currentUsedSlots + group.slotCost;
		
		const shouldFlush = (currentGroups.length > 0 && nextUsedSlots > boxSize);
		
		if (shouldFlush) {
			flushCurrentBatch();
		}
		
		currentGroups.push(group);
		currentUsedSlots += group.slotCost;
	}

	flushCurrentBatch();

	return {
		groups,
		optimizedBatches,
		metrics,
	};
}

/**
 * 对某一类批次（`single` 或 `multiple`）执行重排优化。
 *
 * `single` 走全局路径排序；`multiple` 保留启发式聚类。
 *
 * @param {"single"|"multiple"} type 当前处理的数据类型。
 * @param {Array<Record<string, any>>} batches 原始批次数组。
 * @param {number} boxSize 每个优化后批次允许的最大槽位数。
 * @returns {{
 *   groups: Array<Record<string, any>>,
 *   optimizedBatches: Array<Record<string, any>>,
 *   metrics: { totalZoneSwitches: number, totalShelfSwitches: number, totalItems: number }
 * }} 原始 group 列表、优化后的批次列表及统计信息。
 */
function optimizeTypeBatches(type, batches, boxSize) {
	if (type === "single") {
		return optimizeSingleBatchesByPath(batches, boxSize);
	}

	// `multiple` 先选一个种子 group，再不断挑选“最像当前批次”的候选项塞进来，
	// 直到达到 boxSize 上限。这里用的是启发式评分，不是全局最优求解。
	const groups = buildGroups(type, batches).sort(compareGroupsByAnchor);
	const remaining = new Set(groups.map((group) => group.id));
	const groupMap = new Map(groups.map((group) => [group.id, group]));
	const optimizedBatches = [];
	const metrics = {
		totalZoneSwitches: 0,
		totalShelfSwitches: 0,
		totalItems: 0,
	};

	while (remaining.size > 0) {
		const context = createBatchContext(type);

		const seed = groups.find((group) => remaining.has(group.id));
		if (!seed) break;

		updateBatchContext(context, seed);
		remaining.delete(seed.id);

		while (true) {
			let bestCandidate = null;
			let bestScore = -Infinity;

			for (const groupId of remaining) {
				const candidate = groupMap.get(groupId);
				const score = scoreCandidate(candidate, context, boxSize);
				if (score > bestScore) {
					bestScore = score;
					bestCandidate = candidate;
				}
			}

			if (!bestCandidate || bestScore === -Infinity) {
				break;
			}

			updateBatchContext(context, bestCandidate);
			remaining.delete(bestCandidate.id);
		}

		const { batch, metrics: batchMetrics } = buildBatchFromGroups(
			type,
			optimizedBatches.length + 1,
			context.groups,
		);
		optimizedBatches.push(batch);
		metrics.totalZoneSwitches += batchMetrics.totalZoneSwitches;
		metrics.totalShelfSwitches += batchMetrics.totalShelfSwitches;
		metrics.totalItems += batchMetrics.totalItems;
	}

	return {
		groups,
		optimizedBatches,
		metrics,
	};
}

/**
 * 对完整订单 JSON 执行优化，并同时产出统计信息。
 *
 * @param {{ single?: Array<Record<string, any>>, multiple?: Array<Record<string, any>> }} data 原始订单 JSON。
 * @param {number} [boxSize=DEFAULT_BOX_SIZE] 每批最大槽位数。
 * @returns {{
 *   optimizedData: { single: Array<Record<string, any>>, multiple: Array<Record<string, any>> },
 *   stats: {
 *     single: { originalBatchCount: number, optimizedBatchCount: number, groupCount: number, totalZoneSwitches: number, totalShelfSwitches: number, totalItems: number },
 *     multiple: { originalBatchCount: number, optimizedBatchCount: number, groupCount: number, totalZoneSwitches: number, totalShelfSwitches: number, totalItems: number }
 *   }
 * }} 优化后的 JSON 和统计摘要。
 */
function optimizePickingData(data, boxSize = DEFAULT_BOX_SIZE) {
	const singleResult = optimizeTypeBatches("single", data.single || [], boxSize);
	const multipleResult = optimizeTypeBatches("multiple", data.multiple || [], boxSize);

	return {
		optimizedData: {
			single: singleResult.optimizedBatches,
			multiple: multipleResult.optimizedBatches,
		},
		stats: {
			single: {
				originalBatchCount: (data.single || []).length,
				optimizedBatchCount: singleResult.optimizedBatches.length,
				groupCount: singleResult.groups.length,
				...singleResult.metrics,
			},
			multiple: {
				originalBatchCount: (data.multiple || []).length,
				optimizedBatchCount: multipleResult.optimizedBatches.length,
				groupCount: multipleResult.groups.length,
				...multipleResult.metrics,
			},
		},
	};
}

/**
 * 将优化统计结果输出到控制台。
 *
 * @param {{ single: Record<string, number>, multiple: Record<string, number> }} stats `optimizePickingData` 返回的 `stats` 对象。
 * @returns {void}
 */
function printStats(stats) {
	for (const type of ["single", "multiple"]) {
		const item = stats[type];
		console.log(`\n[${type}]`);
		console.log(`- 原批次数: ${item.originalBatchCount}`);
		console.log(`- 优化后批次数: ${item.optimizedBatchCount}`);
		console.log(`- UPC组数: ${item.groupCount}`);
		console.log(`- zone切换次数(按优化后拣货顺序统计): ${item.totalZoneSwitches}`);
		console.log(`- shelf切换次数(按优化后拣货顺序统计): ${item.totalShelfSwitches}`);
		console.log(`- 拣货明细行数: ${item.totalItems}`);
	}
}

/**
 * CLI 入口：读取输入 JSON，执行优化，写出结果并打印统计。
 *
 * @returns {void}
 */
function main() {
	const options = parseArgs(process.argv);
	if (!fs.existsSync(options.inputPath)) {
		console.error(`输入文件不存在: ${options.inputPath}`);
		process.exit(1);
	}

	const data = readJson(options.inputPath);
	const { optimizedData, stats } = optimizePickingData(data, options.boxSize);
	writeJson(options.outputPath, optimizedData);

	console.log(`优化完成: ${options.outputPath}`);
	console.log(`每批最大聚合后UPC数: ${options.boxSize}`);

	printStats(stats);
	console.log("\n后续可直接把优化后的 JSON 再交给 process-ordersV4.js 生成 PDF。");
}


if (require.main === module) {
	main();
}

module.exports = {
	optimizePickingData,
	parseShelfPosition,
	compareShelves,
	buildGroups,
	optimizeTypeBatches,
};

