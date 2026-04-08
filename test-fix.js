const fs = require('fs');
const path = require('path');

// 导入我们修复后的 optimize-pick-batches.js
const { optimizePickingData } = require('./optimize-pick-batches.js');

const originalPath = path.join(__dirname, 'electron', 'tianju_orders_self01_1775575860989.json');
const outputPath = path.join(__dirname, 'electron', 'self.fixed.json');

console.log('=== 用修复后的脚本重新处理数据 ===\n');

const originalData = JSON.parse(fs.readFileSync(originalPath, 'utf8'));

console.log('开始优化...');
const { optimizedData, stats } = optimizePickingData(originalData, 15);

console.log('\n优化完成！写入文件...');
fs.writeFileSync(outputPath, JSON.stringify(optimizedData, null, 2), 'utf8');

console.log(`\n已保存到: ${outputPath}`);
console.log('\n统计信息:');
console.log(stats);

console.log('\n=== 现在让我们对比一下 ===');

// 简单对比一下
function getAllUpcsFromLabelDesc(labelDesc) {
  const upcs = [];
  if (!Array.isArray(labelDesc)) return upcs;
  
  for (const zone of labelDesc) {
    if (!Array.isArray(zone.items)) continue;
    for (const item of zone.items) {
      const upc = item.upc || item.sku || '';
      if (upc) {
        upcs.push(upc);
      }
    }
  }
  return upcs;
}

const fixedData = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
const oldData = JSON.parse(fs.readFileSync(path.join(__dirname, 'electron', 'self.json'), 'utf8'));

const oldMultipleUpcs = [];
const fixedMultipleUpcs = [];

for (let i = 0; i < (oldData.multiple || []).length; i++) {
  const upcs = getAllUpcsFromLabelDesc(oldData.multiple[i].labelDesc);
  oldMultipleUpcs.push(...upcs);
}

for (let i = 0; i < (fixedData.multiple || []).length; i++) {
  const upcs = getAllUpcsFromLabelDesc(fixedData.multiple[i].labelDesc);
  fixedMultipleUpcs.push(...upcs);
}

console.log(`\n旧数据 MULTIPLE UPC 数量: ${oldMultipleUpcs.length}`);
console.log(`新数据 MULTIPLE UPC 数量: ${fixedMultipleUpcs.length}`);

// 查找是否还缺失那几个 UPC
const testUpcs = ['Ody-Marshmallow', 'Luonan-hei', 'Luonan-MALE', 'Balala-king', 'JEAN LOWE  blue', 'Jean Lowe yellow'];

console.log('\n检查关键 UPC 是否存在:');
for (const upc of testUpcs) {
  const existsInOld = oldMultipleUpcs.some(u => u.toLowerCase() === upc.toLowerCase());
  const existsInNew = fixedMultipleUpcs.some(u => u.toLowerCase() === upc.toLowerCase());
  console.log(`  ${upc}: 旧=${existsInOld ? '✅' : '❌'}, 新=${existsInNew ? '✅' : '❌'}`);
}

console.log('\n=== 测试完成 ===');
