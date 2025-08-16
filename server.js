// server.js — Super VIP Predictor (fixed full version)

const express = require("express");
const axios = require("axios");
const cors = require("cors");

// Constants for the server configuration
const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://fullsrc-daynesun.onrender.com/api/taixiu/history";

// Initialize the Express application
const app = express();
app.use(cors());
app.use(express.json());

// ---------------------- UTILITIES SECTION ----------------------

function normResult(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["t", "tai", "tài"].includes(s)) return "T";
  if (["x", "xiu", "xỉu"].includes(s)) return "X";
  return null;
}

function lastN(arr, n) {
  if (!Array.isArray(arr)) return [];
  if (n <= 0) return [];
  return arr.slice(-n);
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0);
}

function streakOfEnd(arr) {
  if (!arr || !arr.length) return 0;
  const last = arr[arr.length - 1];
  let s = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i] === last) s++;
    else break;
  }
  return s;
}

function entropy(arr) {
  if (!arr || !arr.length) return 0;
  const pT = arr.filter(r => r === "T").length / arr.length;
  const pX = 1 - pT;
  return - (pT * Math.log2(pT + 1e-10) + pX * Math.log2(pX + 1e-10));
}

function autocorr(arr, lag = 1) {
  if (!arr || arr.length < lag + 1) return 0;
  const mean = avg(arr);
  const var_ = sum(arr.map(v => (v - mean) ** 2)) / arr.length;
  if (var_ === 0) return 0;
  let cov = 0;
  for (let i = lag; i < arr.length; i++) {
    cov += (arr[i] - mean) * (arr[i - lag] - mean);
  }
  return cov / (arr.length - lag) / var_;
}

function switchRate(arr) {
  if (!arr || arr.length < 2) return 0.5;
  let sw = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== arr[i - 1]) sw++;
  }
  return sw / (arr.length - 1);
}

function variance(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = avg(arr);
  return sum(arr.map(v => (v - mean) ** 2)) / (arr.length - 1);
}

function stdDev(arr) {
  return Math.sqrt(variance(arr));
}

function zScoreLast(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = avg(arr);
  const sd = stdDev(arr);
  if (sd === 0) return 0;
  return (arr[arr.length - 1] - mean) / sd;
}

function isTrendingUp(arr, window = 5) {
  const sub = lastN(arr, window);
  if (sub.length < 2) return false;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i] <= sub[i - 1]) return false;
  }
  return true;
}

function isTrendingDown(arr, window = 5) {
  const sub = lastN(arr, window);
  if (sub.length < 2) return false;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i] >= sub[i - 1]) return false;
  }
  return true;
}

function countPattern(seq, pattern) {
  if (!seq || !pattern) return 0;
  let count = 0;
  for (let i = 0; i <= seq.length - pattern.length; i++) {
    if (seq.slice(i, i + pattern.length).join('') === pattern) count++;
  }
  return count;
}

// ---------------------- LAYER 0: LOAD & SHAPE ----------------------

function shapeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r) =>
        r &&
        r.Phien != null &&
        r.Xuc_xac_1 != null &&
        r.Xuc_xac_2 != null &&
        r.Xuc_xac_3 != null &&
        r.Tong != null &&
        r.Ket_qua != null
    )
    .map((r) => ({
      phien: Number(r.Phien),
      dice: [Number(r.Xuc_xac_1), Number(r.Xuc_xac_2), Number(r.Xuc_xac_3)],
      tong: Number(r.Tong),
      ket_qua: normResult(r.Ket_qua),
      raw: r,
    }))
    .filter((r) => r.ket_qua === "T" || r.ket_qua === "X")
    .sort((a, b) => a.phien - b.phien);
}

// ---------------------- LAYER 1: RULES (Heuristic) ----------------------

