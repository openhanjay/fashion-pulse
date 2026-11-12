/*
 * "계속 상위권에 박혀 있는 상품"을 찾는다.
 *
 * 랭킹을 하루치만 보면 1위가 누구인지는 알아도 그게 어제 올라온 건지 두 달째 버티는 건지
 * 알 수 없다. 기획에 쓸모 있는 건 후자다 - 반짝 올라온 상품이 아니라 계속 팔리는 상품이
 * 어떻게 생겼는지가 참고할 대상이다.
 *
 * 수집일마다 각 랭킹의 상위 N위를 훑어서 상품별로 며칠이나 머물렀는지 센다.
 * 순위는 랭킹 종류마다 다르므로(전체 12위 / 아우터 3위), 그날 가장 좋았던 순위를 쓴다.
 *
 * 산출물: data/steady_items.json
 * 사용법: node build_steady_items.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "steady_items.json");

const TOP_N = 30;        // "상위권"의 기준
const WINDOW_DAYS = 56;  // 최근 8주만 본다 - 지난 시즌까지 섞으면 지금 뭐가 버티는지가 흐려진다
const MIN_DAYS = 5;      // 이보다 짧게 머문 건 "계속"이라 할 수 없다
const TOP_OVERALL = 30;
const TOP_PER_CAT = 8;

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const r1 = (v) => Math.round(v * 10) / 10;

function run() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));

  const days = Object.keys(index).sort().slice(-WINDOW_DAYS);
  const items = new Map();

  for (const d of days) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));

    // 그날 하루 안에서 상품별 최고 순위를 먼저 정한다(랭킹이 7개라 중복 등장한다).
    const today = new Map();
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        if (!(it.rank > 0 && it.rank <= TOP_N)) continue;
        const id = idOf(it.url);
        if (!id) continue;
        const was = today.get(id);
        if (!was || it.rank < was.rank) today.set(id, { rank: it.rank, board: cat, it });
      }
    }

    for (const [id, { rank, board, it }] of today) {
      let rec = items.get(id);
      if (!rec) {
        rec = { id, days: [], ranks: [], boards: new Set(), last: null };
        items.set(id, rec);
      }
      rec.days.push(d);
      rec.ranks.push(rank);
      rec.boards.add(board);
      rec.last = { name: it.name, brand: it.brand, price: it.price, image: it.image, url: it.url, rank, board };
    }
  }

  /* 지금도 버티고 있는지 보려면 마지막 며칠을 연속으로 채웠는지가 중요하다.
     수집이 하루 빠진 날이 있어서 날짜 차이가 아니라 "수집일 목록에서의 연속"으로 센다. */
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const lastIdx = days.length - 1;

  const rows = [];
  for (const rec of items.values()) {
    if (rec.days.length < MIN_DAYS) continue;
    const idxs = rec.days.map((d) => dayIndex.get(d)).sort((a, b) => a - b);

    let streak = 0;
    for (let i = idxs.length - 1, expect = lastIdx; i >= 0; i -= 1, expect -= 1) {
      if (idxs[i] !== expect) break;
      streak += 1;
    }

    const m = meta[rec.id];
    rows.push({
      id: rec.id,
      name: rec.last.name, brand: rec.last.brand, price: rec.last.price,
      image: rec.last.image, url: rec.last.url,
      cat2: (m && m.cat2) || null,
      days: rec.days.length,
      from: rec.days[0], to: rec.days[rec.days.length - 1],
      streak,
      best: Math.min(...rec.ranks),
      avg: r1(rec.ranks.reduce((a, b) => a + b, 0) / rec.ranks.length),
      board: rec.last.board,
      // 지금도 상위권인가. 마지막 수집일에 있었으면 "유지 중".
      live: idxs[idxs.length - 1] === lastIdx,
    });
  }

  // 오래 머문 순, 같으면 평균 순위가 좋은 순
  const byStay = (a, b) => b.days - a.days || a.avg - b.avg;
  rows.sort(byStay);

  const byCat2 = {};
  for (const r of rows) {
    if (!r.cat2) continue;
    (byCat2[r.cat2] = byCat2[r.cat2] || []).push(r);
  }
  for (const k of Object.keys(byCat2)) byCat2[k] = byCat2[k].slice(0, TOP_PER_CAT);

  const out = {
    updatedAt: new Date().toISOString().slice(0, 10),
    topN: TOP_N,
    period: { from: days[0], to: days[days.length - 1], days: days.length },
    overall: rows.slice(0, TOP_OVERALL),
    byCat2,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  console.log(`steady_items.json 저장 (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB)`);
  console.log(`  기간 ${out.period.from} ~ ${out.period.to} (${days.length}일) / 상위 ${TOP_N}위 기준`);
  console.log(`  ${MIN_DAYS}일 이상 머문 상품 ${rows.length}개 / 품목 ${Object.keys(byCat2).length}개`);
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${String(r.days).padStart(3)}일 (연속 ${String(r.streak).padStart(2)}) 최고 ${String(r.best).padStart(2)}위  ${(r.brand || "").padEnd(14)} ${String(r.name).slice(0, 34)}`);
  }
}

if (require.main === module) run();
module.exports = { run };
