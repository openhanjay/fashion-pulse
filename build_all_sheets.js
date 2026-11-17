/*
 * 미분류 상품 전부를 판(contact sheet)으로 만든다.
 *
 * build_contact_sheet.js를 한 판씩 부르면 프로세스를 수백 번 띄우게 되고, 매번
 * 상품 속성 38MB를 다시 읽는다. 여기서는 한 번 읽어 쭉 돌린다.
 *
 * 한 판에 100장(10x10)이 한계선이다. 더 줄이면 가슴 레터링이 뭉개져 아트웍인지
 * 가릴 수 없다. 타일이 작아 안 보이는 로고는 어차피 "작게 박힌 브랜드 라벨"이라
 * 무지로 세는 게 맞으므로, 작아서 사라지는 것은 오히려 기준과 맞는다.
 *
 * 사용법: node build_all_sheets.js [--prefix all] [--max 200]
 */

const fs = require("fs");
const path = require("path");
const { build, pool } = require("./build_contact_sheet");

const DATA_DIR = path.join(__dirname, "data");
const PER_SHEET = 100;

async function run() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
  const prefix = arg("--prefix", "all");
  const max = Number(arg("--max", Infinity));

  const artFile = path.join(DATA_DIR, "product_artwork.json");
  const artwork = fs.existsSync(artFile) ? JSON.parse(fs.readFileSync(artFile, "utf8")) : {};

  // 같은 품목이 한 판에 모이면 보는 사람이 기준을 유지하기 쉽다.
  const todo = pool().filter((x) => !artwork[x.id])
    .sort((a, b) => String(a.cat2 || "").localeCompare(String(b.cat2 || "")));

  const sheets = Math.min(max, Math.ceil(todo.length / PER_SHEET));
  console.log(`미분류 ${todo.length}개 -> ${sheets}판`);

  for (let i = 0; i < sheets; i += 1) {
    const slice = todo.slice(i * PER_SHEET, (i + 1) * PER_SHEET);
    const name = `${prefix}${String(i + 1).padStart(3, "0")}`;
    if (fs.existsSync(path.join(DATA_DIR, "sheets", name + ".png"))) { console.log(`${name} 이미 있음`); continue; }
    await build(slice, name);
  }
}

if (require.main === module) run().catch((e) => { console.error("실패:", e.message); process.exit(1); });
