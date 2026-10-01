// 出行建议生成
//
// 产品定位：用户给「地点 + 时间」，拿到该时段的天气状况，以及针对性的出行建议。
// 活动（赶海 / 登山 / 露营 / 拍照）是**可选**的：提到了建议就按该活动的关注点讲，
// 没提到就给通用建议。这里只产出文字建议，不做评分、不排序、不评优劣。

(function (global) {
  "use strict";

  const SCENES = {
    beach: { name: "赶海 · 海岛", icon: "🌊", focus: "风力与潮汐",
             tip: "出发前查一下潮汐表，退潮前 1–2 小时到海边最合适" },
    hike: { name: "登山 · 徒步", icon: "⛰️", focus: "降水与山顶大风",
            tip: "尽量上午登顶，午后山区易起雷雨" },
    camp: { name: "露营野餐", icon: "🏕️", focus: "夜间的风雨和低温",
            tip: "帐篷扎在背风处，夜里地面返潮记得垫防潮垫" },
    photo: { name: "摄影出片", icon: "📷", focus: "光线与通透度",
             tip: "日出后与日落前一小时的光线最出片" },
    citywalk: { name: "城市漫步", icon: "🚶", focus: "温度与降水",
                tip: "把户外路线排在降水最少的时段" },
  };

  // WMO 天气代码 -> 中文
  const WMO = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
    45: "有雾", 48: "雾凇",
    51: "毛毛雨", 53: "小雨", 55: "中等毛毛雨",
    56: "冻毛毛雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "阵雨", 81: "中等阵雨", 82: "强阵雨",
    85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
  };
  const weatherText = (c) => WMO[c] ?? "天气多变";

  const uvText = (u) => u == null ? null
    : u <= 2 ? "紫外线弱" : u <= 5 ? "紫外线中等" : u <= 7 ? "紫外线强" : "紫外线很强";

  const hhmm = (iso) => iso ? iso.slice(11, 16) : null;
  const round = (n) => Math.round(n);

  /* ---------- 逐日建议 ---------- */

  // 返回 1–2 条，第一条是当天最该注意的，第二条常是分时段提示
  function dayAdviceList(d, sceneKey) {
    const out = [];
    const gust = d.gust ?? d.wind;
    const feelsHi = d.feelsMax ?? d.tmax;

    if (d.precip > 20) out.push("有较强降雨，户外活动建议改期或改走室内");
    else if (d.precip > 8) out.push("有中雨，户外安排会受影响，记得带雨具");
    else if (d.precip > 3) out.push("有降雨，出门带上伞");
    else if (d.precipProb != null && d.precipProb >= 50) out.push(`降水概率 ${d.precipProb}%，备把伞更稳妥`);
    else if (d.precip > 0.3) out.push("可能有零星小雨，带把伞更稳妥");

    if (sceneKey === "beach" && d.wind > 8) out.push(`风速 ${d.wind.toFixed(1)}m/s，海边风大，出海和赶海需谨慎`);
    else if (gust > 15) out.push(`阵风可达 ${gust.toFixed(0)}m/s，注意防风`);
    else if (d.wind > 12) out.push(`风速 ${d.wind.toFixed(1)}m/s，风力较大，注意防风`);
    else if (d.wind > 9) out.push("风稍大，体感会偏凉");

    if (!out.length) {
      if (feelsHi >= 33) out.push("白天体感炎热，尽量避开正午时段外出");
      else if (feelsHi <= 5) out.push("体感很冷，注意保暖");
      else if (d.tmin <= 3) out.push("夜间接近冰点，注意保暖");
    }

    if (d.uv >= 8) out.push("紫外线很强，做好防晒");
    else if (d.uv > 5 && !out.length) out.push("紫外线偏强，注意防晒");

    if (!out.length && d.tmax - d.tmin >= 12)
      out.push(`昼夜温差 ${round(d.tmax - d.tmin)}°C，早晚记得加件外套`);

    if (!out.length)
      out.push(feelsHi >= 15 && feelsHi <= 30 ? "天气不错，适合安排出行" : "天气平稳，正常安排即可");

    // 分时段：只在"半天晴半天雨"这种有明显变化时才提
    const seg = segNote(d);
    if (seg && out.length < 2) out.push(seg);

    return out.slice(0, 2);
  }

  // 一天内的天气转折
  function segNote(d) {
    const s = d.seg;
    if (!s) return null;
    const wet = { am: s.am.p, pm: s.pm.p, night: s.night.p };
    const name = { am: "上午", pm: "下午", night: "夜间" };

    const wetSegs = Object.keys(wet).filter((k) => wet[k] > 1);
    const drySegs = Object.keys(wet).filter((k) => wet[k] <= 0.5);

    if (wetSegs.length && drySegs.length) {
      const dry = name[drySegs[0]], rainy = name[wetSegs[0]];
      return `${rainy}有雨，${dry}相对较好，户外安排可以往${dry}挪`;
    }
    if (wetSegs.length === 3) return "全天有雨，建议以室内安排为主";
    return null;
  }

  /* ---------- 整段出行建议 ---------- */

  function periodAdvice(days, sceneKey) {
    const n = days.length;
    if (!n) return [];

    const tmaxLo = Math.min(...days.map((d) => d.tmax));
    const tmaxHi = Math.max(...days.map((d) => d.tmax));
    const tminLo = Math.min(...days.map((d) => d.tmin));
    const tminHi = Math.max(...days.map((d) => d.tmin));
    const maxWind = Math.max(...days.map((d) => d.wind));
    const maxGust = Math.max(...days.map((d) => d.gust ?? 0));
    const codes = days.map((d) => d.code);
    const wet = days.filter((d) => d.precip > 1);
    const heavy = days.filter((d) => d.precip > 8);
    const maxUv = Math.max(...days.map((d) => d.uv ?? 0));

    const out = [];

    // ① 天气概况
    const span = tmaxLo === tmaxHi ? `${round(tmaxHi)}°C` : `${round(tmaxLo)}–${round(tmaxHi)}°C`;
    const nSpan = tminLo === tminHi ? `${round(tminLo)}°C` : `${round(tminLo)}–${round(tminHi)}°C`;

    // 只有某类天气确实占多数时才说"以 X 为主"，
    // 否则四天各不相同却挑第一条来概括，会明显说错
    const counts = new Map();
    codes.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
    const [topCode, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const lead = n === 1 ? weatherText(codes[0])
      : topN * 2 > n ? `以${weatherText(topCode)}为主`
      : "天气变化较多";

    let s1 = n === 1
      ? `这天${lead}，白天最高 ${span}、夜间最低 ${nSpan}。`
      : `这 ${n} 天${lead}，白天最高 ${span}，夜间最低 ${nSpan}。`;

    if (!wet.length) s1 += "全程无有效降水，";
    else if (heavy.length) s1 += `其中 ${heavy.length} 天有明显降雨（${heavy.map((d) => fmtDay(d.date)).join("、")}），`;
    else s1 += `其中 ${wet.length} 天可能有降水（${wet.map((d) => fmtDay(d.date)).join("、")}），`;

    s1 += maxWind <= 6 ? "风力平稳。" : `最大风速 ${maxWind.toFixed(1)}m/s${maxGust > 15 ? `、阵风可达 ${maxGust.toFixed(0)}m/s` : ""}。`;
    out.push(s1);

    // ② 结论
    const bad = days.filter((d) => d.precip > 8 || d.wind > 12 || (d.gust ?? 0) > 18 || d.tmax >= 35 || d.tmin <= 0);
    const good = days.filter((d) => d.precip <= 0.5 && d.wind <= 8 && d.tmax >= 12 && d.tmax <= 30);

    if (!bad.length && good.length >= Math.ceil(n / 2)) out.push("整体适合出行。");
    else if (bad.length === n) out.push("这段时间天气条件都不太理想，建议考虑调整日期。");
    else if (bad.length) out.push(`其中 ${bad.map((d) => fmtDay(d.date)).join("、")} 天气条件较差，可优先安排其他日子。`);
    else out.push("整体没有明显不利天气，正常安排即可。");

    // ③ 活动相关
    const sc = SCENES[sceneKey];
    if (sc) {
      const best = pickCalmest(days, sceneKey);
      out.push(best
        ? `针对${sc.name}，${fmtDay(best.date)} 的条件相对最好，${sc.tip}。`
        : `针对${sc.name}（重点看${sc.focus}），${sc.tip}。`);
    }

    // ④ 防晒
    if (maxUv > 5) {
      const uvDay = days.find((d) => (d.uv ?? 0) === maxUv);
      out.push(`${fmtDay(uvDay.date)} ${uvText(maxUv)}（UV ${round(maxUv)}），出门记得防晒。`);
    }

    return out;
  }


  function pickCalmest(days, sceneKey) {
    const score = (d) =>
      -(d.precip * 3)
      - d.wind * (sceneKey === "beach" ? 4 : 2)
      - Math.max(0, d.tmax - 30) * 2
      - Math.max(0, 10 - d.tmax) * 2;

    const best = [...days].sort((a, b) => score(b) - score(a))[0];
    if (!best) return null;

    const ok = best.precip <= 1
      && best.wind <= (sceneKey === "beach" ? 8 : 12)
      && best.tmax >= 5 && best.tmax <= 33;
    return ok ? best : null;
  }

  /* ---------- 携带清单 ---------- */

  // 由实际天气条件推导，不是固定清单
  function packingList(days) {
    const items = [];
    const rain = Math.max(...days.map((d) => d.precip));
    const prob = Math.max(...days.map((d) => d.precipProb ?? 0));
    const wind = Math.max(...days.map((d) => d.wind));
    const cool = Math.min(...days.map((d) => d.feelsMin ?? d.tmin));
    const hot = Math.max(...days.map((d) => d.feelsMax ?? d.tmax));
    const uv = Math.max(...days.map((d) => d.uv ?? 0));
    const gap = Math.max(...days.map((d) => d.tmax - d.tmin));

    if (rain > 1 || prob >= 40) items.push({ icon: "☂️", text: "雨伞" });
    if (rain > 8) items.push({ icon: "🥾", text: "防滑鞋" });
    if (wind > 9) items.push({ icon: "🧥", text: "防风外套" });
    if (cool <= 12 || gap >= 10) items.push({ icon: "🧣", text: "薄外套" });
    if (cool <= 3) items.push({ icon: "🧤", text: "保暖衣物" });
    if (uv > 5) items.push({ icon: "🧴", text: "防晒霜" });
    if (uv >= 8) items.push({ icon: "🕶️", text: "墨镜" });
    if (hot >= 33) items.push({ icon: "💧", text: "补水" });

    return items;
  }

  function fmtDay(iso) {
    return `${+iso.slice(5, 7)}月${+iso.slice(8, 10)}日`;
  }

  const api = { SCENES, dayAdviceList, periodAdvice, packingList, weatherText, uvText, fmtDay, hhmm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.Advice = api;
})(typeof window !== "undefined" ? window : null);