const fs = require('fs');
const { buildGroups } = require('./optimize-pick-batches');

const inputFile = 'tianju_orders_1775489470442.json';

if (!fs.existsSync(inputFile)) {
  console.error('文件不存在:', inputFile);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

console.log('=== 分析单个 group（UPC 组）的 zone 情况 ===\n');

for (const type of ['single', 'multiple']) {
  const batches = data[type] || [];
  console.log(`【${type}】类型:`);
  
  const groups = buildGroups(type, batches);
  
  let totalGroups = 0;
  let multiZoneGroups = 0;
  
  groups.forEach((group, groupIndex) => {
    totalGroups++;
    
    const zoneSet = new Set();
    const zoneCounts = {};
    
    for (const item of group.labelItems || []) {
      zoneSet.add(item.zoneName);
      zoneCounts[item.zoneName] = (zoneCounts[item.zoneName] || 0) + 1;
    }
    
    if (zoneSet.size > 1) {
      multiZoneGroups++;
      console.log(`  Group ${groupIndex + 1} (UPC: ${group.upcUnique}):`);
      console.log(`    - 包含 ${zoneSet.size} 个 zone: ${[...zoneSet].join(', ')}`);
      console.log(`    - zone 明细: ${JSON.stringify(zoneCounts)}`);
      
      // 显示前几个货位
      console.log(`    - 前 3 个货位:`);
      for (let i = 0; i < Math.min(3, group.labelItems.length); i++) {
        const item = group.labelItems[i];
        console.log(`      ${item.shelfName} (zone: ${item.zoneName})`);
      }
      console.log();
    }
  });
  
  console.log(`  总计: ${totalGroups} 个 group，其中 ${multiZoneGroups} 个包含多个 zone (${((multiZoneGroups / totalGroups) * 100).toFixed(1)}%)\n`);
}

console.log('=== 分析完成 ===');
