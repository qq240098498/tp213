// 水量平衡重算核对：用修复后的式子把已有水位/入库/出库记录全部重算一遍，
// 与修复前的旧口径（出库 ×3600、损失恒 0）对照，列出判定翻转的时段。
// 平衡结果不落库，GET /api/balance 永远按当前式子现算，所以旧记录无需迁移。
// 用法：npm run recheck
const store = require('../server/store');
const water = require('../server/water');

// 修复前的旧口径，原样保留用于对照：出库按每天 3600 秒换算、损失恒为 0
function balanceLegacy(data, reservoirId, fromDate, toDate) {
  const settings = data.settings;
  const curve = water.curveOf(data, reservoirId);
  const from = data.levels
    .filter((l) => l.reservoirId === reservoirId && l.date >= fromDate && l.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = store.daysBetween(fromDate, toDate);
  const inflowRows = data.inflows.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const releaseRows = data.releases.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const meanInflow = store.round(inflowRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, inflowRows.length), 3);
  const meanRelease = store.round(releaseRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, releaseRows.length), 3);
  const inflowVolume = store.round((meanInflow * days * 86400) / 10000, 3);
  const releaseVolume = store.round((meanRelease * days * 3600) / 10000, 3);
  const lossVolume = 0;
  const startCapacity = from.length ? water.capacityAt(curve, Number(from[0].level), settings) : 0;
  const endCapacity = from.length ? water.capacityAt(curve, Number(from[from.length - 1].level), settings) : 0;
  const deltaStorage = store.round(endCapacity - startCapacity, 3);
  const residual = store.round(inflowVolume - releaseVolume - lossVolume - deltaStorage, 3);
  return { days, inflowVolume, releaseVolume, lossVolume, deltaStorage, residual, balanced: Math.abs(residual) < Number(settings.balanceToleranceWan) };
}

function addDays(iso, n) {
  const p = String(iso).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// 以有水位记录的日期为锚点枚举时段（蓄变的首末水位都是实测值）；
// 只评 [from, to) 内每天都有入库与出库记录的时段，覆盖不全的单独计数，不混进判定
function windowsOf(data, reservoirId) {
  const levelDates = [...new Set(data.levels.filter((l) => l.reservoirId === reservoirId).map((l) => l.date))].sort();
  const inflowDates = new Set(data.inflows.filter((r) => r.reservoirId === reservoirId).map((r) => r.date));
  const releaseDates = new Set(data.releases.filter((r) => r.reservoirId === reservoirId).map((r) => r.date));
  const covered = [];
  let skipped = 0;
  for (let i = 0; i < levelDates.length; i += 1) {
    for (let j = i + 1; j < levelDates.length; j += 1) {
      const days = store.daysBetween(levelDates[i], levelDates[j]);
      let ok = true;
      for (let d = 0; d < days; d += 1) {
        const iso = addDays(levelDates[i], d);
        if (!inflowDates.has(iso) || !releaseDates.has(iso)) { ok = false; break; }
      }
      if (ok) covered.push({ from: levelDates[i], to: levelDates[j] });
      else skipped += 1;
    }
  }
  return { covered, skipped, total: (levelDates.length * (levelDates.length - 1)) / 2 };
}

function verdict(b) {
  return b ? '平衡' : '不平衡';
}

const data = store.load();
let totalToBalanced = 0;
let totalToUnbalanced = 0;

for (const reservoir of data.reservoirs) {
  const { covered, skipped, total } = windowsOf(data, reservoir.id);
  const flips = [];
  let stayBalanced = 0;
  let stayUnbalanced = 0;
  for (const w of covered) {
    const before = balanceLegacy(data, reservoir.id, w.from, w.to);
    const after = water.balance(data, reservoir.id, w.from, w.to);
    if (before.balanced !== after.balanced) {
      flips.push({ from: w.from, to: w.to, days: after.days, before, after });
    } else if (after.balanced) stayBalanced += 1;
    else stayUnbalanced += 1;
  }
  const toBalanced = flips.filter((f) => f.after.balanced);
  const toUnbalanced = flips.filter((f) => !f.after.balanced);
  totalToBalanced += toBalanced.length;
  totalToUnbalanced += toUnbalanced.length;

  console.log('=== ' + reservoir.name + '（' + reservoir.id + '）===');
  console.log('水位锚定时段共 ' + total + ' 个；流量记录覆盖完整、参与判定 ' + covered.length + ' 个；覆盖不全、跳过 ' + skipped + ' 个');
  console.log('判定不变：平衡 ' + stayBalanced + ' 个，不平衡 ' + stayUnbalanced + ' 个');
  console.log('判定翻转：不平衡→平衡 ' + toBalanced.length + ' 个，平衡→不平衡 ' + toUnbalanced.length + ' 个');
  for (const f of flips) {
    console.log(
      '  ' + f.from + ' ~ ' + f.to + '（' + f.days + ' 天）'
      + '  旧：残差 ' + f.before.residual + ' 万m³ ' + verdict(f.before.balanced)
      + '  新：残差 ' + f.after.residual + ' 万m³ ' + verdict(f.after.balanced)
    );
  }
  console.log('');
}

console.log('合计：不平衡→平衡 ' + totalToBalanced + ' 个时段，平衡→不平衡 ' + totalToUnbalanced + ' 个时段');