function rulesPrediction(hist) {
  const results = hist.map((h) => h.ket_qua);
  const totals = hist.map((h) => h.tong);
  const dices = hist.map((h) => h.dice);
  const last = results[results.length - 1];
  const last3 = lastN(results, 3);
  const last5 = lastN(results, 5);
  const last10 = lastN(results, 10);
  const last5total = lastN(totals, 5);
  const last10total = lastN(totals, 10);
  const last10dices = lastN(dices, 10);

  let explain = [];
  let score = { T: 0, X: 0 };

  if (last10.filter((r) => r === "T").length >= 7) {
    score.T += 5;
    explain.push("10 phiên gần nhất nghiêng Tài cực mạnh (≥7/10)");
  }
  if (last10.filter((r) => r === "X").length >= 7) {
    score.X += 5;
    explain.push("10 phiên gần nhất nghiêng Xỉu cực mạnh (≥7/10)");
  }

  if (last5.filter((r) => r === "T").length >= 4) {
    score.T += 4;
    explain.push("5 phiên gần nhất nghiêng Tài mạnh (≥4/5)");
  }
  if (last5.filter((r) => r === "X").length >= 4) {
    score.X += 4;
    explain.push("5 phiên gần nhất nghiêng Xỉu mạnh (≥4/5)");
  }

  if (last3.length === 3 && last3.every((r) => r === "T")) {
    score.X += 3.5;
    explain.push("3 Tài liên tiếp → đảo Xỉu mạnh");
  }
  if (last3.length === 3 && last3.every((r) => r === "X")) {
    score.T += 3.5;
    explain.push("3 Xỉu liên tiếp → đảo Tài mạnh");
  }

  const zigzag5 = last5.length === 5 && last5.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag5) {
    const pred = last === "T" ? "X" : "T";
    score[pred] += 3;
    explain.push("Cầu zigzag 5 phiên rõ ràng → lặp tiếp");
  }

  const zigzag10 = last10.length === 10 && last10.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag10) {
    const pred = last === "T" ? "X" : "T";
    score[pred] += 4;
    explain.push("Cầu zigzag 10 phiên dài → lặp tiếp mạnh");
  }

  const avg5 = avg(last5total);
  const avg10 = avg(last10total);
  if (avg10 >= 11.5) {
    score.T += 3.5;
    explain.push("Trung bình tổng 10 phiên cao (≥11.5) → Tài mạnh");
  } else if (avg10 <= 9.5) {
    score.X += 3.5;
    explain.push("Trung bình tổng 10 phiên thấp (≤9.5) → Xỉu mạnh");
  }

  if (avg5 >= 12) {
    score.T += 3;
    explain.push("Trung bình tổng 5 phiên cao (≥12) → Tài");
  } else if (avg5 <= 9) {
    score.X += 3;
    explain.push("Trung bình tổng 5 phiên thấp (≤9) → Xỉu");
  }

  if (isTrendingUp(last5total, 3)) {
    score.T += 2.5;
    explain.push("Tổng tăng đều 3 phiên gần → nghiêng Tài");
  } else if (isTrendingDown(last5total, 3)) {
    score.X += 2.5;
    explain.push("Tổng giảm đều 3 phiên gần → nghiêng Xỉu");
  }

  if (isTrendingUp(last10total, 5)) {
    score.T += 3;
    explain.push("Tổng tăng đều 5 phiên trong 10 → Tài mạnh");
  } else if (isTrendingDown(last10total, 5)) {
    score.X += 3;
    explain.push("Tổng giảm đều 5 phiên trong 10 → Xỉu mạnh");
  }

  const lastTotal = totals[totals.length - 1] ?? 10;
  if (lastTotal >= 17) {
    score.T += 4.5;
    explain.push("Tổng gần nhất rất cao (≥17) → Tài siêu mạnh");
  }
  if (lastTotal <= 4) {
    score.X += 4.5;
    explain.push("Tổng gần nhất rất thấp (≤4) → Xỉu siêu mạnh");
  }

  if (last10total.length === 10 && last10total.every((t) => t >= 11)) {
    score.T += 4;
    explain.push("10 phiên liên tiếp tổng cao (≥11) → Tài cực mạnh");
  }
  if (last10total.length === 10 && last10total.every((t) => t <= 10)) {
    score.X += 4;
    explain.push("10 phiên liên tiếp tổng thấp (≤10) → Xỉu cực mạnh");
  }

  const parity10 = lastN(totals, 10).length ? lastN(totals, 10).filter(t => t % 2 === 0).length / lastN(totals, 10).length : 0;
  if (parity10 >= 0.7) {
    score.X += 2.5;
    explain.push("Tỷ lệ chẵn cao trong 10 phiên (≥70%) → Xỉu bias");
  } else if (parity10 <= 0.3) {
    score.T += 2.5;
    explain.push("Tỷ lệ lẻ cao trong 10 phiên (≤30%) → Tài bias");
  }

  const avgDice10 = last10dices.flat().length ? avg(last10dices.flat()) : 3.5;
  if (avgDice10 >= 3.7) {
    score.T += 3.5;
    explain.push("Trung bình mặt xúc xắc cao trong 10 phiên → Tài");
  }
  if (avgDice10 <= 3.3) {
    score.X += 3.5;
    explain.push("Trung bình mặt xúc xắc thấp trong 10 phiên → Xỉu");
  }

  const lastDice = dices.length ? dices[dices.length - 1] : [3, 3, 3];
  const highDiceCount = lastDice.filter(d => d >= 4).length;
  if (highDiceCount >= 3) {
    score.T += 3;
    explain.push("Xúc xắc gần nhất tất cả cao → Tài");
  } else if (highDiceCount <= 0) {
    score.X += 3;
    explain.push("Xúc xắc gần nhất tất cả thấp → Xỉu");
  }

  const s = streakOfEnd(results);
  if (s >= 5 && s < 8) {
    const opp = last === "T" ? "X" : "T";
    score[opp] += 4;
    explain.push(`Chuỗi ${s} → đảo chiều mạnh`);
  }
  if (s >= 8) {
    score[last] += 2.5;
    explain.push(`Chuỗi dài ≥8 → theo chiều`);
  }
  if (s >= 10) {
    const opp = last === "T" ? "X" : "T";
    score[opp] += 5;
    explain.push(`Chuỗi siêu dài ≥10 → chắc chắn đảo`);
  }

  const ttxxCount = countPattern(results, 'TTXX');
  if (ttxxCount >= 2) {
    score.T += 2;
    explain.push("Pattern TTXX lặp ≥2 lần → Tài tiếp theo");
  }
  const xttxCount = countPattern(results, 'XTTX');
  if (xttxCount >= 2) {
    score.X += 2;
    explain.push("Pattern XTTX lặp ≥2 lần → Xỉu tiếp theo");
  }

  const ent10 = entropy(lastN(results, 10));
  if (ent10 < 0.5) {
    const opp = last === "T" ? "X" : "T";
    score[opp] += 3;
    explain.push("Entropy thấp trong 10 phiên (<0.5) → khả năng đảo");
  }

  const zLast = zScoreLast(lastN(totals, 10));
  if (zLast > 1.5) {
    score.T += 2;
    explain.push("Z-score tổng gần nhất cao (>1.5) → Tài bias");
  } else if (zLast < -1.5) {
    score.X += 2;
    explain.push("Z-score tổng gần nhất thấp (<-1.5) → Xỉu bias");
  }

  let pred = null;
  let conf = 0.7;
  if (score.T > score.X + 2) {
    pred = "T";
    conf = 0.75 + Math.min(0.2, (score.T - score.X) * 0.05);
    explain.push("Score nghiêng Tài mạnh");
  } else if (score.X > score.T + 2) {
    pred = "X";
    conf = 0.75 + Math.min(0.2, (score.X - score.T) * 0.05);
    explain.push("Score nghiêng Xỉu mạnh");
  } else {
    if (avg10 >= 11) {
      pred = "T";
      conf = 0.7;
      explain.push("Score gần cân bằng → bias tổng cao → Tài");
    } else if (avg10 <= 10) {
      pred = "X";
      conf = 0.7;
      explain.push("Score gần cân bằng → bias tổng thấp → Xỉu");
    } else {
      pred = last === "T" ? "X" : "T";
      conf = 0.65;
      explain.push("Không nghiêng rõ → đảo chiều default");
    }
  }

  return { pred, conf: Math.min(0.98, conf), why: explain };
}

