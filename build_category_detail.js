/*
 * 품목(cat2) 하나를 파고드는 데 필요한 숫자를, 기간마다 따로 계산해 쌓는다.
 *
 * 왜 필요한가: 아카이브는 "경량 패딩이 3.9%"까지만 보여준다. 정작 기획에 필요한 건
 * 그 다음이다 - 그중 다운이 몇 개고 아닌 게 몇 개인지, 평균 얼마에 팔리는지,
 * 제일 싼 건 어느 브랜드가 얼마에 내놓는지.
 *
 * 왜 기간마다 나누나: 처음에는 "최근 4주"를 통째로 묶었는데, 그러면 랭킹에 하루 떴다
 * 사라진 상품의 3주 전 반짝 세일가가 "이 품목 최저가"로 박힌다(84% 세일가 15,920원이
 * 최저가로 올라갔는데 그 상품은 지금 48,100원이다). 기간을 끊어서 계산하면 그 세일가는
 * 그 주의 기록으로 남고, 이번 주를 보면 이번 주 가격이 나온다. 다른 화면들과 기간
 * 기준도 같아진다.
 *
 * 가격 표기 주의: 랭킹 스냅샷의 price는 쿠폰까지 적용된 finalPrice다. 그런데 상품
 * 페이지의 큰 글씨는 판매가고 쿠폰가는 그 아래 작게 적힌다. 그래서 최저가/최고가로
 * 내보낼 상품만은 가장 최근 기간에 한해 현재 가격을 다시 받아, 판매가와 쿠폰가를
 * 같이 싣고 페이지와 같은 기준(판매가)으로 줄 세운다.
 *
 * 산출물
 *   data/category/weekly/2026-W45.json
 *   data/category/monthly/2026-11.json
 *   data/category/index.json
 *
 * 사용법: node build_category_detail.js [--rebuild] [--no-live]
 */

const fs = require("fs");
const path = require("path");
const { isoWeekKey, weekLabel } = require("./build_category_timeline");

const DATA_DIR = path.join(__dirname, "data");
const OUT_DIR = path.join(DATA_DIR, "category");
const WEEK_DIR = path.join(OUT_DIR, "weekly");
const MONTH_DIR = path.join(OUT_DIR, "monthly");

const MIN_ITEMS = 8;        // 이보다 적은 품목은 평균이 의미 없다
const TOP_BRANDS = 12;
const TOP_WORDS = 14;
const WORD_MIN = 3;
const MEASURE_MIN = 5;
const PRICE_CHECK_TOP = 10; // 최저/최고가 후보 중 현재가를 다시 받아볼 개수
const PRICE_CONCURRENCY = 4;

const DETAIL_URL = (id) => "https://goods-detail.musinsa.com/api2/goods/" + id;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, base) => Math.round((n / Math.max(1, base)) * 1000) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 품목 이름을 그대로 옮긴 단어는 키워드로서 정보가 없다. */
const STOPWORDS = new Set([
  "세트", "패키지", "기획", "단독", "한정", "컬러", "color", "colors", "pack", "set", "new",
  "티셔츠", "티", "반팔", "긴팔", "셔츠", "맨투맨", "후드", "후드티", "스웨트", "탑", "블라우스",
  "자켓", "재킷", "코트", "점퍼", "패딩", "가디건", "베스트", "집업", "니트", "스웨터",
  "팬츠", "슬랙스", "데님", "청바지", "반바지", "원피스", "드레스", "스커트", "치마",
  "shirt", "tee", "hoodie", "jacket", "coat", "pants", "denim", "jeans", "dress", "skirt", "knit",
]);

const dist = (map, base, limit) => ({
  base,
  rows: [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([k, n]) => ({ k, n, pct: pct(n, base) })),
});
const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };

/* 기간에 속한 날들의 스냅샷에서 상품을 모은다. 같은 상품이 여러 날 걸리면
   그 기간 안에서 가장 나중에 본 값을 쓴다(가격이 바뀌므로). */
function collectPeriod(days, index) {
  const byId = new Map();
  for (const d of days) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        const id = idOf(it.url);
        if (!id) continue;
        const was = byId.get(id);
        byId.set(id, {
          id, name: it.name, brand: it.brand, price: it.price,
          discountRatio: it.discountRatio, url: it.url, image: it.image,
          seenAt: d,
          days: (was ? was.days : 0) + 1,
        });
      }
    }
  }
  return [...byId.values()];
}

