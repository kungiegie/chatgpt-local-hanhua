// CodexZhLocal.js - 免梯子中文界面注入器 (OpenAI Codex / ChatGPT MSIX) v4
//
// 核心修复 (v3 → v4):
//   v3 用 dataAdapter.setData()+initializeSync() —— initializeSync 在 client 已 Ready 时是空操作,
//   且 setData 只写 in-memory cache, 不写 localStorage, 冷启动后丢失。
//
//   v4 直接调用 client._store.setValues({source,data,receivedAt,stableID,fullUserHash}, user),
//   其中 data 必须是 JSON *字符串* (SDK 内部 _typedJsonParse 只解析字符串), 值用 V1 wire format:
//     layer_configs[NAME] = { value:{...}, group_name, rule_id }   ← 不是 V2 的 {v,r,gn}+values[]
//   然后清除 _memoCache 中该 layer 的缓存键, 使公开的 getLayer() 立即返回新值。
//
//   持久化: 同时把同样的 V1 payload 写入 localStorage 的
//     statsig.cached.evaluations.<suffix>  (suffix = dataAdapter._getCacheKey(user), 精确获取)
//   格式为 {source:'Bootstrap',data:JSON.stringify(payload),receivedAt,stableID,fullUserHash:null},
//   SDK 冷启动时 _loadFromCache 会读取并恢复, 实现免梯子持久中文。
//
// 用法: node CodexZhLocal.js [cdp-port=9222]
//       (若端口未监听, 自动以 --remote-debugging-port=<port> 启动 MSIX)

const http = require("http");
const { spawn } = require("child_process");

const CDP_PORT = parseInt(process.env.CDP_PORT || process.argv[2] || "9222", 10);
const LAYER_ID = "72216192";
const LOG = (m) => console.log(new Date().toISOString().slice(11, 19), m);

// 自动探测已安装的 Codex/ChatGPT MSIX 安装路径 (不写死版本号, 兼容不同机器/版本)
const { execSync } = require("child_process");
function detectMsixRoot() {
  // 优先从环境变量读 (可由 bat 预填)
  if (process.env.CODEX_MSIX_ROOT) return process.env.CODEX_MSIX_ROOT;
  // 通过 Get-AppxPackage 查询 OpenAI.Codex 的 InstallLocation
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-AppxPackage OpenAI.Codex | Select-Object -ExpandProperty InstallLocation"',
      { encoding: "utf8", windowsHide: true }
    ).trim();
    if (out) return out;
  } catch (e) { /* fall through */ }
  throw new Error("未找到 OpenAI.Codex 安装路径。请先在朋友电脑上安装 Codex 桌面版, 或设置环境变量 CODEX_MSIX_ROOT。");
}
const MSIX_ROOT = detectMsixRoot();

function djb2(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) t = (((t << 5) - t) + s.charCodeAt(i)) & 0x7fffffff;
  return String(t >>> 0);
}

function cdpFetch(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}
async function cdpAlive(port) {
  try { await cdpFetch(port, "/json/version"); return true; } catch { return false; }
}
async function waitForCdp(port, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const list = JSON.parse(await cdpFetch(port, "/json/list"));
      if (Array.isArray(list) && list.length) return list;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`CDP 端口 ${port} 无可用目标`);
}

class Cdp {
  constructor(url){ this.url=url; this.id=0; this.waiters=new Map(); this.handlers=new Map(); }
  connect(){
    return new Promise((ok,fail)=>{
      const ws=new WebSocket(this.url); this.ws=ws;
      ws.onopen=()=>ok(this);
      ws.onerror=()=>fail(new Error("CDP websocket 连接失败"));
      ws.onmessage=(m)=>{
        const msg=JSON.parse(typeof m.data==="string"?m.data:Buffer.from(m.data).toString());
        if(msg.id!=null&&this.waiters.has(msg.id)){const w=this.waiters.get(msg.id);this.waiters.delete(msg.id);
          msg.error?w.reject(new Error(JSON.stringify(msg.error))):w.resolve(msg.result);}
        else if(msg.method){const hs=this.handlers.get(msg.method);if(hs)hs.forEach((f)=>f(msg.params,msg));}
      };
    });
  }
  send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{
    this.waiters.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));
    setTimeout(()=>{if(this.waiters.has(id)){this.waiters.delete(id);reject(new Error("CDP 超时: "+method));}},30000);
  });}
  on(method,fn){if(!this.handlers.has(method))this.handlers.set(method,[]);this.handlers.get(method).push(fn);}
  eval(expr,awaitPromise=false){return this.send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise});}
  close(){try{this.ws.close();}catch{}}
}

