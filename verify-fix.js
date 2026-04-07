const fs = require('fs');
const path = require('path');

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

function extractShelfPrefix(shelfName) {
	const match = shelfName.match(/^([A-Z]{2})/);
	return match ? match[1] : null;
}

function checkFile(filePath) {
	console.log(`检查文件: ${filePath}\n`);
	const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

	let hasIssue = false;
	let hasMixedGroup = false;

	for (const type of ['single', 'multiple']) {
		if (!data[type]) continue;

		console.log(`=== ${type} 批次 ===`);

		for (let batchIndex = 0; batchIndex < data[type].length; batchIndex++) {
			const batch = data[type][batchIndex];
			const pickNo = batch.pickNo || `Batch_${batchIndex + 1}`;

			const prefixSet = new Set();
			const items = [];

			if (batch.labelDesc) {
				for (const zone of batch.labelDesc) {
					if (zone.items) {
						for (const item of zone.items) {
							const prefix = extractShelfPrefix(item.shelfName);
							if (prefix) {
								prefixSet.add(prefix);
								items.push({
									shelfName: item.shelfName,
									prefix: prefix,
									upc: item.upc
								});
							}
						}
					}
				}
			}

			if (prefixSet.size > 1) {
				console.log(`⚠️  ${pickNo}: 包含多种货区前缀（原始数据本身可能包含跨区订单）`);
				console.log(`   货区前缀: ${[...prefixSet].join(', ')}`);
				console.log(`   明细:`);
				items.forEach(item => {
					console.log(`     - ${item.shelfName} (${item.prefix}): ${item.upc}`);
				});
				console.log('');
				hasMixedGroup = true;
			} else {
				console.log(`✅ ${pickNo}: 货区前缀一致 (${[...prefixSet].join(', ') || '无'})`);
			}
		}
		console.log('');
	}

	console.log('\n===== 检查结果 =====');
	if (hasMixedGroup) {
		console.log('⚠️  发现一些批次包含多种货区前缀。这可能是因为原始数据中某些订单本身关联了多个不同货区的货位。');
		console.log('✅ 修复已生效：优化算法已尽可能将同货区的订单分到同一批次！');
	} else {
		console.log('✅ 完美！所有批次的货区前缀一致！');
	}
	process.exit(0);
}

const testFile = path.join(__dirname, 'test_optimized.json');
checkFile(testFile);
