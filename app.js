// 交互与渲染

(function () {
  "use strict";

  const { SCENES, dayAdviceList, periodAdvice, packingList,
          weatherText, uvText } = window.Advice;
  const { parsePlan, geocodeCandidates, MAX_DAYS } = window.Plan;

  const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const md = (s) => `${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;
  const wd = (s) => WEEKDAY_CN[new Date(s + "T00:00:00").getDay()];

  // 兜底路径的地名来自第三方接口，进 DOM 前必须转义
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 天气图标优先用 WMO 天气代码（比拿云量猜更准），缺值时回退到数值判断
  function glyph(d) {
    const c = d.code;
    if (c != null) {
      if (c >= 95) return "⛈️";
      if (c >= 80) return "🌦️";
      if (c >= 71 && c <= 77) return "❄️";
      if (c >= 61) return "🌧️";
      if (c >= 51) return "🌦️";
      if (c === 45 || c === 48) return "🌫️";
      if (c === 3) return "☁️";
      if (c === 2) return "⛅";
      if (c <= 1) return d.tmax >= 30 ? "☀️" : "☀️";
    }
    if (d.wind > 12) return "💨";
    if (d.tmax >= 33) return "🥵";
    if (d.tmin <= 0) return "❄️";
    return "⛅";
  }


  /* ---------------- 实时解析预览 ---------------- */

  // 一边打字一边把理解结果显示出来，让规则解析过程可见、可纠正
  function updateReadout() {
    const el = $("readout");
    const text = $("q").value.trim();
    if (!text) { el.innerHTML = ""; return; }

    const plan = parsePlan(text);
    const out = [];

    if (plan.city) {
      out.push(`<span class="ro">📍 <b>${esc(plan.city.label)}</b> · ${esc(plan.city.prov)}</span>`);
    } else if (plan.candidates.length) {
      out.push(`<span class="ro warn">📍 待定位 <b>${esc(plan.candidates[0])}</b></span>`);
    } else {
      out.push(`<span class="ro-hint">还没识别出目的地</span>`);
    }

    out.push(plan.range
      ? `<span class="ro">📅 <b>${rangeText(plan.range)}</b></span>`
      : `<span class="ro-hint">未提日期 · 默认看未来 7 天</span>`);

    // 活动没提到就不显示，避免暗示"必须选一个活动"
    if (plan.scene) {
      const sc = SCENES[plan.scene];
      out.push(`<span class="ro">${sc.icon} <b>${sc.name}</b></span>`);
    }

    el.innerHTML = out.join("");
  }

  const rangeText = (r) => r.label || (r.start === r.end ? md(r.start) : `${md(r.start)}–${md(r.end)}`);

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 132), 320)}px`;
  }

  /* ---------------- 数据 ---------------- */

  async function fetchDaily(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,` +
      `apparent_temperature_max,apparent_temperature_min,precipitation_sum,` +
      `precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,` +
      `uv_index_max,sunrise,sunset` +
      `&hourly=temperature_2m,precipitation,weather_code&wind_speed_unit=ms` +
      `&forecast_days=${MAX_DAYS}&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("气象服务暂时不可用，请稍后重试");
    const j = await res.json();
    const d = j.daily || {}, h = j.hourly || {};
    if (!d.time) throw new Error("气象服务返回数据异常");

    const times = h.time || [], hTemp = h.temperature_2m || [], hPrec = h.precipitation || [];

    // 小时数据切成 上午/下午/晚上 三段，用来判断"一天里什么时候变天"
    const segOf = (hh) => (hh < 12 ? "am" : hh < 18 ? "pm" : "night");
    const buckets = new Map();

    return d.time.map((date, i) => {
      const tmax = d.temperature_2m_max[i], tmin = d.temperature_2m_min[i];
      // 预报末端可能缺值，缺就整日丢弃
      if (tmax == null || tmin == null) return null;

      const seg = { am: { p: 0, t: [] }, pm: { p: 0, t: [] }, night: { p: 0, t: [] } };
      for (let k = 0; k < times.length; k++) {
        if (!times[k].startsWith(date)) continue;
        const v = hTemp[k];
        if (v == null) continue;
        const s = seg[segOf(+times[k].slice(11, 13))];
        s.t.push(v);
        if (hPrec[k] != null) s.p += hPrec[k];
      }
      const segSum = (s) => ({ p: s.p, tmax: s.t.length ? Math.max(...s.t) : null,
                               tmin: s.t.length ? Math.min(...s.t) : null });

      return {
        date,
        code: d.weather_code[i],
        tmax, tmin,
        feelsMax: d.apparent_temperature_max[i],
        feelsMin: d.apparent_temperature_min[i],
        precip: d.precipitation_sum[i] ?? 0,
        precipProb: d.precipitation_probability_max[i],
        wind: d.wind_speed_10m_max[i] ?? 0,
        gust: d.wind_gusts_10m_max[i],
        uv: d.uv_index_max[i],
        sunrise: d.sunrise[i],
        sunset: d.sunset[i],
        seg: { am: segSum(seg.am), pm: segSum(seg.pm), night: segSum(seg.night) },
      };
    }).filter(Boolean);
  }

  /* ---------------- 渲染 ---------------- */

  function render(days, sceneKey) {
    const sc = SCENES[sceneKey];

    const rows = days.map((d, i) => {
      const tips = dayAdviceList(d, sceneKey);
      const bits = [
        weatherText(d.code),
        d.precipProb != null && d.precipProb >= 20 ? `降水概率 ${d.precipProb}%` : null,
        `风 ${d.wind.toFixed(1)}m/s`,
        uvText(d.uv),
      ].filter(Boolean);

      return `
      <article class="day" style="animation-delay:${i * 45}ms">
        <div class="day-top">
          <div class="day-glyph">${glyph(d)}</div>
          <div class="day-when">
            <div class="day-date">${md(d.date)} <span>${wd(d.date)}</span></div>
            <div class="day-wx">白天 <b>${Math.round(d.tmax)}°</b> · 夜间 <b>${Math.round(d.tmin)}°</b></div>
          </div>
        </div>
        <div class="day-facts">${bits.join(" · ")}</div>
        <ul class="day-advice">
          ${tips.map((t) => `<li>${t}</li>`).join("")}
        </ul>
      </article>`;
    }).join("");

    const paras = periodAdvice(days, sceneKey).map((p) => `<p>${p}</p>`).join("");

    const pack = packingList(days);
    const packHtml = pack.length
      ? `<div class="sec-head">🎒 建议携带</div>
         <div class="pack">${pack.map((p) => `<span>${p.icon} ${p.text}</span>`).join("")}</div>`
      : "";

    // 追问：点一下就用对应活动的视角重新给建议
    const asked = new Set([sceneKey]);
    const followUps = [["photo", "适合拍照吗"], ["camp", "想露营"], ["hike", "去爬山"], ["beach", "去海边"]]
      .filter(([k]) => !asked.has(k));

    const followHtml = `
      <div class="sec-head">还可以问</div>
      <div class="follow" data-follow>
        ${followUps.map(([k, label]) => `<button type="button" data-q="${label}">${SCENES[k].icon} ${label}</button>`).join("")}
      </div>`;

    $("result").innerHTML = `
      <div class="sec-head">☁️ 气象简报</div>
      <div class="days">${rows}</div>
      <div class="sec-head">💡 出行建议</div>
      <div class="advice">${paras}</div>
      ${packHtml}
      ${followHtml}
      <p class="foot-note">数据来源 Open-Meteo · 建议仅供参考${sc ? ` · 已按「${sc.name}」给出针对性提示` : ""}</p>`;

    $("result").hidden = false;

    // 追问按钮：把标签拼回输入框重新跑一遍
    $("result").querySelector("[data-follow]").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-q]");
      if (!b) return;
      const prev = $("q").value.replace(/[，,]\s*(适合拍照吗|想露营|去爬山|去海边)\s*$/g, "");
      $("q").value = `${prev}，${b.dataset.q}`;
      updateReadout();
      run();
    });
  }

  /* ---------------- 主流程 ---------------- */

  function showError(msg) {
    const err = $("err");
    err.textContent = msg;
    err.hidden = false;
    $("result").hidden = true;
  }

  async function run() {
    $("err").hidden = true;

    const text = $("q").value.trim();
    if (!text) { showError("先说说你的出行计划吧"); $("q").focus(); return; }

    const btn = $("go");
    btn.disabled = true;
    $("result").innerHTML = `<div class="skeleton"><i></i>正在理解你的计划…</div>`;
    $("result").hidden = false;

    try {
      const plan = parsePlan(text);

      // 目的地：内置清单命中直接用（坐标已按省份校验），否则回退到地名库
      let city = plan.city;
      let viaFallback = false;
      if (!city) {
        $("result").innerHTML = `<div class="skeleton"><i></i>正在定位目的地…</div>`;
        city = await geocodeCandidates(plan.candidates);
        viaFallback = true;
      }
      if (!city) {
        showError("没能识别出目的地。把地名写完整些再试试，比如「连云港」「玉龙雪山」。");
        return;
      }

      const t = today();
      const range = plan.range || {
        start: ymd(t), end: ymd(addDays(t, 6)), label: "未来 7 天（未提及时间）",
      };

      $("result").innerHTML = `<div class="skeleton"><i></i>正在调取 ${esc(city.label)} 的气象数据…</div>`;

      const daily = await fetchDaily(city.lat, city.lon);
      if (!daily.length) throw new Error("气象数据为空，请稍后重试");

      const lo = daily[0].date, hi = daily[daily.length - 1].date;
      const start = range.start > lo ? range.start : lo;
      const end = range.end < hi ? range.end : hi;
      if (start > end) throw new Error(`这个日期超出预报范围了，目前只能查 ${md(lo)}–${md(hi)}`);

      const picked = daily.filter((d) => d.date >= start && d.date <= end);
      if (!picked.length) throw new Error("所选日期没有可用数据");

      render(picked, plan.scene);

      const clipped = start !== range.start || end !== range.end;
      const timeLabel = range.label || `${md(start)}–${md(end)}`;
      const sc = SCENES[plan.scene];
      $("sm-main").innerHTML = `${esc(city.label)}<em>${timeLabel}（${picked.length}天）` +
        `${sc ? ` · ${sc.icon} ${sc.name}` : ""}` +
        `${clipped ? " · 已按预报范围截取" : ""}${viaFallback ? " · 地名库匹配" : ""}</em>`;

      $("summary").hidden = false;
      $("ask").hidden = true;
      $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      $("result").hidden = true;
      showError(e.message || "分析失败，请稍后重试");
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 启动 ---------------- */

  const q = $("q");

  q.addEventListener("input", () => { updateReadout(); autoGrow(q); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); run(); }
  });
  $("go").addEventListener("click", run);

  document.querySelector(".examples").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]");
    if (!b) return;
    q.value = b.dataset.q;
    updateReadout();
    autoGrow(q);
    run();
  });

  $("sm-edit").addEventListener("click", () => {
    $("ask").hidden = false;
    $("summary").hidden = true;
    $("result").hidden = true;
    $("result").innerHTML = "";
    q.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();