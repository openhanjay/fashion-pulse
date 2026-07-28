"""
무신사 랭킹(전체/급상승/NEW x 6개 카테고리)을 수집해서 musinsa_ranking.json으로 저장하는 스크립트.

사용법:
    python scrape_musinsa.py

실행 후 생성되는 musinsa_ranking.json을 fashion_marketer_dashboard.html과 같은 폴더에 두고,
로컬 서버(python -m http.server)로 대시보드를 열면 대시보드가 이 파일을 fetch해서 보여준다.
"""

import json
import time
import urllib.parse
import urllib.request

BASE_URL = "https://client.musinsa.com/api/home/web/v5/pans/ranking"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# 대시보드 카테고리 <-> 무신사 categoryCode
CATEGORY_CODES = {
    "상의": "001000",
    "아우터": "002000",
    "바지": "003000",
    "원피스": "100000",
    "가방": "004000",
    "모자": "120000",
}

# 대시보드 랭킹 필터 <-> 무신사 sectionId
SECTION_IDS = {
    "all": "199",
    "new": "200",
    "rising": "201",
}

REQUEST_DELAY_SEC = 0.7
OUTPUT_FILE = "musinsa_ranking.json"


def fetch_ranking(section_id, category_code):
    params = {
        "storeCode": "musinsa",
        "sectionId": section_id,
        "skip_bf": "Y",
        "gf": "A",
        "contentsId": "",
        "categoryCode": category_code,
        "ageBand": "AGE_BAND_ALL",
        "period": "REALTIME",
        "soldOut": "true",
    }
    url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def extract_products(payload):
    products = []
    modules = payload.get("data", {}).get("modules", [])
    for module in modules:
        if module.get("type") != "MULTICOLUMN":
            continue
        for item in module.get("items", []):
            if item.get("type") != "PRODUCT_COLUMN":
                continue
            info = item.get("info", {})
            image = item.get("image", {})
            labels = image.get("labels") or []
            products.append(
                {
                    "rank": image.get("rank"),
                    "brand": info.get("brandName", ""),
                    "name": info.get("productName", ""),
                    "price": info.get("finalPrice", 0),
                    "discountRatio": info.get("discountRatio", 0),
                    "image": image.get("url", ""),
                    "url": item.get("onClick", {}).get("url", ""),
                    "badge": labels[0]["text"] if labels else None,
                }
            )
    products.sort(key=lambda p: p["rank"] if p["rank"] is not None else 9999)
    return products[:100]


def main():
    result = {}
    for category, category_code in CATEGORY_CODES.items():
        result[category] = {}
        for filter_key, section_id in SECTION_IDS.items():
            print(f"수집 중: {category} / {filter_key} ...")
            payload = fetch_ranking(section_id, category_code)
            result[category][filter_key] = extract_products(payload)
            time.sleep(REQUEST_DELAY_SEC)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"완료: {OUTPUT_FILE} 저장됨")


if __name__ == "__main__":
    main()
