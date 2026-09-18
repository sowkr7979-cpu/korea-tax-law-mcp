#!/usr/bin/env node
/**
 * korea-tax-law-mcp
 *
 * MCP server that searches three Korean tax/law databases:
 *  1. taxlaw.nts.go.kr  - 국세법령정보시스템 (국세청): 세법, 세법해석례(질의회신),
 *     판례/심판/심사 결정례, 별표서식, 홈택스 상담사례
 *  2. open.law.go.kr    - 국가법령정보센터 오픈API (법제처): 법령, 행정규칙, 판례,
 *     법령해석례, 자치법규, 조약 등
 *  3. www.tt.go.kr      - 조세심판원: 심판청구 결정례(조심·국심) 검색·결정문 전문
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// open.law.go.kr API key — 비밀 파일 값을 우선한다(하드코딩 금지). 경로·파싱 규칙은 env-file.mjs(트리 밖 %LOCALAPPDATA%\InheritanceGift\.env 기본).
// node --env-file 은 이미 있는 프로세스 환경변수를 덮어쓰지 않으므로(Windows 사용자 환경변수 LAW_OC가 .env를 가리는 경우가 있어) 파일을 직접 읽는다. 실값은 어디에도 출력하지 않는다.
import { loadEnvFile, pickSecret } from "./env-file.mjs";
const ENV_LOADED = loadEnvFile();
const ENV_FILE = ENV_LOADED.values;
const OC_PICK = pickSecret("LAW_OC", ENV_FILE);
const OC_PICK2 = pickSecret("LAW_OPEN_API_OC", ENV_FILE);
const LAW_OC = OC_PICK.value || OC_PICK2.value;
const ENV_CONFLICT = OC_PICK.conflict || OC_PICK2.conflict;
if (!LAW_OC) { console.error("LAW_OC 가 없습니다. %LOCALAPPDATA%\\InheritanceGift\\.env 또는 IG_ENV_FILE 로 비밀 파일을 두세요."); process.exit(2); }
if (ENV_CONFLICT) {
  console.error(`[korea-tax-law] 환경변수 LAW_OC(길이 ${OC_PICK.envLen || OC_PICK2.envLen})가 .env(길이 ${OC_PICK.fileLen || OC_PICK2.fileLen})와 다름 — .env 값을 사용합니다. 사용자 환경변수를 삭제하세요.`);
}
console.error(`[korea-tax-law] env file: ${ENV_LOADED.path ? "loaded" : "none"}`);
const NTS_BASE = "https://taxlaw.nts.go.kr";
const LAW_BASE = "https://www.law.go.kr/DRF";

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) korea-tax-law-mcp/1.0",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip search-engine highlight markers (<!HS> ... <!HE>) and <em> tags. */
function stripHighlight(s) {
  if (s == null) return s;
  return String(s)
    .replace(/<!HS>|<!HE>/g, "")
    .replace(/<\/?em[^>]*>/g, "")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  if (s == null) return s;
  s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function jsonResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: `오류: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// taxlaw.nts.go.kr (국세법령정보시스템)
// ---------------------------------------------------------------------------

/**
 * Generic action call. The site is a JSP app where every AJAX request goes to
 * POST /action.do with form fields:  actionId=<id>, paramData=<JSON string>.
 */
async function ntsAction(actionId, paramData, referer) {
  const body = new URLSearchParams({
    actionId,
    paramData: JSON.stringify(paramData),
  });
  const res = await fetch(`${NTS_BASE}/action.do`, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: referer || `${NTS_BASE}/index.do`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) throw new Error(`taxlaw.nts.go.kr HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "SUCCESS") {
    throw new Error(
      `taxlaw.nts.go.kr API 오류 (status=${json.status}${json.message ? `, message=${json.message}` : ""})`
    );
  }
  return json.data;
}

const NTS_COLLECTIONS = {
  statute: "세법·법령 (조문, 고시, 기본통칙 등)",
  question: "세법해석례 (질의회신, 서면답변, 기획재정부 해석)",
  precedent: "판례·심판례·심사청구 결정례",
  appendForm: "별표·서식",
  formerLibrary: "기타 자료실",
  hometaxCnslThan: "홈택스 상담사례",
};

