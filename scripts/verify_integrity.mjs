// scripts/verify_integrity.mjs
/**
 * 🛡️ WMS 5대 전주기 자동 검증 게이트 (Zero-Defect Verification Lifecycle)
 * 1. 전체 HTML <script> 및 JS 파일 구문 오류(Syntax Error) 전수 검사
 * 2. 인라인 이벤트 핸들러(정적 태그 및 동적 템플릿 리터럴) 유령 함수(Missing Functions) 검출
 * 3. Supabase Adapter 서버 브릿지 미구현 메서드 검출
 * 4. 동일 스코프 내 최상위 함수 중복 선언(Silent Shadowing) 검출
 * 5. 결함 발생 시 즉각 빌드 차단(Exit Code 1)
 */
import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';

const projectRoot = process.cwd();

const htmlFiles = ['index.html', 'searchmodify.html', 'product-ledger.html'];
const jsFiles = [
  'src/wms-entry.js',
  'src/features/nodeManagement.js',
  'src/lib/supabaseAdapter.js',
  'src/lib/supabase.js',
  'src/lib/stockSync.js',
  'api/ai-query.js',
  'api/ocr.js'
];

// 브라우저 기본 전역 함수 및 DOM API
const BROWSER_BUILTINS = new Set([
  'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'btoa', 'atob',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Function', 'Date', 'RegExp', 'Error',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'JSON', 'Math', 'console',
  'document', 'window', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'Event', 'CustomEvent', 'FileReader', 'Blob', 'FormData', 'URL', 'URLSearchParams',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'Audio', 'Image',
  'dispatchEvent', 'addEventListener', 'removeEventListener', 'postMessage', 'focus', 'blur', 'close', 'open',
  'scrollTo', 'scrollBy', 'getComputedStyle', 'matchMedia', 'structuredClone', 'queueMicrotask',
  'escape', 'unescape', 'eval', 'Infinity', 'NaN', 'undefined', 'crypto', 'event', 'this',
  'FlexSearch', 'XLSX', 'Cropper', 'rgba', 'print'
]);

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visitor);
    return;
  }
  visitor(node);
  for (const key of Object.keys(node)) {
    if (['loc', 'range', 'comments'].includes(key)) continue;
    walkAst(node[key], visitor);
  }
}

const definedFunctions = new Map(); // fnName -> [{ file, line }]
const serverMethods = new Map();    // fnName -> line
const bridgeCalls = new Map();      // fnName -> [{ file, line }]
const inlineEventCalls = [];        // { file, line, fnName, eventType, fullAttr }
const syntaxErrors = [];

// scopeKey(파일 자체, 또는 '파일::module') -> Map(fnName -> [{ file, line }])
// 같은 scopeKey 안에서 이름이 2번 이상 나오면 "나중 선언이 이전 선언을 조용히 덮어쓰는" 회귀 위험이다.
// HTML 페이지별(index/searchmodify/product-ledger)로는 각자 독립된 window 스코프(별도 iframe)라
// 파일을 넘나드는 비교는 하지 않고, 같은 파일(또는 같은 모듈) 안의 최상위 function 선언만 비교한다.
const topLevelDecls = new Map();

function collectTopLevelFunctionDecls(ast, filename, lineOffset, isModule) {
  const scopeKey = isModule ? `${filename}::module` : filename;
  if (!topLevelDecls.has(scopeKey)) topLevelDecls.set(scopeKey, new Map());
  const scopeMap = topLevelDecls.get(scopeKey);
  const body = ast.program?.body || [];
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      const name = stmt.id.name;
      const line = (stmt.loc?.start.line || 0) + lineOffset;
      if (!scopeMap.has(name)) scopeMap.set(name, []);
      scopeMap.get(name).push({ file: filename, line });
    }
  }
}

