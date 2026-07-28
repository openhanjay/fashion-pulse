/*
 * fashion-pulse 폴더를 서빙하는 아주 작은 정적 파일 서버 (외부 패키지 설치 불필요).
 *
 * 사용법:
 *   node serve.js         (기본 포트 8000)
 *   node serve.js 5500    (포트 지정)
 *
 * 실행 후 브라우저에서 http://localhost:8000/fashion_marketer_dashboard.html 접속.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/fashion_marketer_dashboard.html";
  const filePath = path.join(ROOT, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}/fashion_marketer_dashboard.html`);
  console.log("종료하려면 Ctrl+C");
});
