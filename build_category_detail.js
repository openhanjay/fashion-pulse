/*
 * 품목(cat2) 하나를 파고드는 데 필요한 숫자를 미리 계산해 data/category_detail.json으로 낸다.
 *
 * 왜 필요한가: 아카이브는 "경량 패딩이 3.9%"까지만 보여준다. 정작 기획에 필요한 건
 * 그 다음이다 - 그 중 다운이 몇 개고 아닌 게 몇 개인지, 평균 얼마에 팔리는지,
 * 제일 싼 건 어느 브랜드가 얼마에 내놓는지.
 *
 * 왜 미리 계산하나: 스냅샷(1.2MB x 28일)과 상품 속성(38MB), 소재(수MB)를 전부 읽어야
 * 나오는 값이라 브라우저에서 돌릴 수 없다. 수집 때 한 번 계산해 작은 JSON으로 떨군다.
 *
 * 기간은 최근 4주다. 가격은 바뀌는 값이라 오래된 스냅샷까지 섞으면 "지금 얼마에 파는지"가
 * 흐려진다. 상품이 여러 날 랭킹에 있으면 가장 최근 가격을 쓴다.
 *
 * 사용법: node build_category_detail.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "category_detail.json");

const RECENT_DAYS = 28;
const MIN_ITEMS = 8;        // 이보다 적은 품목은 평균이 의미 없다
const TOP_BRANDS = 12;
const TOP_WORDS = 14;
const WORD_MIN = 3;
const MEASURE_MIN = 5;

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, base) => Math.round((n / Math.max(1, base)) * 1000) / 10;

/* 품목 이름을 그대로 옮긴 단어는 키워드로서 정보가 없다. */
const STOPWORDS = new Set([
  "세트", "패키지", "기획", "단독", "한정", "컬러", "color", "colors", "pack", "set", "new",
  "티셔츠", "티", "반팔", "긴팔", "셔츠", "맨투맨", "후드", "후드티", "스웨트", "탑", "블라우스",
  "자켓", "재킷", "코트", "점퍼", "패딩", "가디건", "베스트", "집업", "니트", "스웨터", "재kit",
  "팬츠", "슬랙스", "데님", "청바지", "반바지", "원피스", "드레스", "스커트", "치마", "점퍼",
  "shirt", "tee", "hoodie", "jacket", "coat", "pants", "denim", "jeans", "dress", "skirt", "knit",
]);

const ORIGIN_ALIASES = [
  ["중국", /^(중국|china|cn|중화인민공화국)/i],
  ["베트남", /^(베트남|viet)/i],
  ["대한민국", /^(대한민국|한국|korea|kr|국내)/i],
  ["미얀마", /^(미얀마|myanmar|burma)/i],
  ["인도네시아", /^(인도네시아|indonesia)/i],
  ["방글라데시", /^(방글라|bangla)/i],
  ["인도", /^(인도|india)/i],
  ["캄보디아", /^(캄보디아|cambodia)/i],
  ["이탈리아", /^(이태리|이탈리아|italy)/i],
  ["일본", /^(일본|japan)/i],
  ["튀르키예", /^(터키|튀르키예|turkey|t(ü|u)rkiye)/i],
  ["포르투갈", /^(포르투갈|portugal)/i],
];
function normOrigin(v) {
  const t = String(v || "").replace(/<[^>]*>?/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  // "상세페이지 참조", "제품 라벨 참조" 같은 건 국가가 아니다.
  if (/참조|참고|별도|표기|확인|상이|해당없음/.test(t)) return null;
  for (const [label, re] of ORIGIN_ALIASES) if (re.test(t)) return label;
  return t;
}

const dist = (map, base, limit) => ({
  base,
  rows: [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([k, n]) => ({ k, n, pct: pct(n, base) })),
});

const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };

/* 최근 4주 스냅샷에서 상품을 모은다. 같은 상품은 가장 최근 등장분만 남긴다(가격이 바뀌므로). */
function collectRecent(index) {
  const days = Object.keys(index).sort().slice(-RECENT_DAYS);
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
        // 나중 날짜가 이긴다. 랭킹에 오른 날 수도 같이 센다.
        byId.set(id, {
          id, name: it.name, brand: it.brand, price: it.price,
          discountRatio: it.discountRatio, url: it.url, image: it.image,
          days: (was ? was.days : 0) + 1,
          bestRank: was && typeof was.bestRank === "number" ? Math.min(was.bestRank, it.rank || 999) : (it.rank || 999),
        });
      }
    }
  }
  return { items: [...byId.values()], from: days[0], to: days[days.length - 1] };
}