// ---------------------- LAYER 2: MODEL-BASED ----------------------

function markovPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 200);
  let tt = 1, tx = 1, xt = 1, xx = 1;
  let tt_t = 1, tt_x = 1, tx_t = 1, tx_x = 1, xt_t = 1, xt_x = 1, xx_t = 1, xx_x = 1;
  let ttt_t = 1, ttt_x = 1, ttx_t = 1, ttx_x = 1, txt_t = 1, txt_x = 1, txx_t = 1, txx_x = 1;
  let xtt_t = 1, xtt_x = 1, xtx_t = 1, xtx_x = 1, xxt_t = 1, xxt_x = 1, xxx_t = 1, xxx_x = 1;
  let tttt_t = 1, tttt_x = 1;

  for (let i = 1; i < use.length; i++) {
    const prev = use[i - 1];
    const cur = use[i];
    if (prev === "T" && cur === "T") tt++;
    if (prev === "T" && cur === "X") tx++;
    if (prev === "X" && cur === "T") xt++;
    if (prev === "X" && cur === "X") xx++;
  }

  for (let i = 2; i < use.length; i++) {
    const prev2 = use[i - 2] + use[i - 1];
    const cur = use[i];
    if (prev2 === "TT") {
      if (cur === "T") tt_t++;
      else tt_x++;
    } else if (prev2 === "TX") {
      if (cur === "T") tx_t++;
      else tx_x++;
    } else if (prev2 === "XT") {
      if (cur === "T") xt_t++;
      else xt_x++;
    } else if (prev2 === "XX") {
      if (cur === "T") xx_t++;
      else xx_x++;
    }
  }

  for (let i = 3; i < use.length; i++) {
    const prev3 = use[i - 3] + use[i - 2] + use[i - 1];
    const cur = use[i];
    if (prev3 === "TTT") {
      if (cur === "T") ttt_t++;
      else ttt_x++;
    } else if (prev3 === "TTX") {
      if (cur === "T") ttx_t++;
      else ttx_x++;
    } else if (prev3 === "TXT") {
      if (cur === "T") txt_t++;
      else txt_x++;
    } else if (prev3 === "TXX") {
      if (cur === "T") txx_t++;
      else txx_x++;
    } else if (prev3 === "XTT") {
      if (cur === "T") xtt_t++;
      else xtt_x++;
    } else if (prev3 === "XTX") {
      if (cur === "T") xtx_t++;
      else xtx_x++;
    } else if (prev3 === "XXT") {
      if (cur === "T") xxt_t++;
      else xxt_x++;
    } else if (prev3 === "XXX") {
      if (cur === "T") xxx_t++;
      else xxx_x++;
    }
  }

  for (let i = 4; i < use.length; i++) {
    const prev4 = use[i - 4] + use[i - 3] + use[i - 2] + use[i - 1];
    const cur = use[i];
    if (prev4 === "TTTT") {
      if (cur === "T") tttt_t++;
      else tttt_x++;
    }
  }

  const last = use.length ? use[use.length - 1] : null;
  const last2 = use.length >= 2 ? (use[use.length - 2] + last) : null;
  const last3 = use.length >= 3 ? (use[use.length - 3] + use[use.length - 2] + last) : null;
  const last4 = use.length >= 4 ? (use[use.length - 4] + use[use.length - 3] + use[use.length - 2] + last) : null;

  let pT = 0.5, pX = 0.5, why = [];
  if (use.length >= 4 && last4 && last4 === "TTTT") {
    const s = tttt_t + tttt_x;
    pT = tttt_t / s;
    pX = tttt_x / s;
    why.push(`Markov lag4 từ ${last4}: P(T)=${pT.toFixed(2)}`);
  } else if (use.length >= 3 && last3) {
    let s, pt, px;
    if (last3 === "TTT") { s = ttt_t + ttt_x; pt = ttt_t / s; px = ttt_x / s; }
    else if (last3 === "TTX") { s = ttx_t + ttx_x; pt = ttx_t / s; px = ttx_x / s; }
    else if (last3 === "TXT") { s = txt_t + txt_x; pt = txt_t / s; px = txt_x / s; }
    else if (last3 === "TXX") { s = txx_t + txx_x; pt = txx_t / s; px = txx_x / s; }
    else if (last3 === "XTT") { s = xtt_t + xtt_x; pt = xtt_t / s; px = xtt_x / s; }
    else if (last3 === "XTX") { s = xtx_t + xtx_x; pt = xtx_t / s; px = xtx_x / s; }
    else if (last3 === "XXT") { s = xxt_t + xxt_x; pt = xxt_t / s; px = xxt_x / s; }
    else if (last3 === "XXX") { s = xxx_t + xxx_x; pt = xxx_t / s; px = xxx_x / s; }
    pT = pt || 0.5;
    pX = px || 0.5;
    why.push(`Markov lag3 từ ${last3}: P(T)=${pT.toFixed(2)}, P(X)=${pX.toFixed(2)}`);
  } else if (use.length >= 2 && last2) {
    let s, pt, px;
    if (last2 === "TT") { s = tt_t + tt_x; pt = tt_t / s; px = tt_x / s; }
    else if (last2 === "TX") { s = tx_t + tx_x; pt = tx_t / s; px = tx_x / s; }
    else if (last2 === "XT") { s = xt_t + xt_x; pt = xt_t / s; px = xt_x / s; }
    else if (last2 === "XX") { s = xx_t + xx_x; pt = xx_t / s; px = xx_x / s; }
    pT = pt || 0.5;
    pX = px || 0.5;
    why.push(`Markov lag2 từ ${last2}: P(T)=${pT.toFixed(2)}, P(X)=${pX.toFixed(2)}`);
  } else if (last) {
    let s;
    if (last === "T") { s = tt + tx; pT = tt / s; pX = tx / s; }
    else if (last === "X") { s = xt + xx; pT = xt / s; pX = xx / s; }
    why.push(`Markov lag1 từ ${last}: P(T)=${pT.toFixed(2)}, P(X)=${pX.toFixed(2)}`);
  }

  const pred = pT >= pX ? "T" : "X";
  const conf = Math.max(pT, pX) + 0.1;
  return { pred, conf: Math.min(0.98, 0.65 + (conf - 0.5) * 0.8), why, pT, pX };
}

function recentPatternPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 30);
  let why = [];

  const patCounts = (len) => {
    const o = {};
    for (let i = 0; i <= use.length - len; i++) {
      const k = use.slice(i, i + len).join("");
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  };

  const pat3Counts = patCounts(3);
  const pat4Counts = patCounts(4);
  const pat5Counts = patCounts(5);
  const pat6Counts = patCounts(6);

  function bestEntry(obj) {
    const ent = Object.entries(obj);
    if (!ent.length) return null;
    return ent.sort((a, b) => b[1] - a[1])[0];
  }

  const b6 = bestEntry(pat6Counts);
  const b5 = bestEntry(pat5Counts);
  const b4 = bestEntry(pat4Counts);
  const b3 = bestEntry(pat3Counts);

  let pred = null;
  let conf = 0.6;

  if (b6 && b6[1] >= 2) {
    const patt = b6[0];
    pred = patt[patt.length - 1];
    conf = 0.8 + Math.min(0.15, (b6[1] - 2) * 0.05);
    why.push(`Pattern 6 lặp: ${patt} x${b6[1]}`);
  } else if (b5 && b5[1] >= 3) {
    const patt = b5[0];
    pred = patt[patt.length - 1];
    conf = 0.78 + Math.min(0.15, (b5[1] - 3) * 0.05);
    why.push(`Pattern 5 lặp: ${patt} x${b5[1]}`);
  } else if (b4 && b4[1] >= 4) {
    const patt = b4[0];
    pred = patt[patt.length - 1];
    conf = 0.75 + Math.min(0.12, (b4[1] - 4) * 0.04);
    why.push(`Pattern 4 lặp: ${patt} x${b4[1]}`);
  } else if (b3 && b3[1] >= 5) {
    const patt = b3[0];
    pred = patt[patt.length - 1];
    conf = 0.72 + Math.min(0.1, (b3[1] - 5) * 0.03);
    why.push(`Pattern 3 lặp: ${patt} x${b3[1]}`);
  } else {
    const weights = use.map((_, i) => Math.pow(1.2, i));
    const tScore = use.reduce((s, v, i) => s + (v === "T" ? weights[i] : 0), 0);
    const xScore = use.reduce((s, v, i) => s + (v === "X" ? weights[i] : 0), 0);
    pred = tScore >= xScore ? "T" : "X";
    const dom = Math.abs(tScore - xScore) / (tScore + xScore || 1);
    conf = 0.65 + Math.min(0.25, dom * 0.8);
    why.push("Trọng số gần đây nghiêng " + (pred === "T" ? "Tài" : "Xỉu"));
  }

  return { pred, conf, why };
}