const NTS_SORTS = {
  relevance: "SCORE/DESC",
  latest: "DCM_RGT_DTM/DESC",
  oldest: "DCM_RGT_DTM/ASC",
};

/** Build a human-viewable detail URL for a search hit, when we know how. */
function ntsDetailUrl(collection, item) {
  const docId = item.DOC_ID;
  if (!docId) return undefined;
  if (collection === "question")
    return `${NTS_BASE}/qt/USEQTA002P.do?ntstDcmId=${docId}`;
  if (collection === "precedent")
    return `${NTS_BASE}/pd/USEPDA002P.do?ntstDcmId=${docId}`;
  return undefined;
}

function normalizeNtsItem(collection, item) {
  const out = {
    제목: stripHighlight(item.TTL || item.NM),
    문서유형: item.LBL1_NM || item.NTST_DCM_CL_NM || undefined,
    문서번호: stripHighlight(
      (item.DOCU_NO_STR1 || "").split(" ")[0] || undefined
    ),
    날짜: item.DCM_RGT_DTM_S || item.PMG_DT || item.FRS_RGT_DTM || undefined,
    요지: truncate(
      stripHighlight(item.GIST_CNTN || item.CNTN || item.TEXT_KRN_CNTN),
      400
    ),
    doc_id: item.DOC_ID || undefined,
    상세보기: ntsDetailUrl(collection, item),
  };
  // statute rows carry 조문 info instead of a document id
  if (collection === "statute") {
    out.조문 = stripHighlight(
      [item.TEXT_UQNM, item.TEXT_KRN_NM].filter(Boolean).join(" ")
    ) || undefined;
    out.시행일자 = item.ENFR_DT || undefined;
  }
  // drop empty keys
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === "") delete out[k];
  return out;
}

async function ntsSearch({
  query,
  collections,
  page = 1,
  pageSize = 10,
  sort = "relevance",
  dateFrom,
  dateTo,
  searchType = "keyword",
}) {
  const param = {
    schVcb: query,
    startCount: page,
    collection: collections.join(","),
    wnKey: "",
    // "" = 일반 키워드 검색, "document" = 문서번호 검색
    searchType: searchType === "docnum" ? "document" : "",
    sortField: NTS_SORTS[sort] || NTS_SORTS.relevance,
    icldVcbCtl: [],
    exclVcbCtl: [],
    rltnStttCtl: [],
    ntstTlawClCdList: [],
    viewCount: String(pageSize),
    mainIdCtl: [],
    useSynonymYn: "N",
  };
  if (dateFrom) param.bltnStrtDtm = dateFrom.replace(/-/g, "") + "000000";
  if (dateTo) param.bltnEndDtm = dateTo.replace(/-/g, "") + "999999";

  const data = await ntsAction(
    "ASEISA001MR01",
    param,
    `${NTS_BASE}/is/USEISA001M.do`
  );
  const sr = data?.ASEISA001MR01?.searchResultVO || {};
  const cols = sr.collectionList || [];

  const results = {};
  let total = 0;
  cols.forEach((c, i) => {
    const name = c.nameEn || c.collectionKnd || collections[i] || `col${i}`;
    const count = c.totalCount || 0;
    total += count;
    results[name] = {
      설명: NTS_COLLECTIONS[name] || name,
      총건수: count,
      목록: (c.resultList || []).map((it) => normalizeNtsItem(name, it)),
    };
  });

  return {
    출처: "국세법령정보시스템 (taxlaw.nts.go.kr)",
    검색어: query,
    페이지: page,
    전체건수: total,
    컬렉션별결과: results,
  };
}

