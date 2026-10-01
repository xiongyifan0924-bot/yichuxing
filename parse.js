// 把自然语言出行计划解析成结构化参数：地点 / 日期区间 / 活动场景
// 无后端无模型，全部用规则解析，保证离线可用且行为可预测。

(function (global) {
  "use strict";

  const MAX_DAYS = 16;

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const toNum = (s) => (/^\d+$/.test(s) ? +s : CN_NUM[s] || null);

  /* ---------- 地点 ---------- */

  // 与内置目的地做最长匹配。展示名优先于城市名：
  // 「丽江」应命中 label=丽江，而不是 label=玉龙雪山(city 也是丽江) 那条。
  function matchCity(text) {
    let best = null;
    for (const c of global.CITIES) {
      let score = -1, hit = null;
      if (text.includes(c.label)) { score = c.label.length * 2 + 10; hit = c.label; }
      else if (text.includes(c.city)) { score = c.city.length * 2; hit = c.city; }
      if (score >= 0 && (!best || score > best.score)) best = { city: c, hit, score };
    }
    return best;
  }

  // 未命中内置清单时，从文本里捞出可能是地名的中文片段
  const NOISE = /(想去|要去|打算去|准备去|去|到|在|从|玩|旅游|旅行|游玩|怎么样|如何|怎样|天气|气候|计划|打算|准备|出差|度假|周末|国庆|十一|五一|放假|假期|这|那|的|了|吗|呢|吧|啊|附近|周边|一带|左右|时候|期间|赶海|看海|出海|潜水|冲浪|露营|野餐|烧烤|爬山|登山|徒步|登顶|拍照|摄影|出片|漫步|逛逛|逛|打卡|美食|探店|几天|三天|两天|一天|自驾|高铁|飞机)/g;

  function candidatePlaces(text) {
    const cleaned = text
      .replace(/[0-9]+\s*[月.\/-]\s*[0-9]*\s*[日号]?/g, " ")
      .replace(/[0-9]+/g, " ")
      .replace(NOISE, " ");
    return (cleaned.match(/[一-龥]{2,}/g) || []).sort((a, b) => b.length - a.length);
  }

  /* ---------- 日期 ---------- */

  function parseDates(text) {
    const t = today(), y = t.getFullYear();

    if (/国庆|十一/.test(text)) {
      return { start: `${y}-10-01`, end: `${y}-10-07`, label: "国庆假期" };
    }
    if (/周末/.test(text)) {
      const dow = t.getDay();
      const toSat = (6 - dow + 7) % 7 || 7;
      const sat = addDays(t, toSat);
      return { start: ymd(sat), end: ymd(addDays(sat, 1)), label: "本周末" };
    }

    let m = text.match(/(?:未来|接下来|后面|最近)\s*([一二两三四五六七八九十\d]+)\s*天/);
    if (m) {
      const n = toNum(m[1]);
      if (n) return { start: ymd(t), end: ymd(addDays(t, n - 1)), label: `未来 ${n} 天` };
    }

    // 区间：10.3-10.6 / 10月3日到6日 / 10/3~10/6
    m = text.match(/(\d{1,2})\s*[月.\/-]\s*(\d{1,2})\s*[日号]?\s*[-~—－到至]\s*(?:(\d{1,2})\s*[月.\/-]\s*)?(\d{1,2})\s*[日号]?/);
    if (m) {
      const sm = +m[1], sd = +m[2], em = m[3] ? +m[3] : sm, ed = +m[4];
      const year = sm < t.getMonth() + 1 ? y + 1 : y;   // 该月份已过则视为明年
      const s = new Date(year, sm - 1, sd), e = new Date(year, em - 1, ed);
      if (!isNaN(s) && !isNaN(e) && e >= s) return { start: ymd(s), end: ymd(e), label: null };
    }

    // 单日：10月3日 / 10.3
    m = text.match(/(\d{1,2})\s*[月.\/-]\s*(\d{1,2})\s*[日号]?/);
    if (m) {
      const mo = +m[1], dy = +m[2];
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        const year = mo < t.getMonth() + 1 ? y + 1 : y;
        const d = new Date(year, mo - 1, dy);
        return { start: ymd(d), end: ymd(d), label: null };
      }
    }

    return null;
  }

  /* ---------- 场景 ---------- */

  // 顺序有意义：先匹配特征更强的场景，避免"海边露营"被误判。
  // 没提到活动就返回 null —— 活动是可选的，没提到时给通用建议。
  const SCENE_WORDS = [
    ["camp", /露营|野餐|搭帐篷|帐篷|野炊|烧烤/],
    ["beach", /赶海|看海|海边|海岛|沙滩|出海|潜水|冲浪|捡贝壳|玩水/],
    ["hike", /爬|登山|徒步|登顶|越野|穿越|山野|红叶/],
    ["photo", /拍照|摄影|出片|写真|拍片|机位/],
    ["citywalk", /漫步|逛街|citywalk|逛|打卡|美食|探店|博物馆|古镇|夜市|咖啡/],
  ];

  function parseScene(text) {
    for (const [key, re] of SCENE_WORDS) {
      if (re.test(text)) return key;
    }
    return null;
  }

  /* ---------- 主入口 ---------- */

  function parsePlan(text) {
    const raw = (text || "").trim();
    const loc = matchCity(raw);

    // 命中片段剔除后再判场景，避免"上海"被当成海边
    const rest = loc ? raw.replace(loc.hit, " ") : raw;

    return {
      raw,
      city: loc ? loc.city : null,
      cityHit: loc ? loc.hit : null,
      candidates: loc ? [] : candidatePlaces(raw),
      range: parseDates(raw),
      scene: parseScene(rest),
    };
  }

  /* ---------- 兜底地理编码 ---------- */

  // 内置清单未命中时才走这里。
  // 实测「厦门」查不到但「厦门市」能查到，「洛阳」会命中福建的同名村而「洛阳市」才对，
  // 所以两种写法都试，并且只接受中国境内的结果。
  async function geocodeCandidates(candidates) {
    for (const name of candidates.slice(0, 4)) {
      for (const q of [name, name + "市"]) {
        try {
          const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const hits = (await res.json()).results || [];
          const cn = hits.filter((h) => h.country_code === "CN");
          const exact = cn.find((h) => h.name === name || h.name === name + "市");
          const pick = exact || cn[0];
          if (pick) {
            return {
              label: name, city: name,
              prov: pick.admin1 || pick.admin2 || "中国",
              py: "", lat: pick.latitude, lon: pick.longitude,
            };
          }
        } catch (e) { /* 换下一个候选继续试 */ }
      }
    }
    return null;
  }

  const api = { parsePlan, geocodeCandidates, MAX_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.Plan = api;
})(typeof window !== "undefined" ? window : null);