function breakStreakFilter(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const s = streakOfEnd(rs);
  const cur = rs[rs.length - 1];

  let streakCounts = {};
  let breakCounts = {};
  let currentStreak = 1;
  for (let i = 1; i < rs.length; i++) {
    if (rs[i] === rs[i - 1]) currentStreak++;
    else {
      streakCounts[currentStreak] = (streakCounts[currentStreak] || 0) + 1;
      breakCounts[currentStreak] = (breakCounts[currentStreak] || 0) + 1;
      currentStreak = 1;
    }
  }
  if (currentStreak >= 1) streakCounts[currentStreak] = (streakCounts[currentStreak] || 0) + 1;

  let breakProb = 0;
  if (s >= 10) breakProb = 0.85;
  else if (s >= 8) breakProb = 0.8;
  else if (s >= 6) breakProb = 0.75;
  else if (s >= 4) breakProb = 0.65;
  else if (s >= 3) breakProb = 0.6;

  if (s >= 3 && streakCounts[s] > 0) {
    breakProb = (breakCounts[s] / streakCounts[s]) || breakProb;
  }

  const ent = entropy(lastN(rs, 20));
  if (ent < 0.6) breakProb += 0.1;

  if (breakProb >= 0.65) {
    const pred = cur === "T" ? "X" : "T";
    return {
      pred,
      conf: Math.min(0.98, breakProb + 0.05),
      why: [`Chuỗi ${s} ${cur === "T" ? "Tài" : "Xỉu"} → xác suất bẻ cầu ${Math.round(breakProb * 100)}%`],
    };
  }
  return {
    pred: cur,
    conf: 0.6,
    why: [`Chuỗi ${s} chưa đủ để bẻ → theo cầu`],
  };
}

function arPrediction(hist) {
  const totals = hist.map(h => h.tong);
  const use = lastN(totals, 50);
  if (use.length < 5) return { pred: "T", conf: 0.5, why: ["Không đủ dữ liệu cho AR"] };

  const a1 = 0.5, a2 = 0.3, a3 = 0.15;
  const c = avg(use) * (1 - a1 - a2 - a3);
  const nextTotal = a1 * use[use.length - 1] + a2 * use[use.length - 2] + a3 * use[use.length - 3] + c;

  const pred = nextTotal > 10.5 ? "T" : "X";
  const conf = 0.65 + Math.min(0.25, Math.abs(nextTotal - 10.5) / 7);
  const why = [`AR(3) dự đoán tổng tiếp ~${nextTotal.toFixed(1)} → ${pred}`];
  return { pred, conf, why };
}

function smaCrossoverPrediction(hist) {
  const totals = hist.map(h => h.tong);
  const use = lastN(totals, 50);
  if (use.length < 20) return { pred: "T", conf: 0.5, why: ["Không đủ dữ liệu cho SMA"] };

  const smaShort = avg(lastN(use, 5));
  const smaLong = avg(lastN(use, 20));
  const pred = smaShort > smaLong ? "T" : "X";
  const conf = 0.7 + Math.min(0.2, Math.abs(smaShort - smaLong) / 5);
  const why = [`SMA crossover: short ${smaShort.toFixed(1)} vs long ${smaLong.toFixed(1)} → ${pred}`];
  return { pred, conf, why };
}