async function ntsGetDocument(docId) {
  const data = await ntsAction(
    "ASIQTB002PR01",
    { dcmDVO: { ntstDcmId: docId } },
    `${NTS_BASE}/qt/USEQTA002P.do`
  );
  const dvo = data?.ASIQTB002PR01?.dcmDVO;
  if (!dvo) throw new Error(`문서를 찾을 수 없습니다 (ntstDcmId=${docId})`);
  return {
    출처: "국세법령정보시스템 (taxlaw.nts.go.kr)",
    doc_id: dvo.ntstDcmId,
    제목: dvo.ntstDcmTtl,
    문서유형: dvo.ntstDcmClNm || dvo.ntstDcmClCd,
    문서번호: dvo.ntstDcmDscmCntn || undefined,
    생산일자: dvo.ntstDcmRgtDt,
    귀속연도: dvo.attrYr || undefined,
    요지: stripHighlight(dvo.ntstDcmGistCntn) || undefined,
    질의_사실관계: stripHighlight(dvo.ntstDcmCntn) || undefined,
    회신_결정내용: stripHighlight(dvo.ntstDcmRplyCntn) || undefined,
    상세보기: `${NTS_BASE}/qt/USEQTA002P.do?ntstDcmId=${dvo.ntstDcmId}`,
  };
}

// ---------------------------------------------------------------------------
// open.law.go.kr (국가법령정보센터 오픈API)
// ---------------------------------------------------------------------------

const LAW_TARGETS = {
  law: "현행 법령",
  eflaw: "시행일 법령",
  admrul: "행정규칙 (훈령·예규·고시)",
  ordin: "자치법규 (조례·규칙)",
  trty: "조약",
  prec: "법원 판례",
  detc: "헌법재판소 결정례",
  expc: "법령해석례 (법제처)",
  decc: "행정심판례",
  licbyl: "별표·서식",
  lstrm: "법령용어",
};

// 사용자 OC가 "사용자 정보 검증에 실패"(서버 IP·도메인 미등록)를 내면 공개 예시 키 `test`로 한 번 더 시도한다(개발·검증용).
// 산출물 링크는 어차피 공개 주소만 쓰므로(플랜 E-0 7항) 키 종류가 결과에 섞이지 않는다. 경고는 stderr에 1회, 실값은 찍지 않는다.
let OC_MODE = "user";
let ocWarned = false;
function isUserVerifyFailure(obj) {
  const r = obj && typeof obj === "object" ? String(obj.result || obj.msg || "") : "";
  return /사용자\s*정보\s*검증/.test(r);
}
async function lawApi(endpoint, params) {
  const attempt = async (oc) => {
    const qs = new URLSearchParams({ OC: oc, type: "JSON", ...params });
    const url = `${LAW_BASE}/${endpoint}?${qs}`;
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (!res.ok) throw new Error(`open.law.go.kr HTTP ${res.status}`);
    return res.text();
  };
  let text = await attempt(OC_MODE === "test" ? "test" : LAW_OC);
  try {
    const first = JSON.parse(text);
    if (OC_MODE === "user" && isUserVerifyFailure(first) && process.env.LAW_OC_ALLOW_TEST_FALLBACK === "1") {
      if (!ocWarned) {
        ocWarned = true;
        console.error(`[korea-tax-law] OC 키(${String(LAW_OC).slice(0, 2)}***) 사용자 검증 실패 — open.law.go.kr 마이페이지에서 서버 IP·도메인을 등록하세요. 공개 키 test로 대체합니다(개발용).`);
      }
      OC_MODE = "test";
      text = await attempt("test");
    }
  } catch {
    /* JSON 아님 → 아래 파싱 오류 경로로 */
  }
  try {
    return JSON.parse(text);
  } catch {
    // Unauthorized keys / bad targets return an HTML page instead of JSON
    throw new Error(
      `open.law.go.kr 응답이 JSON이 아닙니다. OC 키(${String(LAW_OC).slice(0, 2)}***) 승인 여부 또는 target을 확인하세요. 응답 앞부분: ${text.slice(0, 200)}`
    );
  }
}

async function lawSearch({ query, target = "law", page = 1, display = 10, scope = 1 }) {
  const json = await lawApi("lawSearch.do", {
    target,
    query,
    page: String(page),
    display: String(display),
    search: String(scope), // 1=제목 검색, 2=본문 검색
  });
  const root = json[Object.keys(json)[0]] || {};
  let list = root[target] ?? root[Object.keys(LAW_TARGETS).find((k) => root[k])] ?? [];
  if (!Array.isArray(list)) list = [list];

  return {
    출처: "국가법령정보센터 (open.law.go.kr)",
    검색어: query,
    대상: `${target} (${LAW_TARGETS[target] || target})`,
    전체건수: Number(root.totalCnt || 0),
    페이지: Number(root.page || page),
    목록: list.map((it) => {
      const out = { ...it };
      // make detail links absolute
      for (const k of Object.keys(out)) {
        if (typeof out[k] === "string" && out[k].startsWith("/DRF/")) {
          out[k] = `https://www.law.go.kr${out[k]}`;
        }
      }
      delete out.id;
      return out;
    }),
  };
}

