# korea-tax-law-mcp

한국 세법 검색용 MCP 서버. 세 곳을 하나의 MCP로 검색합니다.

| 출처 | 내용 |
|------|------|
| **국세법령정보시스템** (taxlaw.nts.go.kr) | 세법 조문·고시·기본통칙, 세법해석례(질의회신), 판례·심판·심사 결정례, 별표서식, 홈택스 상담사례 |
| **국가법령정보센터 오픈API** (open.law.go.kr) | 현행 법령, 행정규칙, 자치법규, 조약, 법원 판례, 헌재 결정례, 법령해석례, 행정심판례 |
| **조세심판원** (tt.go.kr) | 심판청구 결정례(조심·국심) 검색 및 결정문 전문(주문·이유 포함) |

## 설치

```bash
npm install
```

## 등록

### 인증키
국가법령정보센터 오픈API 인증키(OC)를 `LAW_OC=...` 한 줄로 적은 `.env` 파일을 저장소 밖에 둡니다. 읽는 순서는 다음과 같습니다.

1. `LAW_ENV_FILE` 또는 `IG_ENV_FILE` 환경변수에 적은 절대경로
2. `%LOCALAPPDATA%\InheritanceGift\.env`
3. `node --env-file=<경로>` 인자

### Claude Code
프로젝트 루트에 `.mcp.json`을 만들고 이 폴더에서 Claude Code를 다시 시작합니다.
```json
{
  "mcpServers": {
    "korea-tax-law": {
      "command": "node",
      "args": ["--env-file=<.env 절대경로>", "<이 폴더 절대경로>/server.js"]
    }
  }
}
```

전역 등록:
```bash
claude mcp add korea-tax-law --scope user -- node --env-file="<.env 절대경로>" "<이 폴더 절대경로>/server.js"
```

### Claude Desktop
`%APPDATA%\Claude\claude_desktop_config.json`에 추가:
```json
{
  "mcpServers": {
    "korea-tax-law": {
      "command": "node",
      "args": ["--env-file=<.env 절대경로>", "<이 폴더 절대경로>/server.js"]
    }
  }
}
```

## 제공 도구

| 도구 | 설명 |
|------|------|
| `tax_search_all` | **통합 검색** — 국세법령정보시스템 + 국가법령정보센터 + 조세심판원을 한 번에 검색 (첫 검색으로 추천) |
| `nts_search` | 국세법령정보시스템 통합검색. `collections`로 대상 선택 (statute/question/precedent/appendForm/formerLibrary/hometaxCnslThan), 정렬·기간·문서번호 검색 지원 |
| `nts_get_document` | 국세법령정보시스템 문서 전문 조회 (해석례의 질의·회신 전문, 판례 등) — `nts_search` 결과의 `doc_id` 사용 |
| `law_search` | 국가법령정보센터 검색. `target`으로 대상 선택 (law/admrul/ordin/trty/prec/detc/expc/decc/licbyl/lstrm), 제목/본문 검색 지원 |
| `law_get_detail` | 법령 본문 조회. `jo`로 특정 조문만 조회 가능 (예: `jo: "89"` → 제89조, `"104의2"` → 제104조의2) |
| `tt_search` | 조세심판원 심판결정례 검색. 세법구분(`section`)·세목(`tax_type`)·결정유형(`decision`)·결정기간(`date_from`/`date_to`)·정렬·청구번호 검색 지원 |
| `tt_get_document` | 조세심판원 결정문 전문 조회 (청구번호·결정요지·관련법령·주문·이유) — `tt_search` 결과의 `dem_no` 사용 |

## 사용 예시 (Claude에게)

- "1세대 1주택 비과세 요건 관련 최근 해석례 찾아줘"
- "소득세법 제89조 내용 보여줘"
- "상속주택 양도소득세 관련 판례랑 법령 다 검색해줘"
- "서면-2020-법령해석재산-1234 문서번호로 찾아줘" (문서번호 검색: `search_type: docnum`)
- "가업상속공제 관련 조세심판원 결정례 중 2020년 이후 기각된 것 찾아줘" (`tt_search`, `decision: S503`)
- "조심2026구0212 결정문 전문 보여줘"

## 참고

- `LAW_OC` 환경변수: 국가법령정보센터 오픈API 인증키(OC). 기본값 없음(.env에만 둔다).
- taxlaw.nts.go.kr는 공식 오픈API가 없어 웹사이트 내부 검색 API(`POST /action.do`)를 사용합니다. 사이트 개편 시 동작이 바뀔 수 있습니다.
- tt.go.kr도 공식 오픈API가 없어 상세검색 화면(`POST /mUser/dem/searchDemList.do`)의 HTML을 파싱하고, 결정문 전문은 `/mUser/common/xmlViewer.do`에서 가져옵니다. 사이트 개편 시 파싱이 깨질 수 있습니다.
- `tt_search`의 `세목별건수`는 사이트가 돌려주는 값 그대로이며 검색어·결정유형까지만 반영합니다. 세목·결정기간 필터는 반영되지 않아 `전체건수`와 다를 수 있습니다.
- 조세심판원 상세검색의 '관련조문' 입력란(`txtJomunOrg`)은 값을 넣어도 결과가 달라지지 않아(실측) 도구 파라미터에서 제외했습니다.
- 국세법령정보시스템 검색은 컬렉션(collection) 단위로 결과가 나뉘며, 문서 상세는 `ntstDcmId` 기반입니다.
