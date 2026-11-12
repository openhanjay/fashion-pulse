/*
 * 무신사 상품의 "소재 고시" 정보를 모은다 - 충전재(다운이냐 아니냐), 겉감 소재, 제조국.
 *
 * 왜 따로 받나: 상품 상세(api2/goods/{id})에는 핏·두께·계절은 있어도 소재가 없다.
 * 소재는 전자상거래 상품정보제공고시 쪽에 따로 들어있고, 그게 아래 API다.
 *   GET /api2/goods/{id}/essential
 *     -> [{name:"제품 소재", value:"겉감: 폴리에스터 100%, 충전재: 덕다운 (솜털 80%, 깃털 20%)"}, ...]
 *
 * 이 값도 상품마다 고정이라 한 번만 받아 캐시한다(product_meta.js와 같은 방식).
 * 다만 전체 카탈로그 12만 개를 다 받을 이유는 없어서 "랭킹에 오른 적 있는 상품"만 받는다.
 * 최근에 랭킹에 있던 상품부터 받아서, 중간에 끊겨도 쓸모 있는 쪽이 먼저 채워지게 한다.
 *
 * 사용법:
 *   node scrape_product_fabric.js                # 최근 4주 랭킹 상품 중 미수집분
 *   node scrape_product_fabric.js --all          # 전체 기간 랭킹 상품
 *   node scrape_product_fabric.js --limit 2000   # 이번 실행 최대 2000개 (CI 시간 제한용)
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "musinsa_index.json");
const OUT_FILE = path.join(DATA_DIR, "product_fabric.json");

const ESSENTIAL_URL = (id) => `https://goods-detail.musinsa.com/api2/goods/${id}/essential`;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const CONCURRENCY = 4;
const REQUEST_DELAY_MS = 150;
const SAVE_EVERY = 300;
const RECENT_DAYS = 28;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 파싱 */

/*
 * 충전재 분류. 브랜드마다 적는 말이 제각각이라("솜털/오리 80%", "덕다운", "DOWN 90%",
 * "폴리에스터 100%") 표기를 몇 갈래로 눌러 담는다.
 * 순서가 중요하다 - "구스다운"에는 "다운"도 들어있으므로 좁은 것부터 본다.
 */
const FILL_RULES = [
  ["구스다운", /구스|거위|goose/i],
  ["덕다운", /덕\s*다운|오리|duck/i],
  ["다운(종류 미상)", /다운|down|솜털|깃털|우모/i],
  ["신슐레이트", /신슐레이트|thinsulate/i],
  ["웰론", /웰론|wellon/i],
  ["폴리 충전재", /폴리|poly|화섬|마이크로\s*화이버|microfiber/i],
  ["울/모", /울\b|양모|wool|알파카|캐시미어/i],
  ["기타", /./],
];

/* 겉감 주소재. "울 70%, 나일론 30%"처럼 섞여 있으면 혼용률이 높은 쪽으로 대표시킨다.
   한 글자 소재명(면·울·마)은 앞뒤에 한글이 붙지 않을 때만 센다 - 그래야 "면"이
   "면세"나 "폴리에스터면"에 걸리지 않는다. */
const KO = (w) => new RegExp("(^|[^가-힣])" + w + "([^가-힣]|$)");
const FABRIC_RULES = [
  ["캐시미어", /캐시미어|cashmere/i],
  ["울/모", /양모|wool|알파카|모헤어|람스울/i, KO("울")],
  ["코튼", /코튼|cotton/i, KO("면")],
  ["린넨", /린넨|linen/i, KO("마")],
  ["나일론", /나일론|nylon/i],
  ["폴리에스터", /폴리에스터|폴리에스테르|polyester|폴리\b/i],
  ["아크릴", /아크릴|acrylic/i],
  ["레이온/비스코스", /레이온|비스코스|rayon|viscose|모달|modal|텐셀|tencel|리오셀/i],
  ["가죽", /가죽|소가죽|양가죽|leather|스웨이드/i],
  ["데님", /데님|denim/i],
  ["아세테이트", /아세테이트|acetate/i],
  ["스판덱스", /스판|폴리우레탄|spandex|elastane/i],
];

const classify = (text, rules) => {
  if (!text) return null;
  for (const [label, ...res] of rules) for (const re of res) if (re.test(text)) return label;
  return null;
};

/* "울 70%, 나일론 30%"에서 비중이 가장 큰 소재를 고른다.
   퍼센트가 안 적힌 상품도 많아서, 그럴 땐 규칙 순서(좁은 것부터)로 떨어진다. */
