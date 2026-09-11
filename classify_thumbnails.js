/*
 * 상품 썸네일을 Claude 비전으로 분류해서 product_meta.json에 채워 넣는다.
 *
 * 왜 필요한가: "상위 경쟁사들이 실제 모델 착용컷/스냅을 쓴다", "빈티지·심플 무드가 주력이다"
 * 같은 건 상품명이나 수치로는 안 나온다. 이미지를 봐야 한다. 무신사 상세 API가 주는 구조화된
 * 값(핏/두께/계절)으로는 '무드'가 안 나오고, 썸네일이 모델컷인지 누끼컷인지도 알 수 없다.
 *
 * 비용을 줄이는 세 가지:
 *  1) 상품당 한 번만. 썸네일은 안 바뀌므로 결과를 캐시하고 다시 안 부른다.
 *  2) Batch API. 같은 요청이 50% 가격이고, 어차피 실시간일 필요가 없는 작업이다.
 *  3) 이미지를 내려받지 않고 CDN URL을 그대로 넘긴다(source.type = "url").
 *
 * 사용법:
 *   node classify_thumbnails.js --estimate       # 돈 안 쓰고 대상 수/예상 비용만 계산
 *   node classify_thumbnails.js --limit 200      # 200개만 분류 (먼저 품질 확인용)
 *   node classify_thumbnails.js                  # 미분류 전부
 *   node classify_thumbnails.js --model claude-haiku-4-5   # 모델 바꾸기
 *
 * ANTHROPIC_API_KEY 환경변수가 필요하다. CI에서는 GitHub Secrets로 넣는다.
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const DATA_DIR = path.join(__dirname, "data");
const { writeMeta, META_FILE } = require("./scrape_product_meta.js");
const BATCH_STATE_FILE = path.join(DATA_DIR, ".classify_batch.json"); // 진행 중인 배치 id 기억용

const DEFAULT_MODEL = "claude-opus-5";
const BATCH_CHUNK = 5000;     // 한 배치에 넣을 요청 수
const POLL_INTERVAL_MS = 30000;

/* 1M 토큰당 단가 (입력, 출력). Batch는 여기서 50%. */
const PRICING = {
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

/* 썸네일 500x500 기준 이미지 토큰 ≈ (w*h)/750, 프롬프트까지 합친 대략치 */
const EST_INPUT_TOKENS = 500;
const EST_OUTPUT_TOKENS = 60;

const SYSTEM = `너는 패션 이커머스 썸네일을 분류하는 도구다. 이미지 한 장을 보고 정해진 스키마로만 답한다.

shot (썸네일 유형, 하나만):
- model: 스튜디오에서 모델이 착용한 컷. 배경이 단색/무지
- snap: 실외나 실내 공간에서 찍은 스냅·룩북 무드컷. 배경에 맥락이 있음
- product: 옷만 단독으로 놓거나 걸어둔 컷(누끼, 플랫레이, 마네킹)
- detail: 원단/디테일 클로즈업, 또는 그래픽·텍스트 위주 기획전 이미지
- other: 위 어디에도 안 맞음

mood (분위기, 0~2개만. 애매하면 비워라):
vintage(빈티지·워시드·레트로), minimal(심플·미니멀·베이직), street(스트릿·오버사이즈),
sporty(스포티·애슬레저), classic(클래식·포멀), outdoor(아웃도어·테크), feminine(페미닌·러블리)

hasPerson: 사람이 보이면 true (얼굴이 안 나와도 몸이 보이면 true)`;

const SCHEMA = {
  type: "object",
  properties: {
    shot: { type: "string", enum: ["model", "snap", "product", "detail", "other"] },
    mood: { type: "array", items: { type: "string", enum: ["vintage", "minimal", "street", "sporty", "classic", "outdoor", "feminine"] } },
    hasPerson: { type: "boolean" },
  },
  required: ["shot", "mood", "hasPerson"],
  additionalProperties: false,
};

function buildRequest(id, thumbUrl, model) {
  return {
    custom_id: `p${id}`,
    params: {
      model,
      max_tokens: 256,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: thumbUrl } },
            { type: "text", text: "이 썸네일을 분류해줘." },
          ],
        },
      ],
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadMeta = () => JSON.parse(fs.readFileSync(META_FILE, "utf8"));
const saveMeta = (m) => writeMeta(m); // 전체본 + 대시보드용 슬림본 같이 갱신

