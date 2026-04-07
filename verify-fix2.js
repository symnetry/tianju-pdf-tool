const fs = require('fs');

const inputFile = 'tianju_orders_1775489470442.optimized.json';

if (!fs.existsSync(inputFile)) {
  console.error('文件不存在:', inputFile);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

console.log('=== 验证优化后的数据 ===\n');

for (const type of ['single', 'multiple']) {
  const batches = data[type] || [];
  console.log(`【${type}】类型批次:`);
  console.log(`  批次总数: ${batches.length}\n`);

  batches.forEach((batch, batchIndex) => {
    const upcCount = batch.upcUniqueList.length;

    // 分析货区前缀
    const prefixSet = new Set();
    const prefixCounts = {};
    const zoneSet = new Set();
    const shelfSet = new Set();

    for (const zone of batch.labelDesc || []) {
      for (const item of zone.items || []) {
        const shelfName = item.shelfName;
        const prefixMatch = shelfName.match(/^([A-Za-z]+)/);
        if (prefixMatch) {
          const prefix = prefixMatch[1];
          prefixSet.add(prefix);
          prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
        }
        zoneSet.add(item.zoneName);
        shelfSet.add(item.shelfName);
      }
    }

    const prefixArray = [...prefixSet].sort();
    const mainPrefix = prefixArray.length > 0 ? prefixArray[0] : 'N/A';
    const hasMultiplePrefixes = prefixSet.size > 1;

    console.log(`  批次 ${batchIndex + 1}:`);
    console.log(`    - UPC 数量: ${upcCount}`);
    console.log(`    - 货区前缀: ${prefixArray.join(', ')}`);
    console.log(`    - 主要前缀: ${mainPrefix}`);
    console.log(`    - zone 数量: ${zoneSet.size}`);
    console.log(`    - shelf 数量: ${shelfSet.size}`);

    if (hasMultiplePrefixes) {
      console.log(`    ⚠️  包含多种货区前缀: ${JSON.stringify(prefixCounts)}`);
    }
    console.log();
  });
}

console.log('=== 验证完成 ===');