function rsiPrediction(hist) {
  const totals = hist.map(h => h.tong - 10.5);
  const use = lastN(totals, 14);
  if (use.length < 14) return { pred: "T", conf: 0.5, why: ["Không đủ dữ liệu cho RSI"] };

  let gains = 0, losses = 0;
  for (let i = 1; i < use.length; i++) {
    const diff = use[i] - use[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / 13;
  const avgLoss = losses / 13;
  const rs = avgGain / (avgLoss || 1);
  const rsi = 100 - (100 / (1 + rs));

  let pred = "T";
  if (rsi > 70) pred = "X";
  else if (rsi < 30) pred = "T";
  const conf = 0.7 + Math.min(0.2, Math.abs(rsi - 50) / 50);
  const why = [`RSI ${rsi.toFixed(1)} → ${pred}`];
  return { pred, conf, why };
}

// ---------------------- ENSEMBLE ----------------------

function markovTransitionFeature(rs) {
  const use = lastN(rs, 200);
  if (use.length < 2) return { pT: 0.5, pX: 0.5 };
  let tt = 1, tx = 1, xt = 1, xx = 1;
  for (let i = 1; i < use.length; i++) {
    const a = use[i - 1], b = use[i];
    if (a === 'T' && b === 'T') tt++;
    if (a === 'T' && b === 'X') tx++;
    if (a === 'X' && b === 'T') xt++;
    if (a === 'X' && b === 'X') xx++;
  }
  const last = use[use.length - 1];
  if (last === 'T') { const s = tt + tx; return { pT: tt / s, pX: tx / s }; }
  const s = xt + xx; return { pT: xt / s, pX: xx / s };
}

function extractFeaturesForEnsemble(hist) {
  const rs = hist.map(h => h.ket_qua);
  const totals = hist.map(h => h.tong);
  const dices = hist.map(h => h.dice);

  const last5 = lastN(rs, 5);
  const last10 = lastN(rs, 10);
  const last20 = lastN(rs, 20);
  const last50 = lastN(rs, 50);

  const freqT_5 = last5.filter(r => r === 'T').length / (last5.length || 1);
  const freqT_10 = last10.filter(r => r === 'T').length / (last10.length || 1);
  const freqT_20 = last20.filter(r => r === 'T').length / (last20.length || 1);
  const freqT_50 = last50.filter(r => r === 'T').length / (last50.length || 1);
  const avg5 = avg(lastN(totals, 5)) / 18;
  const avg10 = avg(lastN(totals, 10)) / 18;
  const avg20 = avg(lastN(totals, 20)) / 18;
  const run = Math.min(1, streakOfEnd(rs) / 15);
  const switchRate12 = switchRate(lastN(rs, 12));
  const switchRate20 = switchRate(lastN(rs, 20));
  const parityRatio5 = lastN(totals, 5).filter(t => t % 2 === 0).length / (lastN(totals, 5).length || 1);
  const parityRatio10 = lastN(totals, 10).filter(t => t % 2 === 0).length / (lastN(totals, 10).length || 1);
  const markov = markovTransitionFeature(rs);
  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);
  const r5 = arPrediction(hist);
  const r6 = smaCrossoverPrediction(hist);
  const r7 = rsiPrediction(hist);

  const entropy10 = entropy(lastN(rs, 10));
  const entropy20 = entropy(lastN(rs, 20));
  const lag1 = autocorr(lastN(totals, 20), 1);
  const lag2 = autocorr(lastN(totals, 20), 2);
  const lag3 = autocorr(lastN(totals, 20), 3);
  const avgDice5 = lastN(dices, 5).flat().length ? avg(lastN(dices, 5).flat()) / 3.5 : 1;
  const highDiceFreq5 = lastN(dices, 5).flat().length ? lastN(dices, 5).flat().filter(d => d > 3).length / lastN(dices, 5).flat().length : 0;
  const avgDice10 = lastN(dices, 10).flat().length ? avg(lastN(dices, 10).flat()) / 3.5 : 1;
  const highDiceFreq10 = lastN(dices, 10).flat().length ? lastN(dices, 10).flat().filter(d => d > 3).length / lastN(dices, 10).flat().length : 0;

  // Map to expected feature names
  const f_freqT_5 = freqT_5;
  const f_freqT_10 = freqT_10;
  const f_freqT_20 = freqT_20;
  const f_freqT_50 = freqT_50;
  const f_avg5 = avg5;
  const f_avg10 = avg10;
  const f_avg20 = avg20;
  const f_run = run;

  return {
    f_freqT_5, f_freqT_10, f_freqT_20, f_freqT_50,
    f_avg5, f_avg10, f_avg20,
    f_run,
    f_switch12: switchRate12, f_switch20: switchRate20,
    f_parity5: parityRatio5, f_parity10: parityRatio10,
    m_markov_Tprob: markov.pT || 0.5,
    model_r1_T: r1.pred === 'T' ? r1.conf : 1 - r1.conf,
    model_r2_T: r2.pred === 'T' ? r2.conf : 1 - r2.conf,
    model_r3_T: r3.pred === 'T' ? r3.conf : 1 - r3.conf,
    model_r4_T: r4.pred === 'T' ? r4.conf : 1 - r4.conf,
    model_r5_T: r5.pred === 'T' ? r5.conf : 1 - r5.conf,
    model_r6_T: r6.pred === 'T' ? r6.conf : 1 - r6.conf,
    model_r7_T: r7.pred === 'T' ? r7.conf : 1 - r7.conf,
    f_entropy10: entropy10, f_entropy20: entropy20,
    f_lag1: lag1, f_lag2: lag2, f_lag3: lag3,
    f_avgDice5: avgDice5, f_avgDice10: avgDice10,
    f_highDice5: highDiceFreq5, f_highDice10: highDiceFreq10,
  };
}

// Online logistic with more features
class OnlineLogisticEnsemble {
  constructor(featureKeys, lr = 0.04, reg = 5e-4) {
    this.keys = featureKeys;
    this.lr = lr;
    this.reg = reg;
    this.w = {};
    featureKeys.forEach(k => this.w[k] = (Math.random() * 0.02) - 0.01);
    this.bias = 0;
    this._warmed = false;
  }

  _dot(features) {
    let s = this.bias;
    this.keys.forEach(k => { s += (this.w[k] || 0) * (features[k] || 0); });
    return s;
  }

  predictProb(features) {
    const z = this._dot(features);
    return 1 / (1 + Math.exp(-z));
  }

  update(features, label) {
    const p = this.predictProb(features);
    const err = p - label;
    this.keys.forEach(k => {
      const g = err * (features[k] || 0) + this.reg * (this.w[k] || 0);
      this.w[k] = (this.w[k] || 0) - this.lr * g;
    });
    this.bias -= this.lr * err;
  }

  batchFitWalkForward(history, featureFn, warm = 80) {
    const N = history.length;
    if (N < warm + 10) return;
    for (let i = warm; i < N - 1; i++) {
      const past = history.slice(0, i + 1);
      const features = featureFn(past);
      const label = history[i + 1].ket_qua === 'T' ? 1 : 0;
      this.update(features, label);
    }
    this._warmed = true;
  }
}

const ensembleFeatureKeys = [
  'f_freqT_5','f_freqT_10','f_freqT_20','f_freqT_50',
  'f_avg5','f_avg10','f_avg20',
  'f_run',
  'f_switch12','f_switch20',
  'f_parity5','f_parity10',
  'm_markov_Tprob',
  'model_r1_T','model_r2_T','model_r3_T','model_r4_T','model_r5_T','model_r6_T','model_r7_T',
  'f_entropy10','f_entropy20',
  'f_lag1','f_lag2','f_lag3',
  'f_avgDice5','f_avgDice10',
  'f_highDice5','f_highDice10'
];
const LOGISTIC_ENSEMBLE = new OnlineLogisticEnsemble(ensembleFeatureKeys, 0.04, 5e-4);

function ensemblePredict(hist) {
  if (!hist || hist.length < 10) {
    return { pred: hist && hist.length ? hist[hist.length - 1].ket_qua : "T", conf: 0.6, why: ["Không đủ dữ liệu, fallback"] };
  }

  if (hist.length > 150 && !LOGISTIC_ENSEMBLE._warmed) {
    try {
      LOGISTIC_ENSEMBLE.batchFitWalkForward(hist, extractFeaturesForEnsemble, 80);
    } catch (err) {
      // fail silently, still continue
      console.error("Warm up failed:", err && err.message);
    }
  }

  const features = extractFeaturesForEnsemble(hist);
  const pT = LOGISTIC_ENSEMBLE.predictProb(features);
  const pX = 1 - pT;
  const predLog = pT >= pX ? 'T' : 'X';
  const confLog = Math.max(pT, pX);

  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);
  const r5 = arPrediction(hist);
  const r6 = smaCrossoverPrediction(hist);
  const r7 = rsiPrediction(hist);

  const votes = [
    { p: r1.pred, c: (r1.conf || 0.6) * 0.2, why: r1.why || [] },
    { p: r2.pred, c: (r2.conf || 0.6) * 0.15, why: r2.why || [] },
    { p: r3.pred, c: (r3.conf || 0.6) * 0.2, why: r3.why || [] },
    { p: r4.pred, c: (r4.conf || 0.6) * 0.15, why: r4.why || [] },
    { p: r5.pred, c: (r5.conf || 0.6) * 0.1, why: r5.why || [] },
    { p: r6.pred, c: (r6.conf || 0.6) * 0.1, why: r6.why || [] },
    { p: r7.pred, c: (r7.conf || 0.6) * 0.1, why: r7.why || [] },
    { p: predLog, c: confLog * 0.4, why: [`Logistic pT=${pT.toFixed(3)}`] }
  ];

  const scoreT = sum(votes.map(v => v.p === 'T' ? v.c : 0));
  const scoreX = sum(votes.map(v => v.p === 'X' ? v.c : 0));
  const pred = scoreT >= scoreX ? 'T' : 'X';
  const rawConf = Math.max(scoreT, scoreX) / (scoreT + scoreX || 1);
  const agree = votes.filter(v => v.p === pred).length / votes.length;
  const conf = Math.min(0.99, 0.7 + (rawConf - 0.5) * 0.75 + agree * 0.15);

  const why = votes.filter(v => v.p === pred).flatMap(v => v.why).concat([`Đồng thuận ${Math.round(agree*100)}%`]);

  return { pred, conf, why, pieces: { logistic: { pT, pX }, votes } };
}