function summarize(items, meta, fabric) {
  const fillM = new Map(), shellM = new Map();
  const fitM = new Map(), thickM = new Map(), sexM = new Map(), seasonM = new Map();
  const wordM = new Map(), spellM = new Map(), brandM = new Map(), brandPrice = new Map();
  const measureAcc = {};
  let fabricKnown = 0, fillKnown = 0, shellKnown = 0;

  const prices = [];
  // 다운이냐 아니냐로 가격이 갈리는지 보려고 두 갈래로 따로 모은다.
  const downPrices = [], synthPrices = [];

  for (const it of items) {
    const m = meta[it.id], f = fabric[it.id];
    const hasPrice = typeof it.price === "number" && it.price > 0;
    if (hasPrice) prices.push(it.price);

    if (it.brand) {
      bump(brandM, it.brand);
      if (hasPrice) {
        const arr = brandPrice.get(it.brand) || [];
        arr.push(it.price);
        brandPrice.set(it.brand, arr);
      }
    }

    if (f && !f.gone) {
      fabricKnown += 1;
      if (f.shell) { shellKnown += 1; bump(shellM, f.shell); }
      if (f.fill) {
        fillKnown += 1;
        bump(fillM, f.fill);
        if (hasPrice) (/다운/.test(f.fill) ? downPrices : synthPrices).push(it.price);
      }
    }

    if (m) {
      for (const [key, map] of [["fit", fitM], ["thickness", thickM], ["sex", sexM], ["season", seasonM]]) {
        const v = m[key];
        if (v) for (const one of String(v).split("/")) bump(map, one);
      }
      if (m.measure) {
        for (const [k, v] of Object.entries(m.measure)) {
          if (typeof v === "number" && v > 0) (measureAcc[k] = measureAcc[k] || []).push(v);
        }
      }
    }

    const seen = new Set();
    for (const raw of String(it.name || "").split(/[\s/_\-[\]().,]+/)) {
      const w = raw.trim();
      if (w.length < 2 || /^\d+$/.test(w)) continue;
      const lw = w.toLowerCase();
      if (STOPWORDS.has(w) || STOPWORDS.has(lw) || seen.has(lw)) continue;
      seen.add(lw);
      bump(wordM, lw);
      // 화면에는 가장 흔한 표기를 쓴다("BLACK"과 "Black"을 따로 세지 않도록).
      const sp = spellM.get(lw) || new Map();
      sp.set(w, (sp.get(w) || 0) + 1);
      spellM.set(lw, sp);
    }
  }

  const priced = items.filter((it) => typeof it.price === "number" && it.price > 0);
  const row = (it) => ({
    id: it.id, name: it.name, brand: it.brand, price: it.price, url: it.url,
    seenAt: it.seenAt, fill: (fabric[it.id] || {}).fill || null,
  });
  // 현재가를 다시 받아볼 후보를 넉넉히 담아둔다. 받아본 뒤 다시 정렬해 잘라낸다(fillLivePrices).
  const cheapest = [...priced].sort((a, b) => a.price - b.price).slice(0, PRICE_CHECK_TOP).map(row);
  const priciest = [...priced].sort((a, b) => b.price - a.price).slice(0, PRICE_CHECK_TOP).map(row);

  const measure = {};
  for (const [k, arr] of Object.entries(measureAcc)) if (arr.length >= MEASURE_MIN) measure[k] = { avg: r1(avg(arr)), n: arr.length };

  const sumOf = (m) => [...m.values()].reduce((a, b) => a + b, 0);

  return {
    items: items.length,
    fabricCoverage: pct(fabricKnown, items.length),
    price: {
      avg: prices.length ? Math.round(avg(prices)) : null,
      median: median(prices),
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      cheapest, priciest,
      // "다운이라 비싼가"를 바로 볼 수 있게 두 갈래 평균을 같이 낸다.
      downAvg: downPrices.length >= 3 ? Math.round(avg(downPrices)) : null,
      downN: downPrices.length,
      synthAvg: synthPrices.length >= 3 ? Math.round(avg(synthPrices)) : null,
      synthN: synthPrices.length,
    },
    discount: { avg: r1(avg(items.map((i) => i.discountRatio).filter((v) => typeof v === "number"))) },
    fill: dist(fillM, fillKnown, 8),
    fillKnown,
    shell: dist(shellM, shellKnown, 10),
    shellKnown,
    fit: dist(fitM, sumOf(fitM), 6),
    thickness: dist(thickM, sumOf(thickM), 6),
    sex: dist(sexM, sumOf(sexM), 4),
    season: dist(seasonM, sumOf(seasonM), 4),
    brands: {
      base: items.length,
      rows: [...brandM.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_BRANDS)
        .map(([k, n]) => ({ k, n, pct: pct(n, items.length), avgPrice: Math.round(avg(brandPrice.get(k) || [])) || null })),
    },
    words: {
      base: items.length,
      rows: [...wordM.entries()].filter(([, n]) => n >= WORD_MIN).sort((a, b) => b[1] - a[1]).slice(0, TOP_WORDS)
        .map(([lw, n]) => ({
          k: [...spellM.get(lw).entries()].sort((a, b) => b[1] - a[1])[0][0],
          n, pct: pct(n, items.length),
        })),
    },
    measure,
  };
}

