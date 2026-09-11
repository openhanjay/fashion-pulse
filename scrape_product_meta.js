/*
 * 무신사 상품별 "고정 속성"을 모아두는 수집기.
 *
 * 랭킹 스냅샷(data/musinsa_*.json)에는 브랜드/이름/가격/순위뿐이라 "남성 티셔츠 총장이 짧아졌나",
 * "오버핏 비중이 늘었나" 같은 건 볼 수가 없다. 그런 건 상품 상세에 있고, 중요한 건 이 값들이
 * 상품마다 '고정'이라는 점이다 - 총장 61cm짜리 티셔츠는 내일도 61cm다. 그래서 상품당 딱 한 번만
 * 받아서 data/product_meta.json에 캐시해두고, 매일은 새로 등장한 상품만 추가로 받는다.
 * (전수 32,000여 개를 매번 받으면 몇 시간짜리가 되지만, 하루 신규는 보통 1,000개 미만이다.)
 *
 * 쓰는 API 두 개 (둘 다 공개, 인증 없음):
 *   GET /api2/goods/{id}              -> 카테고리, 성별, 시즌, 핏/두께/비침/신축성, 이미지 장수, 리뷰
 *   GET /api2/goods/{id}/actual-size  -> 사이즈별 실측 (총장/어깨너비/가슴단면/소매길이)
 *
 * 사용법:
 *   node scrape_product_meta.js              # 최근 스냅샷에 있는 상품 중 미수집분만
 *   node scrape_product_meta.js --all        # 전체 스냅샷을 훑어 미수집분 전부 (최초 백필)
 *   node scrape_product_meta.js --limit 500  # 이번 실행에서 최대 500개만 (CI 시간 제한용)
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "musinsa_index.json");
const META_FILE = path.join(DATA_DIR, "product_meta.json");
const META_SLIM_FILE = path.join(DATA_DIR, "product_meta_slim.json");

const DETAIL_URL = (id) => `https://goods-detail.musinsa.com/api2/goods/${id}`;
const SIZE_URL = (id) => `https://goods-detail.musinsa.com/api2/goods/${id}/actual-size`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const CONCURRENCY = 4;      // 무신사 서버에 부담 주지 않는 선
const REQUEST_DELAY_MS = 150; // 워커 하나가 상품 하나 끝낸 뒤 쉬는 시간
const SAVE_EVERY = 200;     // 중간 저장 간격 (중단돼도 여기까지는 남는다)
const DEFAULT_LIMIT = Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 수집 대상 */

/* 스냅샷 파일 하나에서 무신사 상품 id를 모은다 */
function productIdsInSnapshot(snap) {
  const ids = new Set();
  for (const cat of Object.keys(snap)) {
    if (cat === "keywords") continue;
    for (const filterKey of ["all", "rising", "new"]) {
      for (const it of snap[cat]?.[filterKey] || []) {
        const m = (it.url || "").match(/products\/(\d+)/);
        if (m) ids.add(m[1]);
      }
    }
  }
  return ids;
}

/* --all이면 전체 수집일, 아니면 가장 최근 수집일만 훑는다. 같은 날 여러 시각 스냅샷은
   상품 풀이 거의 같아서 하루당 하나만 읽어도 충분하다(파일이 1.2MB씩이라 전부 읽으면 느리다). */
function collectCandidateIds(index, scanAll) {
  const dates = Object.keys(index).sort();
  const targets = scanAll ? dates : dates.slice(-1);
  const ids = new Set();
  for (const d of targets) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    productIdsInSnapshot(snap).forEach((id) => ids.add(id));
  }
  return [...ids];
}

/* ---------------------------------------------------------------- 파싱 */

/* goodsMaterial은 [{name:"핏", items:[{name:"레귤러", isSelected:true}, ...]}, ...] 모양이다.
   선택된 값만 뽑아서 {핏:"레귤러", 두께:"보통", ...}으로 납작하게 만든다.
   계절처럼 여러 개가 선택되는 항목은 "/"로 이어붙인다. */