function checkSyntaxAndCollect(code, filename, lineOffset = 0, isModule = false) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: isModule ? 'module' : 'unambiguous',
      plugins: ['jsx', 'typescript']
    });
  } catch (err) {
    const errLine = (err.loc?.line || 0) + lineOffset;
    syntaxErrors.push({ file: filename, line: errLine, message: err.message });
    return;
  }

  collectTopLevelFunctionDecls(ast, filename, lineOffset, isModule);

  walkAst(ast, (node) => {
    // 1. 함수 선언식
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      const name = node.id.name;
      const line = (node.loc?.start.line || 0) + lineOffset;
      if (!definedFunctions.has(name)) definedFunctions.set(name, []);
      definedFunctions.get(name).push({ file: filename, line });
    }
    // 2. 변수 할당 함수
    if (node.type === 'VariableDeclarator' && node.id?.name) {
      const line = (node.loc?.start.line || 0) + lineOffset;
      if (node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')) {
        if (!definedFunctions.has(node.id.name)) definedFunctions.set(node.id.name, []);
        definedFunctions.get(node.id.name).push({ file: filename, line });
      }
    }
    // 3. window.xxx = ...
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      const obj = node.left.object;
      const prop = node.left.property;
      if (obj.type === 'Identifier' && (obj.name === 'window' || obj.name === 'self') && prop?.name) {
        const line = (node.loc?.start.line || 0) + lineOffset;
        if (!definedFunctions.has(prop.name)) definedFunctions.set(prop.name, []);
        definedFunctions.get(prop.name).push({ file: filename, line });
      }
    }
    // 4. 어댑터 serverMethods
    if (filename.includes('supabaseAdapter.js') && (node.type === 'ObjectProperty' || node.type === 'ObjectMethod')) {
      const key = node.key?.name || node.key?.value;
      if (key) serverMethods.set(key, (node.loc?.start.line || 0) + lineOffset);
    }
    // 5. 템플릿 리터럴 내부 인라인 이벤트
    if (node.type === 'StringLiteral') {
      scanInlineEvents(node.value, filename, (node.loc?.start.line || 0) + lineOffset, 'template');
    }
    if (node.type === 'TemplateLiteral') {
      for (const q of node.quasis) {
        scanInlineEvents(q.value.raw, filename, (q.loc?.start.line || 0) + lineOffset, 'template');
      }
    }
    // 6. callServer 및 google.script.run 호출 수집
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && node.callee.name === 'callServer' && node.arguments.length > 0) {
        const arg0 = node.arguments[0];
        if (arg0.type === 'StringLiteral') {
          const fnName = arg0.value;
          if (!bridgeCalls.has(fnName)) bridgeCalls.set(fnName, []);
          bridgeCalls.get(fnName).push({ file: filename, line: (node.loc?.start.line || 0) + lineOffset });
        }
      }
      if (node.callee.type === 'MemberExpression') {
        const prop = node.callee.property?.name;
        let curr = node.callee.object;
        let isGScript = false;
        while (curr) {
          if (curr.type === 'MemberExpression' && curr.property?.name === 'run') {
            let deep = curr.object;
            if (deep?.type === 'MemberExpression' && deep.property?.name === 'script' && deep.object?.name === 'google') {
              isGScript = true;
              break;
            }
          }
          if (curr.type === 'CallExpression') curr = curr.callee;
          else if (curr.type === 'MemberExpression') curr = curr.object;
          else break;
        }
        if (isGScript && prop && !['withSuccessHandler', 'withFailureHandler', 'withUserObject'].includes(prop)) {
          if (!bridgeCalls.has(prop)) bridgeCalls.set(prop, []);
          bridgeCalls.get(prop).push({ file: filename, line: (node.loc?.start.line || 0) + lineOffset });
        }
      }
    }
  });
}

function scanInlineEvents(str, file, line, source) {
  if (!str || typeof str !== 'string' || !str.includes('on')) return;
  const regex = /\b(on[a-z]{3,15})\s*=\s*(?:["']|\\+["'])([^"'\\]+)(?:["']|\\+["'])/gi;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const eventType = match[1];
    const code = match[2];
    
    // 점 앞의 메서드 호출(e.g., this.select(), event.stopPropagation())은 제외
    const fnRegex = /([a-zA-Z0-9_$]+)\s*\(/g;
    let m;
    while ((m = fnRegex.exec(code)) !== null) {
      const idx = m.index;
      if (idx > 0 && code[idx - 1] === '.') {
        // obj.method() 형태: 앞에 window. 가 있는 경우만 전역 함수 호출로 인정
        const before = code.substring(0, idx - 1).trim();
        if (before.endsWith('window') || before.endsWith('self')) {
          const fn = m[1];
          if (!BROWSER_BUILTINS.has(fn)) {
            inlineEventCalls.push({ file, line, fnName: fn, eventType, fullAttr: code, source });
          }
        }
        continue;
      }
      const fn = m[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(fn) && !BROWSER_BUILTINS.has(fn)) {
        inlineEventCalls.push({ file, line, fnName: fn, eventType, fullAttr: code, source });
      }
    }
  }
}

// 1. JS 파일 검사
for (const f of jsFiles) {
  const full = path.join(projectRoot, f);
  if (fs.existsSync(full)) {
    checkSyntaxAndCollect(fs.readFileSync(full, 'utf8'), f, 0, true);
  }
}

// 2. HTML 파일 검사
for (const f of htmlFiles) {
  const full = path.join(projectRoot, f);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');

  // 스크립트 블록
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(content)) !== null) {
    if (match[1].includes('src=')) continue;
    const lineOffset = content.substring(0, match.index).split('\n').length;
    checkSyntaxAndCollect(match[2], f, lineOffset, match[1].includes('module'));
  }

  // HTML 태그 내 이벤트 속성
  const tagEventRegex = /<[a-zA-Z0-9_-]+[^>]*?\s(on[a-z]{3,15})\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagEventRegex.exec(content)) !== null) {
    const eventType = tagMatch[1];
    const code = tagMatch[2] !== undefined ? tagMatch[2] : tagMatch[3];
    const line = content.substring(0, tagMatch.index).split('\n').length;
    scanInlineEvents(`${eventType}="${code}"`, f, line, 'html');
  }
}