// 注入到页面里执行的核心逻辑 (在 renderer 上下文):
//   1. 取 __STATSIG__ 所有实例 (主 shell 通常只有 1 个)
//   2. 用 V1 wire format 的 JSON *字符串* 直接写 client._store.setValues
//      layer_configs[NAME] = { value:{...}, group_name, rule_id }   ← 重要: 不是 V2 的 {v,r,gn}
//   3. 清除 _memoCache 中该 layer 的键 (getLayer/getDynamicConfig 是 memoized 的)
//   4. 用 client.$emt("values_updated") 通知 React 重渲染
//   5. 持久化: 写 localStorage statsig.cached.evaluations.<_getCacheKey(user)> 供冷启动恢复
//   6. 报告 before/after 的 layer 值和 UI 关键词命中情况
const injectExpr = `(function(){
  var L = ${JSON.stringify(LAYER_ID)};
  function djb2(s){var t=0;for(var i=0;i<s.length;i++){t=((t<<5)-t)+s.charCodeAt(i);t&=0x7fffffff;}return String(t>>>0);}
  var out = { found: 0, patched: 0, persisted: false, before: {}, after: {}, errors: [] };

  function readLayer(c){
    var cur = c.getLayer ? c.getLayer(L) : null;
    if (!cur) return null;
    return {
      enable_i18n: cur.get ? cur.get("enable_i18n", null) : null,
      locale_source: cur.get ? cur.get("locale_source", null) : null,
      reason: cur.details ? cur.details.reason : null
    };
  }
  function uiCheck(){
    var zhUi = ["设置","新对话","定时","插件","项目","最近","书签","模型","语音","文件","关闭","取消","搜索","帮助"];
    var enUi = ["Settings","New chat","Scheduled","Plugins","Projects","Recents","Bookmarks","Model","Voice","Files","Cancel","Search","Help"];
    var text = (document.body && document.body.innerText || "");
    return {
      zhUiHits: zhUi.filter(function(w){ return text.indexOf(w) >= 0; }),
      enUiHits: enUi.filter(function(w){ return text.indexOf(w) >= 0; }),
      docLang: document.documentElement.lang
    };
  }

  try {
    var g = (typeof __STATSIG__ !== "undefined") ? __STATSIG__ : null;
    if (!g) { out.errors.push("no __STATSIG__ global"); }
    else {
      var insts = (g.instances && Object.keys(g.instances).length) ? g.instances
                 : (g.firstInstance ? { first: g.firstInstance } : null);
      if (!insts) { out.errors.push("no statsig instances"); }
      else {
        var list = [];
        Object.keys(insts).forEach(function(k){ list.push({ key: k, c: insts[k] }); });
        out.found = list.length;
        list.forEach(function(item){
          var c = item.c;
          try {
            out.before[item.key] = readLayer(c);

            // 构造 V1 payload —— layer_configs[NAME] 直接是 {value, group_name, rule_id}
            var payloadObj = {
              has_updates: true,
              time: Date.now(),
              feature_gates: {},
              dynamic_configs: {},
              layer_configs: {
                [L]: { value: { enable_i18n: true, locale_source: "SYSTEM" }, group_name: L, rule_id: "l|" + L }
              },
              param_stores: {},
              exposures: []
            };
            var payloadStr = JSON.stringify(payloadObj);

            // 直接写 store —— data 必须是 JSON 字符串, 不是对象 (否则 setValues 返回 false)
            var storeOk = false;
            if (c._store && c._store.setValues) {
              storeOk = c._store.setValues(
                { source: "Bootstrap", data: payloadStr, receivedAt: Date.now(), stableID: null, fullUserHash: null },
                c._user
              );
            } else {
              out.errors.push("client " + item.key + " has no _store.setValues");
            }
            out[item.key + "_storeOk"] = storeOk;

            // 清除该 layer 的 memo 缓存 (公开 getLayer/getDynamicConfig 是 memoized 的)
            var mc = c._memoCache || {};
            var cleared = [];
            var h = djb2(L);
            for (var k in mc) {
              if (k.indexOf(L) >= 0 || k.indexOf(h) >= 0) { delete mc[k]; cleared.push(k); }
            }
            out[item.key + "_memoCleared"] = cleared;
            if (storeOk) out.patched++;

            // 通知 React: 触发 values_updated 重渲染
            try {
              if (typeof c.$emt === "function") { c.$emt("values_updated"); out.emit = "$emt"; }
              else if (typeof c.emit === "function") { c.emit("values_updated"); out.emit = "emit"; }
            } catch (ee3) { out.errors.push("emit: " + ee3.message); }

            // 持久化到 localStorage (冷启动免梯子)
            var cacheKey = null;
            try {
              if (c.dataAdapter && c.dataAdapter._getCacheKey) {
                cacheKey = c.dataAdapter._getCacheKey(c._user);
              }
            } catch (ee) { out.errors.push("_getCacheKey: " + ee.message); }
            if (cacheKey) {
              var cacheValue = {
                source: "Bootstrap",
                data: payloadStr,
                receivedAt: Date.now(),
                stableID: null,
                fullUserHash: null
              };
              localStorage.setItem(cacheKey, JSON.stringify(cacheValue));
              try {
                var lmtKey = "statsig.last_modified_time." + (c.dataAdapter._cacheSuffix || "evaluations");
                var lmtRaw = localStorage.getItem(lmtKey);
                var lmt = lmtRaw ? JSON.parse(lmtRaw) : {};
                lmt[cacheKey] = Date.now();
                localStorage.setItem(lmtKey, JSON.stringify(lmt));
              } catch (ee2) { out.errors.push("last_modified_time: " + ee2.message); }
              out.persisted = true;
              out.persistKey = cacheKey;
            }

            out.after[item.key] = readLayer(c);
          } catch (e) { out.errors.push(item.key + ": " + e.message); }
        });
      }
    }
  } catch (e) { out.errors.push(String(e)); }

  out.ui = uiCheck();
  return JSON.stringify(out);
})();`;

