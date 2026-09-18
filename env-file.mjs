// .env 파일 해석·경로 결정.
// 규칙: 실비밀 파일은 저장소 트리 밖에 둔다. 경로 우선순위
//   1) IG_ENV_FILE / LAW_ENV_FILE 환경변수(절대경로)
//   2) %LOCALAPPDATA%\InheritanceGift\.env (기본 위치)
//   3) node --env-file=<path> 인자
//   4) (레거시) 프로젝트 루트 .env
// 파일 값이 프로세스 환경변수보다 우선한다(node --env-file 은 기존 변수를 덮어쓰지 않으므로).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.search(/\s#/);
    if (hash >= 0 && !/^['"]/.test(v)) v = v.slice(0, hash).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function envFileCandidates(argv = [...process.execArgv, ...process.argv], env = process.env, legacyRoot = null) {
  const c = [];
  if (env.IG_ENV_FILE) c.push(env.IG_ENV_FILE);
  if (env.LAW_ENV_FILE) c.push(env.LAW_ENV_FILE);
  if (env.LOCALAPPDATA) c.push(join(env.LOCALAPPDATA, "InheritanceGift", ".env"));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--env-file=")) c.push(a.slice("--env-file=".length));
    else if (a === "--env-file" && argv[i + 1]) c.push(argv[i + 1]);
  }
  if (legacyRoot) c.push(join(legacyRoot, ".env"));
  return c;
}

export function resolveEnvFile(opts = {}) {
  for (const p of envFileCandidates(opts.argv, opts.env, opts.legacyRoot)) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function loadEnvFile(opts = {}) {
  const path = resolveEnvFile(opts);
  if (!path) return { path: null, values: {} };
  try {
    return { path, values: parseEnv(readFileSync(path, "utf8")) };
  } catch {
    return { path, values: {} };
  }
}

/** 파일 값 우선으로 키를 고르고, 프로세스 값과 다르면 충돌로 표시한다(길이만, 실값 없음). */
export function pickSecret(name, fileValues, env = process.env) {
  const f = fileValues[name];
  const e = env[name];
  return { value: f || e || undefined, source: f ? "file" : e ? "env" : "none", conflict: Boolean(f && e && f !== e), fileLen: f ? f.length : 0, envLen: e ? e.length : 0 };
}
