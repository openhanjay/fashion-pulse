/*
 * 상품에 아트웍(그래픽·프린트·자수·레터링 등)이 들어갔는지를 판별해 쌓는다.
 *
 * 왜 이게 어려운가: 무신사 어디에도 이 정보가 없다. 상품 속성(goodsMaterial)에는 핏·두께·
 * 계절뿐이고, 소재 고시에도, PLP 필터에도 패턴·프린트 항목이 없다. 상품명으로는 최근 4주
 * 11,522개 중 9.3%만 아트웍 키워드가 있고 3.6%만 무지 키워드가 있다 - 87%는 이름만 봐서
 * 알 수 없다("스탠다드 롱 다운 자켓"이 무지인지 프린트인지 이름이 말해주지 않는다).
 * 결국 썸네일을 봐야 한다.
 *
 * 그래서 두 단계로 채운다.
 *   1) 이름에 확실한 단서가 있는 것만 먼저 표시한다(src:"name"). 공짜지만 적게 덮는다.
 *   2) 나머지는 썸네일을 Claude에 보내 판별한다(src:"vision"). 비전 결과가 이름 결과를 덮는다.
 *
 * 2단계는 API 키가 있어야 돌고 돈이 든다. Batch API + Haiku 4.5 기준 장당 약 $0.0004,
 * 최근 4주치(11,500개) 약 $4.3, 랭킹에 오른 전체(34,000개) 약 $13 정도다.
 *
 * 사용법:
 *   node classify_artwork.js --names            # 1단계만 (무료, 키 불필요)
 *   node classify_artwork.js --vision           # 2단계 배치 제출/수거
 *   node classify_artwork.js --vision --limit 60  # 맛보기
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "product_artwork.json");
const BATCH_STATE = path.join(DATA_DIR, ".artwork_batch.json");
const RECENT_DAYS = 28;
const MODEL = "claude-haiku-4-5";

/*
 * 이름으로 확실할 때만 쓴다. 애매한 단어는 일부러 뺐다 -
 * "빈티지"나 "워싱"은 아트웍일 수도 아닐 수도 있어서 넣으면 틀린 쪽이 더 많다.
 */
const NAME_ARTWORK = /그래픽|프린팅|프린트|print(?!ed\s+label)|graphic|아트웍|아트워크|artwork|레터링|lettering|자수|엠브로이더|embroider|와펜|패치워크|타이포|페인팅|실크스크린|아플리케|캐릭터|일러스트|플로럴|페이즐리|아가일|타이다이|타이 다이|체크|스트라이프|도트|카모|플라워/i;
const NAME_PLAIN = /무지|솔리드|solid|플레인|plain|노로고|무봉제/i;

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];

function load() {
  return fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : {};
}

/* 상품 하나당 한 줄 - 매일 커밋되는 파일이라 줄 단위여야 git 델타가 먹는다. */
function save(obj) {
  const ids = Object.keys(obj).sort();
  fs.writeFileSync(OUT_FILE, `{\n${ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(obj[id])}`).join(",\n")}\n}\n`);
}

/* 최근 랭킹에 오른 상품을 최근 날짜부터 모은다. */
function candidates(scanAll) {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const dates = Object.keys(index).sort().reverse();
  const targets = scanAll ? dates : dates.slice(0, RECENT_DAYS);
  const out = [];
  const seen = new Set();
  for (const d of targets) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        const id = idOf(it.url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: it.name });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------- 1단계: 이름 */

function runNames(scanAll) {
  const store = load();
  const list = candidates(scanAll);
  let art = 0, plain = 0;
  for (const { id, name } of list) {
    // 비전으로 이미 본 건 이름으로 덮지 않는다. 비전이 더 정확하다.
    if (store[id] && store[id].src === "vision") continue;
    if (NAME_ARTWORK.test(name)) { store[id] = { art: true, src: "name" }; art += 1; }
    else if (NAME_PLAIN.test(name)) { store[id] = { art: false, src: "name" }; plain += 1; }
  }
  save(store);
  console.log(`이름으로 판별: 아트웍 ${art}개 / 무지 ${plain}개 (대상 ${list.length}개)`);
  console.log(`  누적 ${Object.keys(store).length}개 - 나머지는 썸네일을 봐야 합니다(--vision).`);
}

/* ---------------------------------------------------------- 2단계: 비전 */

const PROMPT = `이 의류 상품 썸네일을 보고, 옷 자체에 아트웍이 들어갔는지 판별해줘.

