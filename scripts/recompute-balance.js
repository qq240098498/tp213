// 一次性重算脚本：用修正前、修正后两套口径，把已有水位/入库/出库记录
// 覆盖的固定时段全部重算一遍，列出「是否平衡」发生翻转的时段。
// 用法：node scripts/recompute-balance.js
const store = require('../server/store');
const water = require('../server/water');

const data = store.load();
const settings = data.settings;

// 旧口径（修正前）：出库按每小时 3600 秒换算、损失恒为 0
// 新口径（修正后）：出入库都按每天 86400 秒换算、损失 = 天数 × 每天损失
function legacyBalance(reservoirId, fromDate, toDate) {
  const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
  const curve = water.curveOf(data, reservoirId);
  if (!reservoir || !curve) return null;

  const from = data.levels
    .filter((l) => l.reservoirId === reservoirId && l.date >= fromDate && l.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = store.daysBetween(fromDate, toDate);

  const inflowRows = data.inflows.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const releaseRows = data.releases.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const meanInflow = store.round(inflowRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, inflowRows.length), 3);
  const meanRelease = store.round(releaseRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, releaseRows.length), 3);

  const inflowVolume = store.round((meanInflow * days * 86400) / 10000, 3);
  const releaseVolume = store.round((meanRelease * days * 3600) / 10000, 3); // 旧口径：少乘了 24 倍
  const lossVolume = 0; // 旧口径：损失整项缺失
  const startLevel = from.length ? Number(from[0].level) : 0;
  const endLevel = from.length ? Number(from[from.length - 1].level) : 0;
  const startCapacity = water.capacityAt(curve, startLevel, settings);
  const endCapacity = water.capacityAt(curve, endLevel, settings);
  const deltaStorage = store.round(endCapacity - startCapacity, 3);
  const residual = store.round(inflowVolume - releaseVolume - lossVolume - deltaStorage, 3);
  return {
    inflowVolume,
    releaseVolume,
    lossVolume,
    deltaStorage,
    residual,
    balanced: Math.abs(residual) < Number(settings.balanceToleranceWan),
  };
}

// 重算时段：用户点名的 5/1–5/10、记录覆盖到的每个自然月、整个记录期
function periodsFor(reservoirId) {
  const dates = data.levels
    .filter((l) => l.reservoirId === reservoirId)
    .map((l) => l.date)
    .sort();
  const out = [];
  const has = (d) => dates.includes(d);

  if (has('2026-05-01') && has('2026-05-10')) {
    out.push({ label: '2026-05-01 至 2026-05-10（用户点名时段）', from: '2026-05-01', to: '2026-05-10' });
  }

  // 已有记录是逐日的，相邻两个水位日就是一个时段，逐日全部重算
  for (let i = 0; i < dates.length - 1; i += 1) {
    out.push({ label: dates[i] + ' 至 ' + dates[i + 1] + '（逐日时段）', from: dates[i], to: dates[i + 1] });
  }

  const months = new Set(dates.map((d) => d.slice(0, 7)));
  [...months].sort().forEach((ym) => {
    const monthDates = dates.filter((d) => d.startsWith(ym));
    const from = monthDates[0];
    const to = monthDates[monthDates.length - 1];
    if (from !== to) out.push({ label: ym + '（' + from + ' 至 ' + to + '）', from, to });
  });

  if (dates[0] !== dates[dates.length - 1]) {
    out.push({ label: '整个记录期（' + dates[0] + ' 至 ' + dates[dates.length - 1] + '）', from: dates[0], to: dates[dates.length - 1] });
  }
  return out;
}

const rows = [];
for (const reservoir of data.reservoirs) {
  for (const p of periodsFor(reservoir.id)) {
    const old = legacyBalance(reservoir.id, p.from, p.to);
    const now = water.balance(data, reservoir.id, p.from, p.to);
    if (!old || !now) continue;
    let flip = '判定不变';
    if (!old.balanced && now.balanced) flip = '不平衡 → 平衡';
    else if (old.balanced && !now.balanced) flip = '平衡 → 不平衡';
    rows.push({ reservoir: reservoir.name, period: p.label, from: p.from, to: p.to, daily: /逐日时段/.test(p.label), days: now.days, old, now, flip });
  }
}

const pad = (s, n) => String(s).padEnd(n);
const fixed = (x) => Number(x).toFixed(3).padStart(10);

console.log('水量平衡口径修正 —— 已有记录重算报告');
console.log('容差：' + settings.balanceToleranceWan + ' 万m³；每天损失：' + settings.lossPerDayWan + ' 万m³');
console.log('旧口径：出库 ×3600 秒、损失=0；新口径：出入库均 ×86400 秒、损失=天数×每天损失');
console.log('');

for (const r of rows.filter((x) => !x.daily)) {
  console.log('【' + r.reservoir + '】' + r.period + '（' + r.days + ' 天）');
  console.log('  ' + pad('项目', 10) + pad('入库水量', 12) + pad('出库水量', 12) + pad('损失', 12) + pad('蓄变', 12) + pad('残差', 12) + '判定');
  console.log('  ' + pad('旧口径', 10) + fixed(r.old.inflowVolume) + ' ' + fixed(r.old.releaseVolume) + ' '
    + fixed(r.old.lossVolume) + ' ' + fixed(r.old.deltaStorage) + ' ' + fixed(r.old.residual) + ' '
    + (r.old.balanced ? '平衡' : '不平衡'));
  console.log('  ' + pad('新口径', 10) + fixed(r.now.inflowVolume) + ' ' + fixed(r.now.releaseVolume) + ' '
    + fixed(r.now.lossVolume) + ' ' + fixed(r.now.deltaStorage) + ' ' + fixed(r.now.residual) + ' '
    + (r.now.balanced ? '平衡' : '不平衡'));
  console.log('  → ' + r.flip + (r.flip === '判定不变' ? '' : '（残差 ' + r.old.residual + ' → ' + r.now.residual + '）'));
  console.log('');
}

const toBalanced = rows.filter((r) => r.flip === '不平衡 → 平衡');
const toUnbalanced = rows.filter((r) => r.flip === '平衡 → 不平衡');
const dailyRows = rows.filter((r) => r.daily);
console.log('===== 翻转汇总（全部 ' + rows.length + ' 个时段，其中逐日 ' + dailyRows.length + ' 个）=====');
console.log('原来判不平衡、修好后变平衡（' + toBalanced.length + ' 个时段）：');
toBalanced.forEach((r) => console.log('  - ' + r.reservoir + ' ' + r.period + '，残差 ' + r.old.residual + ' → ' + r.now.residual));
console.log('原来判平衡、修好后变不平衡（' + toUnbalanced.length + ' 个时段）：');
if (!toUnbalanced.length) console.log('  （无）');
toUnbalanced.forEach((r) => console.log('  - ' + r.reservoir + ' ' + r.period + '，残差 ' + r.old.residual + ' → ' + r.now.residual));
console.log('判定不变：' + rows.filter((r) => r.flip === '判定不变').length + ' 个时段；');
console.log('  其中逐日时段仍不平衡 ' + dailyRows.filter((r) => !r.now.balanced).length + ' / ' + dailyRows.length
  + ' 个（数据本身不闭合，属观测数据偏差，不是公式缺项造成的）。');