// ---------------------- BACKTEST + KELLY ----------------------

function overallBacktest(hist, lookback = 200, betUnit = 1) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 20) return { acc: 0, sample: n, bankroll: null, roi: 0, maxDrawdown: 0, sharpe: 0, details: [] };

  let correct = 0;
  let bankroll = 1000;
  let peak = bankroll;
  let maxDrawdown = 0;
  let returns = [];
  const details = [];
  for (let i = hist.length - 1 - n; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const res = ensemblePredict(past);
    const actualNext = hist[i + 1].ket_qua;
    const betSize = kellyBetSize(res.conf, 0.95, bankroll, betUnit);
    let ret = 0;
    if (res.pred === actualNext) {
      correct++;
      bankroll += betSize * 0.95;
      ret = betSize * 0.95 / bankroll;
    } else {
      bankroll -= betSize;
      ret = -betSize / bankroll;
    }
    returns.push(ret);
    if (bankroll > peak) peak = bankroll;
    const dd = (peak - bankroll) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
    details.push({ idx: i + 1, pred: res.pred, actual: actualNext, conf: res.conf, bet: betSize, bankroll: bankroll, ret: ret });
  }
  const acc = correct / n;
  const roi = (bankroll - 1000) / 1000;
  const meanRet = avg(returns);
  const sdRet = stdDev(returns);
  const sharpe = sdRet > 0 ? meanRet / sdRet : 0;
  return { acc, sample: n, bankroll, roi, maxDrawdown, sharpe, details: details.slice(-200) };
}

