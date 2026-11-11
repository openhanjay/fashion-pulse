/*
 * "지금 랭킹에서 어떤 디자인이 들어오고 빠지는가"를 미리 계산해 data/design_trend.json으로 낸다.
 *
 * 왜 미리 계산하나: 주차별 스냅샷 16개(약 20MB)와 상품 속성 10MB를 읽어야 나오는 분석이라
 * 브라우저에서 열 때마다 돌리면 무겁다. 수집 때 한 번 계산해 작은 JSON으로 떨궈두면
 * 대시보드는 그걸 그리기만 하면 된다.
 *
 * 계절 함정: 8월에서 11월로 가면 총장이 길어지는 게 당연하다(반팔 -> 코트). 그건 디자인
 * 트렌드가 아니라 계절이다. 그래서 전부 "같은 품목 안에서" 전반부 대비 후반부로만 비교한다.
 *
 * 사용법: node build_design_trend.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "design_trend.json");
const DIAG_BRAND = "vivalavida";

// 표본이 얇으면 한두 상품이 들고 나는 것만으로 숫자가 크게 흔들린다. 최소 기준을 둔다.
const MIN_LEN_SAMPLE = 40;   // 품목별 총장 비교
const MIN_FIT_SAMPLE = 30;   // 품목별 핏 비중 비교
const MIN_FIT_DIFF = 5;      // %p - 이보다 작은 변화는 노이즈로 본다
const MIN_LEN_DIFF = 0.8;    // cm
const NEWCOMER_WEEKS = 4;    // "최근 신규"로 볼 기간

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const round1 = (v) => Math.round(v * 10) / 10;

/* 주마다 스냅샷 하나씩만 고른다. 추세를 보는 데 하루 4회치를 다 읽을 이유가 없다. */
function weeklyPicks(index) {
  const out = [];
  let lastWeek = null;
  for (const d of Object.keys(index).sort()) {
    const t = new Date(d);
    t.setDate(t.getDate() - t.getDay());
    const wk = t.toISOString().slice(0, 10);
    if (wk === lastWeek) continue;
    lastWeek = wk;
    out.push({ week: wk, day: d, time: (index[d] || [])[0] });
  }
  return out;
}