/* ------------------------------------------------- 현재가 재확인 */

async function livePrice(id) {
  const res = await fetch(DETAIL_URL(id), { headers: HEADERS });
  if (!res.ok) return null;
  const g = ((await res.json()).data || {}).goodsPrice;
  if (!g || !(g.salePrice > 0)) return null;
  return {
    salePrice: g.salePrice,
    // 쿠폰가가 판매가와 같으면 쿠폰이 없는 것이다. 같은 값을 두 번 보여줄 이유가 없다.
    couponPrice: g.couponPrice > 0 && g.couponPrice < g.salePrice ? g.couponPrice : null,
    normalPrice: g.normalPrice > 0 ? g.normalPrice : null,
    discountRate: g.discountRate || 0,
  };
}

/*
 * 가장 최근 기간에만 쓴다. 지나간 주의 "그때 가격"은 다시 받을 수도 없고 받을 이유도 없다.
 * 품목당 후보 10+10개라 70품목이면 요청 1,400개쯤 된다. 못 받은 상품은 스냅샷 값을
 * 그대로 두되 현재가가 아니라는 표시(live:false)를 남긴다.
 */
const liveCache = new Map(); // 실행 한 번 동안만 - 최근 주와 최근 달이 상품을 크게 공유한다

async function fillLivePrices(categories, today) {
  const ids = new Set();
  for (const d of Object.values(categories)) {
    for (const r of [...d.price.cheapest, ...d.price.priciest]) ids.add(r.id);
  }
  const list = [...ids].filter((id) => !liveCache.has(id));
  const live = liveCache;
  let cursor = 0, done = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        const v = await livePrice(list[i]);
        // 받지 못한 것도 null로 적어둔다 - 다음 기간에서 또 물어보지 않도록.
        live.set(list[i], v || null);
      } catch { live.set(list[i], null); }
      done += 1;
      if (done % 400 === 0) console.log(`  현재가 확인 ${done}/${list.length}`);
      await sleep(120);
    }
  };
  if (list.length) await Promise.all(Array.from({ length: PRICE_CONCURRENCY }, worker));
  else console.log("  현재가는 앞 기간에서 받아둔 것으로 충분");

  const apply = (rows, keep, desc) => {
    const out = rows.map((r) => {
      const v = live.get(r.id);
      if (!v) return { ...r, live: false, shown: r.price };
      return { ...r, live: true, checkedAt: today, ...v, shown: v.salePrice };
    });
    // 상품 페이지와 같은 기준(판매가)으로 다시 줄 세운다. 현재가를 못 받은 건 뒤로 민다.
    out.sort((a, b) => (a.live === b.live ? (desc ? b.shown - a.shown : a.shown - b.shown) : a.live ? -1 : 1));
    return out.slice(0, keep);
  };

  for (const d of Object.values(categories)) {
    d.price.cheapest = apply(d.price.cheapest, 5, false);
    d.price.priciest = apply(d.price.priciest, 3, true);
  }
  console.log(`  현재가 ${list.length}건 조회 (캐시 포함 ${live.size}건 보유)`);
}

/* 현재가를 못 받는 기간(지나간 주)은 후보를 그냥 잘라 쓴다. */
function trimWithoutLive(categories) {
  for (const d of Object.values(categories)) {
    const mark = (r) => ({ ...r, live: false, shown: r.price });
    d.price.cheapest = d.price.cheapest.slice(0, 5).map(mark);
    d.price.priciest = d.price.priciest.slice(0, 3).map(mark);
  }
}

/* ------------------------------------------------- 실행 */

