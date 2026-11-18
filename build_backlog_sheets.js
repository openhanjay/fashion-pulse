/*
 * 지난 달들(7~10월)에만 올라왔던 상품까지 포함해, 아직 아트웍을 못 가린 것 전부를
 * 판으로 만든다.
 *
 * build_all_sheets.js는 최근 28일 스냅샷(pool)만 본다 - 지금 랭킹에 있는 것만
 * 채우면 되니까. 하지만 7월과 11월을 비교하려면 7월에만 있던 상품도 가려야 한다.
 * 그래서 여기서는 수집 첫날부터 전부 훑는다.
 *
 * 한 번에 다 만들면 PNG가 500MB 가까이 쌓인다. --from/--count로 끊어 만들고,
 * 다 가린 판은 지우면서 간다.
 *
 * 사용법: node build_backlog_sheets.js --from 0 --count 20 [--prefix bk]
 */

const fs = require("fs");
const path = require("path");
const { build } = require("./build_contact_sheet");

const DATA_DIR = path.join(__dirname, "data");
const PER_SHEET = 100;

/* 수집 전 기간에서 한 번이라도 랭킹에 올라온 상품을 모은다. 같은 상품은 가장
   최근에 본 이미지 주소를 쓴다 - 옛 주소는 CDN에서 죽어 있는 경우가 많다. */
function allSeen() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const idx = index.dates || index;
  const metaFile = path.join(DATA_DIR, "product_meta.json");
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  const seen = new Map();
  for (const d of Object.keys(idx).sort().reverse()) {
    const times = idx[d] || [];
    if (!times.length) continue;
    const f = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(f)) continue;
    const snap = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        const id = (String(it.url || "").match(/products\/(\d+)/) || [])[1];
        if (!id || seen.has(id)) continue;
        const thumb = it.image || (meta[id] && meta[id].thumb);
        if (!thumb) continue;
        seen.set(id, { id, name: it.name, thumb, cat2: (meta[id] || {}).cat2 || "" });
      }
    }
  }
  return [...seen.values()];
}

async function run() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
  const prefix = arg("--prefix", "bk");
  const from = Number(arg("--from", 0));
  const count = Number(arg("--count", 20));

  const artFile = path.join(DATA_DIR, "product_artwork.json");
  const artwork = fs.existsSync(artFile) ? JSON.parse(fs.readFileSync(artFile, "utf8")) : {};

  // 같은 품목이 한 판에 모여야 보는 사람이 기준을 유지한다.
  const todo = allSeen().filter((x) => !artwork[x.id])
    .sort((a, b) => String(a.cat2).localeCompare(String(b.cat2)) || a.id.localeCompare(b.id));

  const total = Math.ceil(todo.length / PER_SHEET);
  console.log(`미분류 ${todo.length}개 -> 전체 ${total}판 / 이번에 ${from + 1}~${Math.min(from + count, total)}판`);

  for (let i = from; i < Math.min(from + count, total); i += 1) {
    const slice = todo.slice(i * PER_SHEET, (i + 1) * PER_SHEET);
    const name = `${prefix}${String(i + 1).padStart(3, "0")}`;
    if (fs.existsSync(path.join(DATA_DIR, "sheets", name + ".png"))) { console.log(`${name} 이미 있음`); continue; }
    await build(slice, name);
  }
}

if (require.main === module) run().catch((e) => { console.error("실패:", e.message); process.exit(1); });