async function lawDetail({ target = "law", mst, id, jo }) {
  const params = { target };
  if (mst) params.MST = String(mst);
  if (id) params.ID = String(id);
  if (jo) {
    // 조번호: "2" -> "000200", "10의2" -> "001002"
    const m = String(jo).match(/^(\d+)(?:의(\d+))?$/);
    if (m) {
      params.JO =
        m[1].padStart(4, "0") + (m[2] ? m[2].padStart(2, "0") : "00");
    } else {
      params.JO = String(jo);
    }
  }
  const json = await lawApi("lawService.do", params);
  return {
    출처: "국가법령정보센터 (open.law.go.kr)",
    ...json,
  };
}

// ---------------------------------------------------------------------------
// tt.go.kr (조세심판원 — 심판결정례)
// ---------------------------------------------------------------------------
// 공식 오픈API가 없어 상세검색 화면(POST /mUser/dem/searchDemList.do)이 돌려주는 HTML을
// 파싱한다. 결정문 전문은 상세팝업이 iframe으로 부르는 /mUser/common/xmlViewer.do 에서 가져온다.
// 사이트 개편 시 파싱이 깨질 수 있다.
const TT_BASE = "https://www.tt.go.kr";

// rdSection (세법 구분)
const TT_SECTIONS = {
  "00": "전체",
  "01": "내국세",
  "02": "관세",
  "03": "지방세",
};

// rdSemok (세목). 내국세=11/12/20/40/50/99, 관세=90, 지방세=96/97/98
const TT_TAX_TYPES = {
  "00": "전체",
  "11": "양도",
  "12": "소득",
  "20": "법인",
  "40": "상증",
  "50": "부가",
  "90": "관세",
  "96": "취득",
  "97": "재산",
  "98": "지방·기타",
  "99": "기타",
};

// rdJudge (결정유형)
const TT_DECISIONS = {
  S500: "전체",
  S501: "취소",
  S502: "경정",
  S503: "기각",
  S504: "각하",
  S507: "재조사",
  S599: "인용(취소·경정 등)",
};

const TT_SORTS = {
  relevance: "RANK/ASC",
  latest: "DATE/DESC",
  oldest: "DATE/ASC",
  title: "TITLE/ASC",
};

const HTML_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  middot: "·",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  prime: "′",
  Prime: "″",
  deg: "°",
  times: "×",
  divide: "÷",
  sim: "∼",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  sect: "§",
  para: "¶",
  copy: "©",
  reg: "®",
  trade: "™",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "",
  zwnj: "",
};

function htmlUnescape(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, ent)
      ? HTML_ENTITIES[ent]
      : m;
  });
}

