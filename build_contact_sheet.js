/*
 * 상품 썸네일 여러 장을 한 판(contact sheet)에 붙인다.
 *
 * 왜: 아트웍 유무는 썸네일을 봐야 안다. 한 장씩 보면 상품 수만큼 읽어야 하니
 * 수천 장에서는 쓸 수 없다. 격자로 붙여 한 번에 25장씩 보면 읽는 횟수가 1/25이 된다.
 *
 * 칸마다 번호를 찍어둔다 - 판을 보고 "3번은 그래픽, 7번은 무지"처럼 번호로 답을 받아
 * 다시 상품 id에 꽂아야 하기 때문이다. 번호와 id의 짝은 같은 이름의 .json으로 남긴다.
 *
 * 사용법:
 *   node build_contact_sheet.js --ids 123,456,...        # 상품 id 지정
 *   node build_contact_sheet.js --cat "반소매 티셔츠" --n 25
 *   node build_contact_sheet.js --todo --n 25 --skip 0   # 미분류 중 앞에서부터
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const DATA_DIR = path.join(__dirname, "data");
const OUT_DIR = path.join(DATA_DIR, "sheets");

/* 한 판에 더 많이 담을수록 읽는 횟수가 줄어든다. 8x8=64장이 한계선이다 -
   더 줄이면 가슴 레터링이 뭉개져 아트웍인지 아닌지 가릴 수 없게 된다.
   타일이 작아 안 보이는 로고는 어차피 "작은 브랜드 라벨"이라 무지로 세는 게 맞다. */
const TILE = Number(process.env.TILE || 164);
const COLS = Number(process.env.COLS || 8);
const PAD = 4;
const LABEL_H = Number(process.env.LABEL_H || 16);

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];

/* 번호를 찍는 띠. 이미지 위에 겹쳐 그리면 옷을 가리므로 칸 아래에 따로 둔다. */
function labelSvg(text, w, h) {
  return Buffer.from(
    `<svg width="${w}" height="${h}">
       <rect width="${w}" height="${h}" fill="#17181C"/>
       <text x="${w / 2}" y="${h * 0.72}" font-family="Arial" font-size="${h * 0.7}"
             fill="#FFFFFF" text-anchor="middle" font-weight="bold">${text}</text>
     </svg>`
  );
}

async function tileOf(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // 윈도우에서 파일 경로를 넘기면 잠김이 생긴다. 버퍼로 넘긴다.
  return sharp(buf).resize(TILE, TILE, { fit: "cover", position: "top" }).toBuffer();
}

async function build(items, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = Math.ceil(items.length / COLS);
  const cellH = TILE + LABEL_H;
  const W = COLS * (TILE + PAD) + PAD;
  const H = rows * (cellH + PAD) + PAD;

  /* 썸네일을 하나씩 받으면 64장짜리 판 하나에 20초가 걸린다. 동시에 받는다. */
  const tiles = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { tiles[i] = await tileOf(items[i].thumb); } catch { tiles[i] = null; }
    }
  }));

  const layers = [];
  const map = [];
  let ok = 0;
  for (let i = 0; i < items.length; i += 1) {
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (TILE + PAD);
    const y = PAD + row * (cellH + PAD);
    if (!tiles[i]) {
      // 썸네일이 사라진 상품은 칸을 비우되 번호는 밀지 않는다 - 밀리면 답을 꽂을 수 없다.
      map.push({ no: i + 1, id: items[i].id, failed: true });
      continue;
    }
    layers.push({ input: tiles[i], left: x, top: y });
    layers.push({ input: labelSvg(String(i + 1), TILE, LABEL_H), left: x, top: y + TILE });
    map.push({ no: i + 1, id: items[i].id, name: items[i].name, cat2: items[i].cat2 });
    ok += 1;
  }

  const file = path.join(OUT_DIR, name + ".png");
  await sharp({ create: { width: W, height: H, channels: 3, background: "#F6F5F1" } })
    .composite(layers).png({ compressionLevel: 9 }).toFile(file);
  fs.writeFileSync(path.join(OUT_DIR, name + ".json"), JSON.stringify(map, null, 1));

  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`${file}  ${W}x${H}  ${kb}KB  (${ok}/${items.length}장)`);
  return { file, map };
}

/* 최근 스냅샷에서 상품을 모은다 - 이름과 썸네일이 둘 다 필요하다. */
function pool() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta.json"), "utf8"));
  const days = Object.keys(index).sort().reverse().slice(0, 28);
  const seen = new Map();
  for (const d of days) {
    const times = index[d] || [];
    if (!times.length) continue;
    const f = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(f)) continue;
    const snap = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        const id = idOf(it.url);
        const m = meta[id];
        if (!id || seen.has(id) || !m || !m.thumb) continue;
        seen.set(id, { id, name: it.name, thumb: m.thumb, cat2: m.cat2 });
      }
    }
  }
  return [...seen.values()];
}

async function run() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
  const n = Number(arg("--n", 25));
  const skip = Number(arg("--skip", 0));
  const name = arg("--name", "sheet");

  let items;
  const ids = arg("--ids", null);
  if (ids) {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta.json"), "utf8"));
    items = ids.split(",").map((id) => ({ id, thumb: (meta[id] || {}).thumb, name: "", cat2: (meta[id] || {}).cat2 }))
      .filter((x) => x.thumb);
  } else {
    const artwork = fs.existsSync(path.join(DATA_DIR, "product_artwork.json"))
      ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_artwork.json"), "utf8")) : {};
    let list = pool();
    const cat = arg("--cat", null);
    if (cat) list = list.filter((x) => x.cat2 === cat);
    if (args.includes("--todo")) list = list.filter((x) => !artwork[x.id]);
    items = list.slice(skip, skip + n);
  }
  if (!items.length) { console.log("붙일 게 없어요."); return; }
  await build(items, name);
}

if (require.main === module) run().catch((e) => { console.error("실패:", e.message); process.exit(1); });
module.exports = { build, pool };