async function main() {
  LOG(`CDP 端口: ${CDP_PORT}`);
  if (!(await cdpAlive(CDP_PORT))) {
    LOG(`端口未监听, 以 --remote-debugging-port=${CDP_PORT} 启动 MSIX ...`);
    const p = spawn(`${MSIX_ROOT}\\app\\ChatGPT.exe`, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
  }
  const list = await waitForCdp(CDP_PORT);
  LOG(`目标 ${list.length} 个:`);
  list.forEach((t) => LOG(`  [${t.type}] ${t.title}  ${t.url}`));
  const mainTarget =
    list.find((t) => t.type === "page" && /app:\/\/|index\.html/i.test(t.url)) ||
    list.find((t) => t.type === "page" && /chatgpt|codex/i.test(t.title)) ||
    list.find((t) => t.type === "page");
  if (!mainTarget) throw new Error("未找到 page 目标");
  LOG(`附着: ${mainTarget.title} ${mainTarget.url}`);

  const cdp = await new Cdp(mainTarget.webSocketDebuggerUrl).connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 先读当前状态 (不改动)
  const before = await cdp.eval(`(function(){
    var out = {};
    out.hasGlobal = (typeof __STATSIG__ !== "undefined");
    if (out.hasGlobal) {
      var g = __STATSIG__;
      out.instanceKeys = g.instances ? Object.keys(g.instances) : [];
      out.hasFirst = !!g.firstInstance;
      out.documentLang = document.documentElement.lang;
    }
    out.bodySample = (document.body && document.body.innerText || "").slice(0, 150);
    return JSON.stringify(out);
  })()`);
  LOG(`当前状态: ${(before.result && before.result.value) || JSON.stringify(before.result)}`);

  // 注入 + 持久化
  const r = await cdp.eval(injectExpr);
  const resStr = (r.result && r.result.value) || JSON.stringify(r.result);
  const res = JSON.parse(resStr);
  LOG(`注入结果: storedOk=${res.found ? Object.values(res).filter(v=>typeof v==="boolean").join(",") : "n/a"}`);
  LOG(`  before: ${JSON.stringify(res.before)}`);
  LOG(`  after:  ${JSON.stringify(res.after)}`);
  if (res.errors.length) LOG(`  errors: ${res.errors.join("; ")}`);
  if (res.persistKey) LOG(`  持久化缓存键: ${res.persistKey} (冷启动将自动恢复, 免梯子)`);

  if (res.patched > 0) {
    LOG("内存中已覆盖 Statsig layer, 执行 Page.reload 让 React 重新读 gate:");
    await cdp.send("Page.reload", { ignoreCache: false });
    await new Promise((rr) => setTimeout(rr, 12000));
    const v2 = await cdp.eval(`(function(){
      var L = ${JSON.stringify(LAYER_ID)};
      var out = {};
      try {
        var g = (typeof __STATSIG__ !== "undefined") ? __STATSIG__ : null;
        var c = g && ((g.instances && g.instances[Object.keys(g.instances)[0]]) || g.firstInstance);
        if (c && c.getLayer) {
          var l = c.getLayer(L);
          out.layerEnable = l ? l.get("enable_i18n", null) : null;
          out.layerLocaleSource = l ? l.get("locale_source", null) : null;
          out.layerReason = l ? l.details.reason : null;
        }
        var zhUi = ["设置","新对话","定时","插件","项目","最近","书签","模型","语音","文件","关闭","取消","搜索"];
        var enUi = ["Settings","New chat","Scheduled","Plugins","Projects","Recents","Bookmarks","Model","Voice","Files","Cancel","Search"];
        var text = (document.body && document.body.innerText || "");
        out.zhUiHits = zhUi.filter(function(w){ return text.indexOf(w) >= 0; });
        out.enUiHits = enUi.filter(function(w){ return text.indexOf(w) >= 0; });
        out.docLang = document.documentElement.lang;
      } catch(e) { out.err = String(e); }
      return JSON.stringify(out);
    })()`);
    LOG(`reload 后: ${(v2.result && v2.result.value) || JSON.stringify(v2.result)}`);
  } else {
    LOG("未找到可覆盖的 Statsig client 实例。尝试 reload + 重新注入:");
    await cdp.send("Page.reload", { ignoreCache: true });
    await new Promise((rr) => setTimeout(rr, 15000));
    const r2 = await cdp.eval(injectExpr);
    LOG(`重新注入: ${(r2.result && r2.result.value) || JSON.stringify(r2.result)}`);
  }

  cdp.close();
  LOG("完成。");
}
main().catch((e) => { LOG("错误:", e.stack || e.message || String(e)); process.exit(1); });