/** 태그 제거 + 엔티티 해제 + 공백 정리 (검색결과 셀 단위). */
function ttText(s) {
  if (s == null) return "";
  return htmlUnescape(String(s).replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** 결정문 전문처럼 줄바꿈을 살려야 하는 블록용. */
function ttBlockText(s) {
  return htmlUnescape(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ttPost(params) {
  const res = await fetch(`${TT_BASE}/mUser/dem/searchDemList.do`, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: `${TT_BASE}/mUser/dem/searchDemList.do`,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`tt.go.kr HTTP ${res.status}`);
  return res.text();
}

function ttParseRows(html) {
  const rows = [];
  const chunks = html.split('<li class="result-box">').slice(1);
  for (const c of chunks) {
    const body = c.split("</li>")[0];
    const link = /searchPopup_dem\('([^']+)'/.exec(body)?.[1];
    const demNo = link ? /dem_no=(\d+)/.exec(link)?.[1] : undefined;
    const title = /return false;">([\s\S]*?)<\/a>/.exec(body)?.[1];
    const gist = /<div class="result-txt">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(body)?.[1];
    const out = {
      청구번호: ttText(/(?:청구번호|사건번호)<\/span>\s*([^<]+)/.exec(body)?.[1]),
      제목: ttText(title),
      세목: ttText(/<span class="label label-tax[^"]*">([\s\S]*?)<\/span>/.exec(body)?.[1]),
      결정유형: ttText(
        /<span class="label label-decision[^"]*">([\s\S]*?)<\/span>/.exec(body)?.[1]
      ),
      결정일: ttText(/결정일<\/span>\s*([\d.]+)/.exec(body)?.[1]),
      결정요지: truncate(ttText(gist), 500),
      dem_no: demNo,
      상세보기: link ? `${TT_BASE}${htmlUnescape(link)}` : undefined,
    };
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    if (out.dem_no || out.제목) rows.push(out);
  }
  return rows;
}

function ttParseTaxCounts(html) {
  const counts = {};
  const re =
    /clickTaxCount\('(\d+)'[\s\S]{0,200}?<span class="icon-th[^"]*">([^<]*)<\/span>\s*<b class="num">\s*([\d,]+)\s*<\/b>/g;
  let m;
  while ((m = re.exec(html))) {
    const n = Number(m[3].replace(/,/g, ""));
    if (n > 0) counts[`${ttText(m[2])}(${m[1]})`] = n;
  }
  return counts;
}

async function ttSearch({
  query,
  searchType = "keyword",
  section,
  taxType,
  decision,
  dateFrom,
  dateTo,
  sort = "relevance",
  page = 1,
  pageSize = 10,
}) {
  const params = {
    txtKeyword: query,
    taxDivs: searchType === "docnum" ? "doc" : "basic",
    collections: "out_judge",
    selectViewCnt: String(pageSize),
    startCnt: String(Math.max(0, page - 1)),
    sortCondition: TT_SORTS[sort] || TT_SORTS.relevance,
    rdSection: section || "",
    rdSemok: taxType || "",
    rdJudge: decision || "",
    txtFromDate: dateFrom || "",
    txtToDate: dateTo || "",
    searchType: "",
    listCount: "",
    dem_jomun: "",
    focusElementId: "",
  };
  const html = await ttPost(params);
  // 건수는 "5,362"처럼 천단위 콤마가 붙어 나온다.
  const totalRaw = /class="result-total">\s*([\d,]+)\s*</.exec(html)?.[1];
  const rows = ttParseRows(html);
  const out = {
    출처: "조세심판원 심판결정례 (tt.go.kr)",
    검색어: query,
    검색방식: searchType === "docnum" ? "청구번호(사건번호)" : "키워드",
    전체건수:
      totalRaw != null ? Number(totalRaw.replace(/,/g, "")) : rows.length,
    페이지: page,
    정렬: `${sort} (${TT_SORTS[sort] || TT_SORTS.relevance})`,
  };
  if (section) out.세법구분 = `${section} (${TT_SECTIONS[section] || section})`;
  if (taxType) out.세목필터 = `${taxType} (${TT_TAX_TYPES[taxType] || taxType})`;
  if (decision) out.결정유형필터 = `${decision} (${TT_DECISIONS[decision] || decision})`;
  const counts = ttParseTaxCounts(html);
  if (Object.keys(counts).length) {
    // 사이트가 돌려주는 세목별 분포는 검색어+결정유형까지만 반영한다(실측).
    out.세목별건수 = counts;
    out.세목별건수_기준 =
      "검색어·결정유형 기준 분포. 세목(tax_type)·결정기간(date_from/date_to) 필터는 반영되지 않음 — 전체건수와 다를 수 있다.";
  }
  out.목록 = rows;
  if (totalRaw == null && rows.length === 0) {
    out.비고 =
      "검색결과 영역을 찾지 못했습니다(사이트 개편 가능성). tt.go.kr 상세검색 화면에서 직접 확인하세요.";
  }
  return out;
}

/** 결정문 전문의 [항목] 구획을 잘라 객체로 만든다. */
function ttSplitSections(text) {
  const labels = [
    "청구번호",
    "사건번호",
    "세 목",
    "결정유형",
    "제 목",
    "결정요지",
    "관련법령",
    "참조결정",
    "따른결정",
    "주 문",
    "이 유",
  ];
  const alt = labels.map((l) => l.replace(/ /g, "\\s*")).join("|");
  const re = new RegExp(`\\[\\s*(${alt})\\s*\\]`, "g");
  const marks = [];
  let m;
  while ((m = re.exec(text)))
    marks.push({ name: m[1].replace(/\s+/g, ""), start: m.index, end: re.lastIndex });
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const seg = text
      .slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined)
      .replace(/^[\s\-—_]+/, "")
      .replace(/[\s\-—_]+$/, "")
      .trim();
    if (seg) out[marks[i].name] = seg;
  }
  return out;
}