function summarize(items, meta, fabric) {
  const fillM = new Map(), shellM = new Map(), originM = new Map();
  const fitM = new Map(), thickM = new Map(), sexM = new Map(), seasonM = new Map();
  const wordM = new Map(), spellM = new Map(), brandM = new Map(), brandPrice = new Map();
  const measureAcc = {};
  let fabricKnown = 0, fillKnown = 0, shellKnown = 0;

  const prices = [];
  // 다운이냐 아니냐로 가격이 갈리는지 보려고 두 갈래로 따로 모은다.
  const downPrices = [], synthPrices = [];

  for (const it of items) {
    const m = meta[it.id], f = fabric[it.id];
    if (typeof it.price === "number" && it.price > 0) prices.push(it.price);

    if (it.brand) {
      bump(brandM, it.brand);
      if (typeof it.price === "number" && it.price > 0) {
        const arr = brandPrice.get(it.brand) || [];
        arr.push(it.price);
        brandPrice.set(it.brand, arr);
      }
    }

    if (f && !f.gone) {
      fabricKnown += 1;
      if (f.shell) { shellKnown += 1; bump(shellM, f.shell); }
      bump(originM, normOrigin(f.origin));
      if (f.fill) {
        fillKnown += 1;
        bump(fillM, f.fill);
        const isDown = /다운/.test(f.fill);
        if (typeof it.price === "number" && it.price > 0) (isDown ? downPrices : synthPrices).push(it.price);
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
  const cheapest = [...priced].sort((a, b) => a.price - b.price).slice(0, 5)
    .map((it) => ({ name: it.name, brand: it.brand, price: it.price, url: it.url, fill: (fabric[it.id] || {}).fill || null }));
  const priciest = [...priced].sort((a, b) => b.price - a.price).slice(0, 3)
    .map((it) => ({ name: it.name, brand: it.brand, price: it.price, url: it.url, fill: (fabric[it.id] || {}).fill || null }));

  const measure = {};
  for (const [k, arr] of Object.entries(measureAcc)) if (arr.length >= MEASURE_MIN) measure[k] = { avg: r1(avg(arr)), n: arr.length };

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
    origin: dist(originM, fabricKnown, 8),
    fit: dist(fitM, [...fitM.values()].reduce((a, b) => a + b, 0), 6),
    thickness: dist(thickM, [...thickM.values()].reduce((a, b) => a + b, 0), 6),
    sex: dist(sexM, [...sexM.values()].reduce((a, b) => a + b, 0), 4),
    season: dist(seasonM, [...seasonM.values()].reduce((a, b) => a + b, 0), 4),
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

function run() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));
  const fabricFile = path.join(DATA_DIR, "product_fabric.json");
  const fabric = fs.existsSync(fabricFile) ? JSON.parse(fs.readFileSync(fabricFile, "utf8")) : {};

  const { items, from, to } = collectRecent(index);

  const byCat = new Map();
  for (const it of items) {
    const m = meta[it.id];
    const cat = m && m.cat2;
    if (!cat) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(it);
  }

  const categories = {};
  for (const [cat, list] of byCat) {
    if (list.length < MIN_ITEMS) continue;
    categories[cat] = summarize(list, meta, fabric);
  }

  const order = Object.keys(categories).sort((a, b) => categories[b].items - categories[a].items);
  const out = {
    updatedAt: new Date().toISOString().slice(0, 10),
    period: { from, to, days: RECENT_DAYS },
    cat1: Object.fromEntries(order.map((c) => {
      const sample = byCat.get(c).map((it) => meta[it.id]).find((m) => m && m.cat1);
      return [c, (sample && sample.cat1) || ""];
    })),
    order,
    categories,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  const known = Object.keys(fabric).length;
  console.log(`category_detail.json 저장 (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB)`);
  console.log(`  기간 ${from} ~ ${to} / 상품 ${items.length}개 / 품목 ${order.length}개`);
  console.log(`  소재 캐시 ${known}개 보유`);
  for (const c of order.slice(0, 5)) {
    const d = categories[c];
    console.log(`  ${c.padEnd(20)} ${String(d.items).padStart(4)}개  평균 ${d.price.avg ? d.price.avg.toLocaleString() : "-"}원  소재확인 ${d.fabricCoverage}%`);
  }
}

if (require.main === module) run();
module.exports = { summarize, collectRecent };