function buildPeriod(days, index, meta, fabric) {
  const items = collectPeriod(days, index);
  const byCat = new Map();
  for (const it of items) {
    const m = meta[it.id];
    if (!m || !m.cat2) continue;
    if (!byCat.has(m.cat2)) byCat.set(m.cat2, []);
    byCat.get(m.cat2).push(it);
  }
  const categories = {};
  const cat1 = {};
  for (const [cat, list] of byCat) {
    if (list.length < MIN_ITEMS) continue;
    categories[cat] = summarize(list, meta, fabric);
    const sample = list.map((it) => meta[it.id]).find((m) => m && m.cat1);
    cat1[cat] = (sample && sample.cat1) || "";
  }
  return { categories, cat1, totalItems: items.length };
}

async function run() {
  const rebuild = process.argv.includes("--rebuild");
  const noLive = process.argv.includes("--no-live");
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));
  const fabricFile = path.join(DATA_DIR, "product_fabric.json");
  const fabric = fs.existsSync(fabricFile) ? JSON.parse(fs.readFileSync(fabricFile, "utf8")) : {};
  fs.mkdirSync(WEEK_DIR, { recursive: true });
  fs.mkdirSync(MONTH_DIR, { recursive: true });

  const allDays = Object.keys(index).sort();
  const byWeek = new Map(), byMonth = new Map();
  for (const d of allDays) {
    const wk = isoWeekKey(d), mo = d.slice(0, 7);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    if (!byMonth.has(mo)) byMonth.set(mo, []);
    byWeek.get(wk).push(d);
    byMonth.get(mo).push(d);
  }

  const today = new Date().toISOString().slice(0, 10);
  const groups = [
    { kind: "week", dir: WEEK_DIR, map: byWeek },
    { kind: "month", dir: MONTH_DIR, map: byMonth },
  ];
  const idx = { updatedAt: today, weeks: [], months: [] };

  for (const g of groups) {
    const keys = [...g.map.keys()].sort();
    const latest = keys[keys.length - 1];
    for (const key of keys) {
      const file = path.join(g.dir, key + ".json");
      const days = g.map.get(key);
      const L = g.kind === "week" ? weekLabel(key) : null;
      const label = {
        period: key, kind: g.kind,
        from: days[0], to: days[days.length - 1], days: days.length,
        year: L ? L.year : Number(key.slice(0, 4)),
        month: L ? L.month : Number(key.slice(5, 7)),
        nth: L ? L.nth : null,
        text: L ? L.text : Number(key.slice(5, 7)) + "월",
        range: L ? L.range : days[0].slice(5) + " ~ " + days[days.length - 1].slice(5),
      };

      // 지나간 기간은 다시 바뀌지 않는다. 가장 최근 기간만 매번 새로 만든다.
      if (!rebuild && key !== latest && fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file, "utf8"));
        idx[g.kind === "week" ? "weeks" : "months"].push({ ...label, categories: old.order.length });
        continue;
      }

      const built = buildPeriod(days, index, meta, fabric);
      const order = Object.keys(built.categories).sort((a, b) => built.categories[b].items - built.categories[a].items);
      if (!order.length) continue;

      if (key === latest && !noLive) {
        console.log(`${key} 현재가 확인 중...`);
        await fillLivePrices(built.categories, today);
      } else {
        trimWithoutLive(built.categories);
      }

      fs.writeFileSync(file, JSON.stringify({
        ...label, live: key === latest && !noLive, totalItems: built.totalItems,
        order, cat1: built.cat1, categories: built.categories,
      }));
      idx[g.kind === "week" ? "weeks" : "months"].push({ ...label, categories: order.length });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(idx));

  const size = (d) => fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0);
  console.log(`주간 ${idx.weeks.length}개 / 월간 ${idx.months.length}개`);
  console.log(`  weekly ${(size(WEEK_DIR) / 1024).toFixed(0)}KB, monthly ${(size(MONTH_DIR) / 1024).toFixed(0)}KB`);
  const last = idx.weeks[idx.weeks.length - 1];
  if (last) {
    const d = JSON.parse(fs.readFileSync(path.join(WEEK_DIR, last.period + ".json"), "utf8"));
    console.log(`  가장 최근: ${last.text} (${last.range}) · 상품 ${d.totalItems}개 · 품목 ${d.order.length}개`);
    for (const c of d.order.slice(0, 3)) {
      const x = d.categories[c];
      const cheap = x.price.cheapest[0];
      console.log(`    ${c.padEnd(18)} ${String(x.items).padStart(4)}개  최저 ${cheap ? cheap.shown.toLocaleString() + "원 " + cheap.brand : "-"}`);
    }
  }
}

if (require.main === module) run().catch((e) => { console.error("실패:", e); process.exit(1); });
module.exports = { summarize, collectPeriod, buildPeriod };