function dominantFabric(text) {
  const sum = new Map();
  const re = /([가-힣A-Za-z][가-힣A-Za-z\s()]{0,14}?)\s*(\d{1,3}(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(text))) {
    const label = classify(m[1], FABRIC_RULES);
    if (label) sum.set(label, (sum.get(label) || 0) + Number(m[2]));
  }
  if (sum.size) return [...sum.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return classify(text, FABRIC_RULES);
}

/*
 * "겉감: 폴리에스터 100%, 안감: 나일론 100%, 충전재: 덕다운 (솜털 80%, 깃털 20%)"를
 * {겉감:"...", 안감:"...", 충전재:"..."}로 쪼갠다.
 *
 * 구분자가 통일돼 있지 않다(쉼표, 슬래시, 줄바꿈 전부 쓰인다). 그래서 구분자로 자르는 대신
 * 라벨이 나오는 위치를 찾아 라벨과 라벨 사이를 그 라벨의 값으로 본다.
 */
const PART_LABELS = ["겉감", "겉감지", "표면", "안감", "충전재", "충전제", "배색", "소재", "원단", "혼용률"];
const PART_RE = new RegExp("(" + PART_LABELS.join("|") + ")\\s*(?:\\([^)]*\\))?\\s*[:：]?\\s*", "g");

function splitParts(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const hits = [];
  let m;
  PART_RE.lastIndex = 0;
  while ((m = PART_RE.exec(text))) hits.push({ label: m[1], from: m.index, to: m.index + m[0].length });
  // 라벨이 하나도 없으면 전체를 소재 한 덩어리로 본다("폴리에스터 100%"처럼 쓰는 브랜드가 있다).
  if (!hits.length) return { 소재: text };
  const out = {};
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].from : text.length;
    const v = text.slice(h.to, end).trim().replace(/[,/;·]\s*$/, "");
    // 같은 라벨이 여러 번 나오면(배색1, 배색2) 첫 번째만 쓴다.
    if (v && !out[h.label]) out[h.label] = v;
  });
  return out;
}

function buildRecord(essentials) {
  const get = (name) => (essentials.find((e) => e.name === name) || {}).value || null;
  const raw = get("제품 소재");
  const parts = splitParts(raw);
  if (!parts) return { none: true };

  const fillText = parts["충전재"] || parts["충전제"] || null;
  const shellText = parts["겉감"] || parts["겉감지"] || parts["표면"] || parts["소재"] || parts["원단"] || parts["혼용률"] || null;

  return {
    // 충전재가 아예 안 적힌 상품(티셔츠 등)은 null. 패딩인데 null이면 고시를 생략한 것.
    fill: fillText ? classify(fillText, FILL_RULES) : null,
    fillText: fillText ? fillText.slice(0, 80) : null,
    shell: shellText ? dominantFabric(shellText) : null,
    shellText: shellText ? shellText.slice(0, 80) : null,
    origin: (get("제조국") || "").split(/[,/(]/)[0].trim().slice(0, 20) || null,
  };
}

/* ---------------------------------------------------------------- 수집 대상 */

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];

/* 최근 날짜부터 거슬러 올라가며 모은다 - 중간에 끊겨도 최근 상품이 먼저 채워진다. */
function collectCandidates(index, scanAll) {
  const dates = Object.keys(index).sort().reverse();
  const targets = scanAll ? dates : dates.slice(0, RECENT_DAYS);
  const ids = [];
  const seen = new Set();
  for (const d of targets) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const key of ["all", "rising", "new"]) {
        for (const it of (snap[cat] && snap[cat][key]) || []) {
          const id = idOf(it.url);
          if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
        }
      }
    }
  }
  return ids;
}

/* 상품 하나당 한 줄로 쓴다. 매일 커밋되는 파일이라 줄 단위여야 git 델타가 먹는다. */
function write(obj) {
  const ids = Object.keys(obj).sort();
  const lines = ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(obj[id])}`);
  fs.writeFileSync(OUT_FILE, `{\n${lines.join(",\n")}\n}\n`);
}

async function fetchOne(id) {
  const res = await fetch(ESSENTIAL_URL(id), { headers: HEADERS });
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const essentials = (json.data || {}).essentials;
  if (!Array.isArray(essentials) || !essentials.length) return { none: true };
  return buildRecord(essentials);
}

async function run() {
  const args = process.argv.slice(2);
  const scanAll = args.includes("--all");
  const li = args.indexOf("--limit");
  const limit = li !== -1 ? Number(args[li + 1]) : Infinity;

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  const store = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : {};

  const candidates = collectCandidates(index, scanAll);
  const todo = candidates.filter((id) => !store[id]).slice(0, limit);
  console.log(`후보 ${candidates.length}개 / 이미 수집 ${candidates.length - candidates.filter((id) => !store[id]).length}개`);
  console.log(`이번에 받을 상품: ${todo.length}개 (동시 ${CONCURRENCY})`);
  if (!todo.length) { console.log("받을 게 없어요."); return; }

  let done = 0, ok = 0, gone = 0, failed = 0, since = 0;
  const started = Date.now();
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const id = todo[i];
      try {
        const r = await fetchOne(id);
        if (r.gone) { store[id] = { gone: true }; gone += 1; }
        else { store[id] = r; ok += 1; }
      } catch {
        failed += 1; // 캐시에 안 넣으므로 다음 실행에 다시 시도된다
      }
      done += 1; since += 1;
      if (since >= SAVE_EVERY) { write(store); since = 0; }
      if (done % 500 === 0 || done === todo.length) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`  ${done}/${todo.length} (성공 ${ok}, 없음 ${gone}, 실패 ${failed}) - ${rate.toFixed(1)}건/초, 남은 시간 약 ${Math.round((todo.length - done) / rate / 60)}분`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  write(store);

  const vals = Object.values(store).filter((v) => v && !v.gone);
  const withFill = vals.filter((v) => v.fill).length;
  const withShell = vals.filter((v) => v.shell).length;
  console.log(`\n완료. 누적 ${Object.keys(store).length}개 (충전재 ${withFill}, 겉감 ${withShell})`);
  console.log(`파일 크기: ${(fs.statSync(OUT_FILE).size / 1048576).toFixed(1)}MB`);
}

if (require.main === module) run().catch((e) => { console.error("실패:", e); process.exit(1); });
module.exports = { splitParts, buildRecord, classify, dominantFabric, FILL_RULES, FABRIC_RULES, OUT_FILE };