아트웍 = 그래픽/프린트, 큼직한 로고나 레터링, 자수, 패치, 체크·스트라이프·플로럴 같은 무늬.
아트웍 아님 = 무지(민무늬) 단색, 또는 가슴에 작게 박힌 브랜드 라벨 정도만 있는 것.

옷이 아닌 상품(가방·모자·신발·액세서리)이면 그 물건 표면 기준으로 판단해줘.
사람·배경·소품은 보지 말고 상품만 봐.`;

const SCHEMA = {
  type: "object",
  properties: {
    artwork: { type: "boolean", description: "아트웍이 있으면 true" },
    kind: { type: "string", description: "있으면 종류 한 단어(그래픽/로고/자수/체크/스트라이프/플로럴 등), 없으면 빈 문자열" },
    confident: { type: "boolean", description: "썸네일로 확실히 판단되면 true" },
  },
  required: ["artwork", "kind", "confident"],
  additionalProperties: false,
};

async function runVision(limit, scanAll) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const store = load();
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta.json"), "utf8"));

  const state = fs.existsSync(BATCH_STATE) ? JSON.parse(fs.readFileSync(BATCH_STATE, "utf8")) : null;

  // 제출해둔 배치가 있으면 먼저 거둬들인다.
  if (state && state.batchId) {
    const batch = await client.messages.batches.retrieve(state.batchId);
    console.log(`배치 ${state.batchId}: ${batch.processing_status}`);
    if (batch.processing_status !== "ended") {
      console.log("아직 처리 중입니다. 나중에 다시 실행해주세요.");
      return;
    }
    let ok = 0, failed = 0;
    for await (const r of await client.messages.batches.results(state.batchId)) {
      if (r.result.type !== "succeeded") { failed += 1; continue; }
      const block = r.result.message.content.find((b) => b.type === "text");
      if (!block) { failed += 1; continue; }
      try {
        const v = JSON.parse(block.text);
        store[r.custom_id] = { art: !!v.artwork, kind: v.kind || null, src: "vision", sure: !!v.confident };
        ok += 1;
      } catch { failed += 1; }
    }
    save(store);
    fs.unlinkSync(BATCH_STATE);
    console.log(`거둠: 성공 ${ok}, 실패 ${failed} / 누적 ${Object.keys(store).length}개`);
    return;
  }

  // 새 배치를 만든다. 비전으로 아직 안 본 것만.
  const todo = candidates(scanAll)
    .filter((c) => !(store[c.id] && store[c.id].src === "vision"))
    .filter((c) => meta[c.id] && meta[c.id].thumb)
    .slice(0, limit);

  if (!todo.length) { console.log("보낼 게 없어요."); return; }

  const requests = todo.map((c) => ({
    custom_id: c.id,
    params: {
      model: MODEL,
      max_tokens: 256,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: meta[c.id].thumb } },
          { type: "text", text: PROMPT },
        ],
      }],
    },
  }));

  const batch = await client.messages.batches.create({ requests });
  fs.writeFileSync(BATCH_STATE, JSON.stringify({ batchId: batch.id, count: todo.length, at: new Date().toISOString() }));
  console.log(`배치 제출: ${batch.id} (${todo.length}장)`);
  console.log("처리는 보통 몇 분~1시간 걸립니다. 같은 명령을 다시 실행하면 결과를 거둬옵니다.");
}

function run() {
  const args = process.argv.slice(2);
  const scanAll = args.includes("--all");
  const li = args.indexOf("--limit");
  const limit = li !== -1 ? Number(args[li + 1]) : Infinity;

  if (args.includes("--vision")) return runVision(limit, scanAll);
  return runNames(scanAll);
}

if (require.main === module) {
  Promise.resolve(run()).catch((e) => { console.error("실패:", e.message); process.exit(1); });
}
module.exports = { NAME_ARTWORK, NAME_PLAIN, candidates };