function kellyBetSize(confidence, payout = 0.95, bankroll = 1000, baseUnit = 1) {
  const p = Math.max(0.01, Math.min(0.99, confidence));
  const b = payout;
  const q = 1 - p;
  const k = (b * p - q) / b;
  if (k <= 0) return baseUnit;
  const frac = Math.min(0.25, k);
  return Math.max(1, Math.round(bankroll * frac));
}

// ---------------------- RISK LEVEL ----------------------

function riskLevel(conf, hist) {
  const rs = hist.map((h) => h.ket_qua);
  const last20 = lastN(rs, 20);
  let switches = 0;
  for (let i = 1; i < last20.length; i++) {
    if (last20[i] !== last20[i - 1]) switches++;
  }
  const switchRate_ = last20.length > 1 ? switches / (last20.length - 1) : 0;
  const s = streakOfEnd(rs);
  const ent = entropy(lastN(rs, 20));
  const varTotal = variance(lastN(hist.map(h => h.tong), 20));

  let risk = 1 - conf;
  risk += switchRate_ * 0.2;
  if (s >= 7) risk += 0.1;
  if (ent > 0.95) risk += 0.15;
  if (varTotal > 10) risk += 0.1;

  if (risk <= 0.25) return "Thấp";
  if (risk <= 0.4) return "Trung bình";
  return "Cao";
}

// ---------------------- API ROUTES ----------------------

app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString(), version: "Super VIP" }));

app.get("/api/du-doan", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const last = hist[hist.length - 1];
    const { pred, conf, why, pieces } = ensemblePredict(hist);
    const bt = overallBacktest(hist, 200);
    const tyLe = Math.round((bt.acc || 0) * 100);
    const kelly = kellyBetSize(conf, 0.95, 1000, 1);

    const out = {
      phien: last.phien,
      xuc_xac: `${last.dice[0]}-${last.dice[1]}-${last.dice[2]}`,
      tong: last.tong,
      ket_qua: last.ket_qua === "T" ? "Tài" : "Xỉu",
      phien_sau: last.phien + 1,
      du_doan: pred === "T" ? "Tài" : "Xỉu",
      ty_le_thanh_cong: `${tyLe}% (backtest ${bt.sample} mẫu)`,
      do_tin_cay: `${Math.round(conf * 100)}%`,
      goi_y_cuoc_kelly: kelly,
      giai_thich: Array.isArray(why) ? why.join(" | ") : why,
      muc_do_rui_ro: riskLevel(conf, hist),
      meta: {
        logistic_pieces: pieces ? pieces.logistic : null,
        votes: pieces ? pieces.votes : null,
        sharpe: bt.sharpe ? bt.sharpe.toFixed(2) : null
      }
    };

    res.json(out);
  } catch (e) {
    console.error(e && e.message);
    if (e && e.response && e.response.status === 404) {
      return res.status(502).json({ error: "Nguồn trả về 404" });
    }
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/du-doan/full", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const detail = [];
    const start = Math.max(10, hist.length - 30);
    for (let i = start; i < hist.length; i++) {
      const past = hist.slice(0, i);
      const cur = hist[i];
      const predRes = ensemblePredict(past);
      detail.push({
        phien: cur.phien,
        ket_qua_thuc: cur.ket_qua === "T" ? "Tài" : "Xỉu",
        du_doan_tai_thoi_diem_do: predRes.pred === "T" ? "Tài" : "Xỉu",
        dung_khong: predRes.pred === cur.ket_qua,
        do_tin_cay: Math.round((predRes.conf || 0) * 100) + "%",
      });
    }

    const final = ensemblePredict(hist);
    const bt = overallBacktest(hist, 300);

    res.json({
      now: hist[hist.length - 1]?.phien,
      next: hist[hist.length - 1]?.phien + 1,
      du_doan_tiep: final.pred === "T" ? "Tài" : "Xỉu",
      do_tin_cay: Math.round((final.conf || 0) * 100) + "%",
      muc_do_rui_ro: riskLevel(final.conf, hist),
      giai_thich: final.why,
      backtest: {
        ty_le_thanh_cong: Math.round((bt.acc || 0) * 100) + "%",
        so_mau: bt.sample,
        final_bankroll: bt.bankroll,
        sharpe_ratio: bt.sharpe ? bt.sharpe.toFixed(2) : null
      },
      chi_tiet_30_phien_gan: detail,
    });
  } catch (e) {
    console.error(e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/backtest", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });
    const lookback = Math.min(Number(req.query.lookback) || 300, hist.length - 1);
    const bt = overallBacktest(hist, lookback);
    res.json({
      lookback,
      acc: Math.round((bt.acc || 0) * 10000) / 100,
      sample: bt.sample,
      final_bankroll: bt.bankroll,
      roi: bt.roi ? bt.roi.toFixed(2) : null,
      max_drawdown: bt.maxDrawdown ? (bt.maxDrawdown * 100).toFixed(2) + "%" : null,
      sharpe: bt.sharpe ? bt.sharpe.toFixed(2) : null,
      recent_details: bt.details.slice(-100)
    });
  } catch (e) {
    console.error(e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Super VIP Predictor running at http://localhost:${PORT}`);
});