async function ttGetDocument(demNo, maxChars = 60000) {
  const url = `${TT_BASE}/mUser/common/xmlViewer.do?dem_no=${encodeURIComponent(
    demNo
  )}&mode=popup&highlight=&db=s`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) throw new Error(`tt.go.kr HTTP ${res.status}`);
  const html = await res.text();
  const body = /<body[\s\S]*?>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  let text = ttBlockText(body).replace(/^xmlViewer\s*/i, "").trim();
  text = text.replace(/^[-—_]{5,}$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error(`결정문을 찾을 수 없습니다 (dem_no=${demNo})`);
  if (/문서파일이 존재하지 않|조회할 수 없/.test(text) && text.length < 200) {
    throw new Error(
      `결정문이 없습니다 (dem_no=${demNo}). tt_search 결과의 dem_no를 그대로 쓰세요. 사이트 응답: "${text}"`
    );
  }
  const sec = ttSplitSections(text);
  const truncated = text.length > maxChars;
  return {
    출처: "조세심판원 심판결정례 (tt.go.kr)",
    dem_no: String(demNo),
    청구번호: sec.청구번호 || sec.사건번호 || undefined,
    세목: sec.세목 || undefined,
    결정유형: sec.결정유형 || undefined,
    제목: sec.제목 || undefined,
    결정요지: sec.결정요지 || undefined,
    관련법령: sec.관련법령 || undefined,
    참조결정: sec.참조결정 || undefined,
    따른결정: sec.따른결정 || undefined,
    주문: sec.주문 || undefined,
    이유: truncated ? truncate(sec.이유 || "", maxChars) : sec.이유 || undefined,
    전문: truncated ? undefined : text,
    본문잘림: truncated || undefined,
    상세보기: `${TT_BASE}/mUser/dem/searchEngineDemViewPopup.do?dem_no=${encodeURIComponent(
      demNo
    )}&menuNm=demList`,
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "korea-tax-law",
  version: "1.0.0",
});

const collectionEnum = z.enum([
  "statute",
  "question",
  "precedent",
  "appendForm",
  "formerLibrary",
  "hometaxCnslThan",
]);