// 검증 단계
let failed = false;

console.log('================================================================');
console.log('🛡️ [WMS 자동 검증 게이트] 4대 전주기 무결성 검증 시작...');
console.log('================================================================');

// 1) Syntax Errors
if (syntaxErrors.length > 0) {
  console.error(`🚨 [치명적] 자바스크립트 구문 오류(Syntax Error) ${syntaxErrors.length}건 발견!`);
  syntaxErrors.forEach(e => console.error(`   ❌ [${e.file}:${e.line}] ${e.message}`));
  failed = true;
} else {
  console.log('✅ 1. 모든 HTML/JS 파일 구문 오류(Syntax Error) 검사 통과 (0 errors)');
}

// 2) Missing Bridge Methods
const missingBridge = [];
for (const [fnName, list] of bridgeCalls.entries()) {
  if (!serverMethods.has(fnName)) {
    missingBridge.push({ fnName, list });
  }
}
if (missingBridge.length > 0) {
  console.error(`🚨 [치명적] 백엔드 어댑터 미구현 브릿지 메서드 ${missingBridge.length}건 발견!`);
  missingBridge.forEach(m => {
    console.error(`   ❌ 메서드 [${m.fnName}] 부재! 호출 위치:`);
    m.list.forEach(c => console.error(`      - ${c.file}:${c.line}`));
  });
  failed = true;
} else {
  console.log(`✅ 2. 백엔드 브릿지 메서드 매핑 검사 통과 (총 ${bridgeCalls.size}개 호출 100% 매핑)`);
}

// 3) Missing Inline Event Functions (Ghost Functions)
const ghostFunctions = [];
for (const item of inlineEventCalls) {
  if (BROWSER_BUILTINS.has(item.fnName)) continue;
  // 파일 내 정의 확인
  const defs = definedFunctions.get(item.fnName);
  if (!defs || defs.length === 0) {
    ghostFunctions.push(item);
  }
}

if (ghostFunctions.length > 0) {
  console.error(`🚨 [치명적] HTML 이벤트에서 호출하는 미정의 유령 함수 ${ghostFunctions.length}건 발견!`);
  ghostFunctions.forEach(g => {
    console.error(`   ❌ 유령 함수 [${g.fnName}] in [${g.file}:${g.line}] (${g.eventType}="${g.fullAttr}")`);
  });
  failed = true;
} else {
  console.log(`✅ 3. HTML/템플릿 인라인 이벤트 유령 함수 검사 통과 (총 ${inlineEventCalls.length}회 호출 정상 확인)`);
}

// 4) Duplicate Top-Level Function Declarations (Silent Shadowing)
const duplicateDecls = [];
let totalTopLevelFns = 0;
for (const [scopeKey, scopeMap] of topLevelDecls.entries()) {
  for (const [name, occurrences] of scopeMap.entries()) {
    totalTopLevelFns += 1;
    if (occurrences.length > 1) {
      duplicateDecls.push({ scopeKey, name, occurrences });
    }
  }
}

if (duplicateDecls.length > 0) {
  console.error(`🚨 [치명적] 동일 스코프 내 함수 중복 선언 ${duplicateDecls.length}건 발견! (나중 선언이 이전 선언을 조용히 덮어씁니다)`);
  duplicateDecls.forEach(d => {
    console.error(`   ❌ 함수 [${d.name}]이(가) [${d.scopeKey}] 안에서 ${d.occurrences.length}번 선언됨:`);
    d.occurrences.forEach(o => console.error(`      - ${o.file}:${o.line}`));
  });
  failed = true;
} else {
  console.log(`✅ 4. 동일 스코프 내 함수 중복 선언 검사 통과 (총 ${totalTopLevelFns}개 최상위 함수 고유성 확인)`);
}

console.log('================================================================');
if (failed) {
  console.error('❌ 무결성 검증 실패! 위의 결함을 즉시 수정한 후 다시 시도하십시오.');
  process.exit(1);
} else {
  console.log('🎉 [WMS Verification] 4대 전주기 무결성 검증 100% 통과! 현장 배포 준비 완료.');
  process.exit(0);
}