/* 스냅샷 하나에서 전 카테고리 상품을 중복 없이 모아 속성을 붙인다 */
function readSnapshot(pick, meta) {
  const file = path.join(DATA_DIR, `musinsa_${pick.day}_${pick.time}.json`);
  if (!pick.time || !fs.existsSync(file)) return null;
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const seen = new Set();
  const rows = [];
  for (const cat of Object.keys(snap)) {
    if (cat === "keywords") continue;
    for (const it of snap[cat]?.all || []) {
      const id = idOf(it.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const m = meta[id];
      if (m) rows.push({ id, meta: m });
    }
  }
  return rows;
}

/* 품목별로 총장과 핏을 모은다 */
function bucket(rowsList) {
  const out = {};
  for (const rows of rowsList) {
    for (const { meta: m } of rows) {
      if (!m.cat2) continue;
      const g = (out[m.cat2] ||= { len: [], fits: {}, fitTotal: 0 });
      const L = m.measure && m.measure["총장"];
      if (L) g.len.push(L);
      if (m.fit) {
        g.fitTotal += 1;
        for (const f of m.fit.split("/")) g.fits[f] = (g.fits[f] || 0) + 1;
      }
    }
  }
  return out;
}

function shareOf(map, total) {
  const out = {};
  if (total) for (const [k, n] of Object.entries(map)) out[k] = (n / total) * 100;
  return out;
}

function run() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));
  const picks = weeklyPicks(index);
  if (picks.length < 4) { console.log("주차가 너무 적어 트렌드를 내지 않습니다."); return; }

  const weeks = [];
  for (const p of picks) {
    const rows = readSnapshot(p, meta);
    if (rows && rows.length) weeks.push({ week: p.week, rows });
  }
  if (weeks.length < 4) { console.log("읽을 수 있는 주차가 너무 적습니다."); return; }

  const half = Math.floor(weeks.length / 2);
  const early = bucket(weeks.slice(0, half).map((w) => w.rows));
  const late = bucket(weeks.slice(half).map((w) => w.rows));

  /* ── 품목별 총장 변화 ── */
  const lengthShifts = [];
  for (const cat of Object.keys(late)) {
    const a = early[cat], b = late[cat];
    if (!a || a.len.length < MIN_LEN_SAMPLE || b.len.length < MIN_LEN_SAMPLE) continue;
    const from = avg(a.len), to = avg(b.len);
    if (Math.abs(to - from) < MIN_LEN_DIFF) continue;
    lengthShifts.push({ cat, from: round1(from), to: round1(to), diff: round1(to - from), nA: a.len.length, nB: b.len.length });
  }
  lengthShifts.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  /* ── 품목별 핏 비중 변화 ── */
  const fitShifts = [];
  for (const cat of Object.keys(late)) {
    const a = early[cat], b = late[cat];
    if (!a || a.fitTotal < MIN_FIT_SAMPLE || b.fitTotal < MIN_FIT_SAMPLE) continue;
    const sa = shareOf(a.fits, a.fitTotal), sb = shareOf(b.fits, b.fitTotal);
    for (const f of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const from = sa[f] || 0, to = sb[f] || 0;
      if (Math.abs(to - from) < MIN_FIT_DIFF) continue;
      fitShifts.push({ cat, fit: f, from: Math.round(from), to: Math.round(to), diff: Math.round(to - from) });
    }
  }
  fitShifts.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  /* ── 신규 진입 상품이 기존과 어떻게 다른가 ──
     계절 효과가 섞이긴 하지만, "지금 새로 올라오는 것들"이 가장 선행하는 신호다. */
  const cut = Math.max(0, weeks.length - NEWCOMER_WEEKS);
  const seenBefore = new Set();
  weeks.slice(0, cut).forEach((w) => w.rows.forEach((r) => seenBefore.add(r.id)));
  const fresh = [], incumbent = [];
  const dedup = new Set();
  weeks.slice(cut).forEach((w) => w.rows.forEach((r) => {
    if (dedup.has(r.id)) return;
    dedup.add(r.id);
    (seenBefore.has(r.id) ? incumbent : fresh).push(r.meta);
  }));

  const attrShift = (pick) => {
    const tally = (arr) => {
      const m = {}; let t = 0;
      for (const x of arr) { const v = pick(x); if (!v) continue; t += 1; for (const k of v) m[k] = (m[k] || 0) + 1; }
      return { m, t };
    };
    const A = tally(incumbent), B = tally(fresh);
    if (!A.t || !B.t) return [];
    return [...new Set([...Object.keys(A.m), ...Object.keys(B.m)])]
      .map((k) => ({ k, from: Math.round((A.m[k] || 0) / A.t * 100), to: Math.round((B.m[k] || 0) / B.t * 100) }))
      .map((r) => ({ ...r, diff: r.to - r.from }))
      .filter((r) => Math.abs(r.diff) >= 3)
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  };
  const newcomer = {
    count: fresh.length,
    incumbentCount: incumbent.length,
    fit: attrShift((m) => (m.fit ? m.fit.split("/") : null)),
    // 두께/계절은 계절이 바뀌면 당연히 움직이는 값이라 참고용으로만 담는다
    thickness: attrShift((m) => (m.thickness ? [m.thickness] : null)),
  };

  /* ── 자사 카탈로그 대조 ── */
  let brand = null;
  const catalogFile = path.join(DATA_DIR, "brand_catalog.json");
  if (fs.existsSync(catalogFile)) {
    const c = JSON.parse(fs.readFileSync(catalogFile, "utf8"))[DIAG_BRAND];
    if (c) {
      const mine = c.items.map((i) => meta[i.id]).filter(Boolean);
      const fitMap = {}; let fitTot = 0;
      const lenByCat = {};
      const catCount = {};
      for (const m of mine) {
        if (m.fit) { fitTot += 1; for (const f of m.fit.split("/")) fitMap[f] = (fitMap[f] || 0) + 1; }
        if (m.cat2) catCount[m.cat2] = (catCount[m.cat2] || 0) + 1;
        const L = m.measure && m.measure["총장"];
        if (L && m.cat2) (lenByCat[m.cat2] ||= []).push(L);
      }
      const myFit = shareOf(fitMap, fitTot);
      // 랭킹 후반부의 핏 비중(전 품목 합산)과 비교
      const rankFit = {}; let rankTot = 0;
      for (const g of Object.values(late)) { rankTot += g.fitTotal; for (const [f, n] of Object.entries(g.fits)) rankFit[f] = (rankFit[f] || 0) + n; }
      const rankFitShare = shareOf(rankFit, rankTot);

      const lenGaps = [];
      for (const [cat, arr] of Object.entries(lenByCat)) {
        const r = late[cat];
        if (arr.length < 5 || !r || r.len.length < MIN_LEN_SAMPLE) continue;
        const mineAvg = avg(arr), rankAvg = avg(r.len);
        lenGaps.push({ cat, mine: round1(mineAvg), rank: round1(rankAvg), diff: round1(mineAvg - rankAvg), n: arr.length });
      }
      lenGaps.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

      brand = {
        name: c.brandName,
        total: c.items.length,
        topCats: Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([cat, n]) => ({ cat, n, pct: Math.round((n / mine.length) * 100) })),
        fit: Object.entries(myFit).map(([k, v]) => ({ k, mine: Math.round(v), rank: Math.round(rankFitShare[k] || 0) }))
          .sort((a, b) => b.mine - a.mine),
        lenGaps: lenGaps.slice(0, 6),
      };
    }
  }

  const out = {
    updatedAt: new Date().toISOString().slice(0, 10),
    period: { from: picks[0].day, to: picks[picks.length - 1].day, weeks: weeks.length },
    lengthShifts: lengthShifts.slice(0, 10),
    fitShifts: fitShifts.slice(0, 12),
    newcomer,
    brand,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  console.log(`design_trend.json 저장 (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB)`);
  console.log(`  기간 ${out.period.from} ~ ${out.period.to} (${out.period.weeks}주)`);
  console.log(`  총장 변화 ${out.lengthShifts.length}건 / 핏 변화 ${out.fitShifts.length}건`);
  console.log(`  신규 ${newcomer.count}개 vs 기존 ${newcomer.incumbentCount}개`);
  if (brand) console.log(`  자사 ${brand.name} ${brand.total}개, 총장 격차 ${brand.lenGaps.length}품목`);
}

if (require.main === module) run();
module.exports = { weeklyPicks, bucket };