server.tool(
  "nts_search",
  "국세법령정보시스템(taxlaw.nts.go.kr) 통합검색. 세법 조문, 세법해석례(질의회신), 판례/심판/심사 결정례, 별표서식, 홈택스 상담사례를 검색한다. 결과의 doc_id로 nts_get_document를 호출하면 전문을 볼 수 있다.",
  {
    query: z.string().describe("검색어 (예: '1세대 1주택 비과세'). search_type=docnum이면 문서번호"),
    collections: z
      .array(collectionEnum)
      .default(["statute", "question", "precedent"])
      .describe(
        "검색 대상: statute=세법·법령, question=세법해석례(질의회신), precedent=판례·심판·심사, appendForm=별표서식, formerLibrary=기타자료, hometaxCnslThan=홈택스상담사례"
      ),
    page: z.number().int().min(1).default(1).describe("페이지 번호"),
    page_size: z.number().int().min(1).max(50).default(10).describe("컬렉션당 결과 수"),
    sort: z
      .enum(["relevance", "latest", "oldest"])
      .default("relevance")
      .describe("정렬: relevance=정확도, latest=최신순, oldest=과거순"),
    date_from: z.string().optional().describe("검색 시작일 YYYYMMDD (생산일자 기준)"),
    date_to: z.string().optional().describe("검색 종료일 YYYYMMDD"),
    search_type: z
      .enum(["keyword", "docnum"])
      .default("keyword")
      .describe("keyword=일반 키워드 검색, docnum=문서번호 검색 (예: '서면-2020-법령해석재산-1234')"),
  },
  async (args) => {
    try {
      const r = await ntsSearch({
        query: args.query,
        collections: args.collections,
        page: args.page,
        pageSize: args.page_size,
        sort: args.sort,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        searchType: args.search_type,
      });
      return jsonResult(r);
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "nts_get_document",
  "국세법령정보시스템 문서 전문 조회. nts_search 결과의 doc_id(ntstDcmId)로 세법해석례·판례 등의 제목/요지/질의/회신 전문을 가져온다.",
  {
    doc_id: z.string().describe("문서 ID (nts_search 결과의 doc_id, 예: '010000000000030445')"),
  },
  async (args) => {
    try {
      return jsonResult(await ntsGetDocument(args.doc_id));
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "law_search",
  "국가법령정보센터(open.law.go.kr) 오픈API 검색. 현행 법령, 행정규칙, 자치법규, 조약, 법원 판례, 헌재 결정례, 법령해석례, 행정심판례 등을 검색한다. 법령 상세는 결과의 법령일련번호(MST)로 law_get_detail을 호출한다.",
  {
    query: z.string().describe("검색어 (예: '소득세법', '양도소득세')"),
    target: z
      .enum(["law", "eflaw", "admrul", "ordin", "trty", "prec", "detc", "expc", "decc", "licbyl", "lstrm"])
      .default("law")
      .describe(
        "검색 대상: law=현행법령, eflaw=시행일법령, admrul=행정규칙, ordin=자치법규, trty=조약, prec=판례, detc=헌재결정례, expc=법령해석례, decc=행정심판례, licbyl=별표서식, lstrm=법령용어"
      ),
    page: z.number().int().min(1).default(1).describe("페이지 번호"),
    display: z.number().int().min(1).max(100).default(10).describe("결과 수"),
    scope: z
      .enum(["title", "body"])
      .default("title")
      .describe("title=제목(법령명) 검색, body=본문 검색"),
  },
  async (args) => {
    try {
      const r = await lawSearch({
        query: args.query,
        target: args.target,
        page: args.page,
        display: args.display,
        scope: args.scope === "body" ? 2 : 1,
      });
      return jsonResult(r);
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "law_get_detail",
  "국가법령정보센터 본문 조회. law_search 결과의 법령일련번호(MST) 또는 법령ID로 법령·판례 등의 본문을 가져온다. 법령 전문은 매우 길 수 있으므로 특정 조문만 필요하면 jo 파라미터를 사용한다.",
  {
    target: z
      .enum(["law", "eflaw", "admrul", "ordin", "trty", "prec", "detc", "expc", "decc"])
      .default("law")
      .describe("조회 대상 (law_search의 target과 동일)"),
    mst: z.string().optional().describe("법령일련번호 MST (law_search 결과의 '법령일련번호')"),
    id: z.string().optional().describe("법령ID 또는 판례일련번호 등 (MST가 없을 때 사용)"),
    jo: z
      .string()
      .optional()
      .describe("특정 조문만 조회 (법령 전용). 예: '89' = 제89조, '104의2' = 제104조의2"),
  },
  async (args) => {
    try {
      if (!args.mst && !args.id) {
        return errorResult("mst 또는 id 중 하나는 필수입니다.");
      }
      return jsonResult(await lawDetail(args));
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "tt_search",
  "조세심판원(tt.go.kr) 심판결정례 검색. 조세심판원이 국세·관세·지방세 불복(심판청구)에 대해 내린 결정례(조심·국심)를 검색한다. 국세법령정보시스템(nts_search precedent)에도 심판례가 있지만, 조세심판원 원본은 결정문 전문·주문·이유가 완전하고 세목/결정유형/결정기간 필터가 정확하다. 결과의 dem_no로 tt_get_document를 호출하면 결정문 전문을 볼 수 있다.",
  {
    query: z
      .string()
      .describe(
        "검색어(2자 이상). search_type=docnum이면 청구번호 (예: '조심2026구0212' 또는 '2026구0212')"
      ),
    search_type: z
      .enum(["keyword", "docnum"])
      .default("keyword")
      .describe("keyword=키워드 검색, docnum=청구번호(사건번호) 검색"),
    section: z
      .enum(["00", "01", "02", "03"])
      .optional()
      .describe("세법 구분: 00=전체, 01=내국세, 02=관세, 03=지방세"),
    tax_type: z
      .enum(["00", "11", "12", "20", "40", "50", "90", "96", "97", "98", "99"])
      .optional()
      .describe(
        "세목: 00=전체, 11=양도, 12=소득, 20=법인, 40=상증, 50=부가, 99=기타(이상 내국세), 90=관세, 96=취득, 97=재산, 98=지방·기타(이상 지방세)"
      ),
    decision: z
      .enum(["S500", "S501", "S502", "S503", "S504", "S507", "S599"])
      .optional()
      .describe(
        "결정유형: S500=전체, S501=취소, S502=경정, S503=기각, S504=각하, S507=재조사, S599=인용(취소·경정 등)"
      ),
    date_from: z.string().optional().describe("결정일 시작 YYYY-MM-DD"),
    date_to: z.string().optional().describe("결정일 종료 YYYY-MM-DD"),
    sort: z
      .enum(["relevance", "latest", "oldest", "title"])
      .default("relevance")
      .describe("relevance=정확도순, latest=최신순, oldest=과거순, title=제목순"),
    page: z.number().int().min(1).default(1).describe("페이지 번호"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe("페이지당 결과 수 (사이트가 지원하는 값은 10/20/30)"),
  },
  async (args) => {
    try {
      return jsonResult(
        await ttSearch({
          query: args.query,
          searchType: args.search_type,
          section: args.section,
          taxType: args.tax_type,
          decision: args.decision,
          dateFrom: args.date_from,
          dateTo: args.date_to,
          sort: args.sort,
          page: args.page,
          pageSize: args.page_size,
        })
      );
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "tt_get_document",
  "조세심판원 심판결정문 전문 조회. tt_search 결과의 dem_no로 청구번호·세목·결정유형·제목·결정요지·관련법령·참조결정·주문·이유 전문을 가져온다.",
  {
    dem_no: z
      .string()
      .describe("결정문 번호 (tt_search 결과의 dem_no, 예: '224872')"),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .default(60000)
      .describe("본문 최대 길이. 초과하면 이유 부분을 자르고 본문잘림=true로 표시"),
  },
  async (args) => {
    try {
      return jsonResult(await ttGetDocument(args.dem_no, args.max_chars));
    } catch (e) {
      return errorResult(e.message);
    }
  }
);

server.tool(
  "tax_search_all",
  "통합 세법 검색: 국세법령정보시스템(세법해석례·판례·세법), 국가법령정보센터(법령·법령해석례), 조세심판원(심판결정례)를 한 번에 검색해서 요약 결과를 반환한다. 세금 관련 질문의 첫 검색으로 적합하다.",
  {
    query: z.string().describe("검색어 (예: '상속주택 양도소득세 비과세')"),
    page_size: z.number().int().min(1).max(20).default(5).describe("출처별 결과 수"),
  },
  async (args) => {
    const [nts, law, expc, tt] = await Promise.allSettled([
      ntsSearch({
        query: args.query,
        collections: ["statute", "question", "precedent"],
        pageSize: args.page_size,
      }),
      lawSearch({ query: args.query, target: "law", display: args.page_size }),
      lawSearch({ query: args.query, target: "expc", display: args.page_size }),
      ttSearch({ query: args.query, pageSize: args.page_size }),
    ]);
    const pick = (r) =>
      r.status === "fulfilled" ? r.value : { 오류: r.reason?.message };
    return jsonResult({
      국세법령정보시스템: pick(nts),
      국가법령정보센터_법령: pick(law),
      국가법령정보센터_법령해석례: pick(expc),
      조세심판원_심판결정례: pick(tt),
    });
  }
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("korea-tax-law-mcp: MCP server running on stdio");