function pickMaterials(goodsMaterial) {
  const out = {};
  for (const group of goodsMaterial?.materials || []) {
    const selected = (group.items || []).filter((i) => i.isSelected).map((i) => i.name.replace(/\|/g, ""));
    if (selected.length) out[group.name] = selected.join("/");
  }
  return out;
}

/* 실측은 사이즈(S/M/L ...)마다 따로 오는데, 상품끼리 비교하려면 기준 사이즈를 하나로 맞춰야 한다.
   M/100 같은 표준 중간 사이즈가 있으면 그걸 쓰고, 없으면 사이즈 목록의 가운데를 쓴다.
   어떤 사이즈를 썼는지도 같이 남겨서 나중에 검증할 수 있게 한다. */
const PREFERRED_SIZES = ["M", "100", "95", "2", "FREE", "F"];
function pickReferenceSize(sizes) {
  if (!sizes || !sizes.length) return null;
  for (const want of PREFERRED_SIZES) {
    const hit = sizes.find((s) => (s.name || "").trim().toUpperCase() === want);
    if (hit) return hit;
  }
  return sizes[Math.floor(sizes.length / 2)];
}

/* 실측 항목 중 추이 분석에 쓸 것만. value가 0이면 "해당 없음"이라 버린다(밑단단면 등이 0으로 온다). */
const SIZE_KEYS = ["총장", "어깨너비", "가슴단면", "소매길이", "허리단면", "밑단단면"];
function pickMeasurements(sizeEntry) {
  if (!sizeEntry) return null;
  const out = {};
  for (const item of sizeEntry.items || []) {
    if (SIZE_KEYS.includes(item.name) && typeof item.value === "number" && item.value > 0) {
      out[item.name] = item.value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildRecord(detail, size) {
  const mat = pickMaterials(detail.goodsMaterial);
  const refSize = pickReferenceSize(size?.sizes);
  const cat = detail.category || {};
  return {
    // detail.brand는 "dimitriblack" 같은 슬러그라 랭킹 스냅샷의 브랜드명과 매칭이 안 된다.
    // 스냅샷 쪽이 한글명("디미트리블랙")이라 brandInfo.brandName을 우선 쓴다.
    brand: detail.brandInfo?.brandName || detail.brand || "",
    cat1: cat.categoryDepth1Name || "",
    cat2: cat.categoryDepth2Name || "",
    // detail.sex가 ["남성","여성"] 한글, detail.genders는 ["M","W"] 코드. 한글 쪽을 쓴다.
    sex: Array.isArray(detail.sex) && detail.sex.length
      ? detail.sex.join("/")
      : (Array.isArray(detail.genders) ? detail.genders.join("/") : ""),
    fit: mat["핏"] || null,
    thickness: mat["두께"] || null,
    sheer: mat["비침"] || null,
    stretch: mat["신축성"] || null,
    touch: mat["촉감"] || null,
    season: mat["계절"] || null,
    images: (detail.goodsImages || []).length,
    // 썸네일은 비전 분류(classify_thumbnails.js)에서 그대로 Claude에 넘긴다. API는 호스트 없는
    // 상대경로("/images/goods_img/...")로 주므로 CDN 호스트를 붙여 완전한 URL로 저장한다.
    thumb: detail.thumbnailImageUrl
      ? (detail.thumbnailImageUrl.startsWith("http") ? detail.thumbnailImageUrl : `https://image.msscdn.net${detail.thumbnailImageUrl}`)
      : null,
    reviews: detail.goodsReview?.totalCount ?? null,
    reviewScore: detail.goodsReview?.satisfactionScore ?? null,
    sizeName: refSize?.name || null,
    sizeType: size?.typeName || null,
    measure: pickMeasurements(refSize),
  };
}

/* ---------------------------------------------------------------- 수집 */

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchOne(id) {
  const detailRes = await fetchJson(DETAIL_URL(id));
  if (detailRes.notFound || !detailRes.data) return { gone: true };
  // 실측은 없는 상품도 많다(가방/모자 등). 없으면 measure만 비고 나머지는 그대로 쓴다.
  let sizeData = null;
  try {
    const sizeRes = await fetchJson(SIZE_URL(id));
    sizeData = sizeRes.notFound ? null : sizeRes.data;
  } catch {
    sizeData = null;
  }
  return { record: buildRecord(detailRes.data, sizeData) };
}

/* 상품 하나당 한 줄, 키는 정렬해서 쓴다. 그냥 JSON.stringify로 한 줄에 다 쓰면 파일이 13MB짜리
   한 줄이 돼서, 상품이 몇 개만 늘어도 git이 매번 13MB를 통째로 새로 저장한다(매일 커밋되니
   1년이면 몇 GB). 줄 단위로 쪼개두면 델타 압축이 먹어서 실제 증가분은 새로 추가된 줄뿐이다.
   줄바꿈만 넣은 것이라 파싱은 평범한 JSON 그대로다. */
function writeJsonByLine(file, obj) {
  const ids = Object.keys(obj).sort();
  const lines = ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(obj[id])}`);
  fs.writeFileSync(file, `{\n${lines.join(",\n")}\n}\n`);
}

/* 전체본(product_meta.json)은 파이프라인용 - 썸네일 URL이 있어야 비전 분류를 다시 돌릴 수 있다.
   대시보드가 받는 슬림본(product_meta_slim.json)에서는 썸네일과 삭제된 상품을 빼서 크기를 줄인다
   (전수 기준 13MB -> 8MB, gzip 1.9MB -> 1.4MB). 상품 카드 이미지는 랭킹 스냅샷에 이미 들어있다. */
function writeMeta(meta) {
  writeJsonByLine(META_FILE, meta);
  const slim = {};
  for (const [id, v] of Object.entries(meta)) {
    if (!v || v.gone) continue;
    const { thumb, ...rest } = v;
    slim[id] = rest;
  }
  writeJsonByLine(META_SLIM_FILE, slim);
}

async function run() {
  const args = process.argv.slice(2);
  const scanAll = args.includes("--all");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : DEFAULT_LIMIT;

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, "utf8")) : {};

  const candidates = collectCandidateIds(index, scanAll);
  const todo = candidates.filter((id) => !meta[id]).slice(0, limit);

  console.log(`후보 상품 ${candidates.length}개 / 이미 수집 ${candidates.length - candidates.filter((id) => !meta[id]).length}개`);
  console.log(`이번에 받을 상품: ${todo.length}개 (동시 ${CONCURRENCY})`);
  if (!todo.length) { console.log("받을 게 없어요."); return; }

  let done = 0, ok = 0, gone = 0, failed = 0, sinceSave = 0;
  const started = Date.now();

  const save = () => { writeMeta(meta); sinceSave = 0; };

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const id = todo[i];
      try {
        const r = await fetchOne(id);
        if (r.gone) { meta[id] = { gone: true }; gone += 1; }
        else { meta[id] = r.record; ok += 1; }
      } catch (e) {
        failed += 1; // 실패한 건 캐시에 안 넣어서 다음 실행에 다시 시도된다
      }
      done += 1; sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) save();
      if (done % 200 === 0 || done === todo.length) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((todo.length - done) / rate / 60);
        console.log(`  ${done}/${todo.length} (성공 ${ok}, 삭제됨 ${gone}, 실패 ${failed}) - ${rate.toFixed(1)}건/초, 남은 시간 약 ${eta}분`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();

  const total = Object.keys(meta).length;
  const withSize = Object.values(meta).filter((m) => m && m.measure && m.measure["총장"]).length;
  console.log(`\n완료. product_meta.json 누적 ${total}개 (총장 있는 상품 ${withSize}개)`);
  console.log(`파일 크기: ${(fs.statSync(META_FILE).size / 1048576).toFixed(1)}MB`);
}

if (require.main === module) {
  run().catch((e) => { console.error("실패:", e); process.exit(1); });
}

module.exports = { buildRecord, pickMaterials, pickReferenceSize, pickMeasurements, productIdsInSnapshot, writeMeta, META_FILE, META_SLIM_FILE };