/* 분류가 필요한 상품: 썸네일이 있고, 아직 shot이 없고, 삭제된 상품이 아닌 것 */
function pendingIds(meta) {
  return Object.keys(meta).filter((id) => {
    const m = meta[id];
    return m && !m.gone && m.thumb && !m.shot;
  });
}

function estimate(count, model) {
  const [inRate, outRate] = PRICING[model] || PRICING[DEFAULT_MODEL];
  const inTok = (count * EST_INPUT_TOKENS) / 1e6;
  const outTok = (count * EST_OUTPUT_TOKENS) / 1e6;
  const full = inTok * inRate + outTok * outRate;
  return { full, batch: full / 2, inTok, outTok };
}

/* 배치가 끝날 때까지 기다린다. Batch API의 SLA는 24시간이라 CI(최대 6시간)가 못 버틸 수 있는데,
   그때는 배치 id만 남기고 빠져나간다. 다음 실행이 그 id를 먼저 회수하므로 작업이 날아가지 않는다. */
async function waitForBatch(client, batchId, maxWaitMs) {
  const until = Date.now() + maxWaitMs;
  while (true) {
    const cur = await client.messages.batches.retrieve(batchId);
    const c = cur.request_counts || {};
    console.log(`  ...${cur.processing_status} (성공 ${c.succeeded || 0} / 오류 ${c.errored || 0} / 처리중 ${c.processing || 0})`);
    if (cur.processing_status === "ended") return true;
    if (Date.now() > until) {
      console.log(`  대기 시간을 넘겼어요. 배치 ${batchId}는 계속 돌아가니 다음 실행에서 이어받습니다.`);
      return false;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function submitAndWait(client, requests, model, maxWaitMs) {
  const batch = await client.messages.batches.create({ requests });
  console.log(`  배치 생성: ${batch.id} (${requests.length}건)`);
  fs.writeFileSync(BATCH_STATE_FILE, JSON.stringify({ id: batch.id, model, at: Date.now() }));
  const ended = await waitForBatch(client, batch.id, maxWaitMs);
  return ended ? batch.id : null;
}

/* 이전 실행이 남기고 간 배치가 있으면 먼저 회수한다. */
async function resumePendingBatch(client, meta, maxWaitMs) {
  if (!fs.existsSync(BATCH_STATE_FILE)) return 0;
  const { id } = JSON.parse(fs.readFileSync(BATCH_STATE_FILE, "utf8"));
  console.log(`이전 실행의 배치 ${id}를 이어받습니다.`);
  try {
    const ended = await waitForBatch(client, id, maxWaitMs);
    if (!ended) return 0;
    const { ok, bad } = await collectResults(client, id, meta);
    saveMeta(meta);
    fs.unlinkSync(BATCH_STATE_FILE);
    console.log(`  회수 완료: 성공 ${ok}, 실패 ${bad}`);
    return ok;
  } catch (e) {
    console.error(`  이어받기 실패(${e.message}). 배치 기록을 지우고 새로 진행합니다.`);
    fs.unlinkSync(BATCH_STATE_FILE);
    return 0;
  }
}

/* 배치 결과는 순서가 보장되지 않으므로 custom_id로 되찾는다. */
async function collectResults(client, batchId, meta) {
  let ok = 0, bad = 0;
  for await (const entry of await client.messages.batches.results(batchId)) {
    const id = String(entry.custom_id).replace(/^p/, "");
    if (entry.result?.type !== "succeeded") { bad += 1; continue; }
    const msg = entry.result.message;
    const textBlock = (msg.content || []).find((b) => b.type === "text");
    if (!textBlock) { bad += 1; continue; }
    let parsed;
    try { parsed = JSON.parse(textBlock.text); } catch { bad += 1; continue; }
    if (!meta[id]) { bad += 1; continue; }
    meta[id].shot = parsed.shot;
    meta[id].mood = parsed.mood || [];
    meta[id].hasPerson = !!parsed.hasPerson;
    ok += 1;
  }
  return { ok, bad };
}

async function run() {
  const args = process.argv.slice(2);
  const modelArg = args.indexOf("--model");
  const model = modelArg !== -1 ? args[modelArg + 1] : DEFAULT_MODEL;
  const limitArg = args.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
  const estimateOnly = args.includes("--estimate");

  const meta = loadMeta();
  const todo = pendingIds(meta).slice(0, limit);
  const total = Object.keys(meta).length;

  const est = estimate(todo.length, model);
  console.log(`product_meta.json 상품 ${total}개 / 분류 대상 ${todo.length}개`);
  console.log(`모델: ${model}`);
  console.log(`예상 토큰: 입력 ${est.inTok.toFixed(2)}M, 출력 ${est.outTok.toFixed(2)}M`);
  console.log(`예상 비용: 일반 $${est.full.toFixed(2)} / Batch API $${est.batch.toFixed(2)} (실제로 쓰는 쪽)`);

  if (estimateOnly) { console.log("\n--estimate 모드라 여기서 끝. 실제 호출 안 했어요."); return; }
  if (!todo.length) { console.log("분류할 게 없어요."); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\nANTHROPIC_API_KEY가 없어요. 키를 넣고 다시 실행해주세요.");
    process.exit(1);
  }

  const client = new Anthropic();
  let doneOk = 0, doneBad = 0;

  const waitArg = args.indexOf("--max-wait-min");
  const maxWaitMs = (waitArg !== -1 ? Number(args[waitArg + 1]) : 120) * 60 * 1000;

  doneOk += await resumePendingBatch(client, meta, maxWaitMs);

  for (let i = 0; i < todo.length; i += BATCH_CHUNK) {
    const chunk = todo.slice(i, i + BATCH_CHUNK);
    console.log(`\n[${i / BATCH_CHUNK + 1}번째 배치] ${chunk.length}건`);
    const requests = chunk.map((id) => buildRequest(id, meta[id].thumb, model));
    try {
      const batchId = await submitAndWait(client, requests, model, maxWaitMs);
      if (!batchId) break; // 시간 초과 - 배치 id는 남겨뒀으니 다음 실행이 이어받는다
      const { ok, bad } = await collectResults(client, batchId, meta);
      doneOk += ok; doneBad += bad;
      saveMeta(meta); // 배치 단위로 저장 - 중간에 끊겨도 여기까지는 남는다
      if (fs.existsSync(BATCH_STATE_FILE)) fs.unlinkSync(BATCH_STATE_FILE);
      console.log(`  반영: 성공 ${ok}, 실패 ${bad} (누적 성공 ${doneOk})`);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) console.error("  레이트 리밋. 잠시 후 다시 실행해주세요.");
      else if (e instanceof Anthropic.AuthenticationError) console.error("  API 키가 잘못됐어요.");
      else if (e instanceof Anthropic.APIError) console.error(`  API 오류 ${e.status}: ${e.message}`);
      else console.error("  실패:", e.message);
      saveMeta(meta);
      process.exit(1);
    }
  }

  if (fs.existsSync(BATCH_STATE_FILE)) fs.unlinkSync(BATCH_STATE_FILE);
  const classified = Object.values(meta).filter((m) => m && m.shot).length;
  console.log(`\n완료. 분류된 상품 ${classified}개 (이번 실행 성공 ${doneOk}, 실패 ${doneBad})`);
}

if (require.main === module) {
  run().catch((e) => { console.error("실패:", e); process.exit(1); });
}

module.exports = { buildRequest, pendingIds, estimate, SCHEMA };
