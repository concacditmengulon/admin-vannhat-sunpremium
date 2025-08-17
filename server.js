const express = require("express");
const axios = require("axios");
const cors = require("cors");

// Constants
const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://fullsrc-daynesun.onrender.com/api/taixiu/sunwin";

// Initialize the Express application
const app = express();
app.use(cors());
app.use(express.json());

// ---------------------- UTILITIES SECTION ----------------------
// These are functions that perform various calculations and data manipulations.
function normResult(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["t", "tai", "tài"].includes(s)) return "T";
  if (["x", "xiu", "xỉu"].includes(s)) return "X";
  return null;
}

function lastN(arr, n) {
  if (!Array.isArray(arr) || n <= 0) return [];
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

function movingAverage(arr, window) {
  if (!arr || arr.length < window) return [];
  let ma = [];
  for (let i = window - 1; i < arr.length; i++) {
    ma.push(avg(arr.slice(i - window + 1, i + 1)));
  }
  return ma;
}

function ema(arr, alpha) {
  if (!arr || !arr.length) return [];
  let emaArr = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    emaArr.push(alpha * arr[i] + (1 - alpha) * emaArr[i - 1]);
  }
  return emaArr;
}

function detectCycleLength(arr, maxLag = 20) {
  let maxCorr = -Infinity;
  let cycle = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    const corr = autocorr(arr, lag);
    if (corr > maxCorr) {
      maxCorr = corr;
      cycle = lag;
    }
  }
  return cycle;
}

function kurtosis(arr) {
  if (!arr || arr.length < 4) return 0;
  const mean = avg(arr);
  const n = arr.length;
  const m4 = sum(arr.map(v => (v - mean) ** 4)) / n;
  const m2 = sum(arr.map(v => (v - mean) ** 2)) / n;
  return m4 / (m2 ** 2) - 3;
}

function skewness(arr) {
  if (!arr || arr.length < 3) return 0;
  const mean = avg(arr);
  const n = arr.length;
  const m3 = sum(arr.map(v => (v - mean) ** 3)) / n;
  const m2 = sum(arr.map(v => (v - mean) ** 2)) / n;
  return m3 / (Math.sqrt(m2) ** 3);
}

function normalize(arr) {
  if (!arr || !arr.length) return [];
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (max === min) return arr.map(() => 0.5);
  return arr.map(v => (v - min) / (max - min));
}

function cumsum(arr) {
  let cs = [0];
  for (let i = 0; i < arr.length; i++) {
    cs.push(cs[i] + arr[i]);
  }
  return cs.slice(1);
}

// ---------------------- ADVANCED PATTERN DETECTION SECTION ----------------------
// Defines known bridge types with their patterns.
const BRIDGE_TYPES = {
  'bet_t': { pattern: 'TTTTT', desc: 'Cầu bệt Tài (long streak T)', follow: 'T' },
  'bet_x': { pattern: 'XXXXX', desc: 'Cầu bệt Xỉu (long streak X)', follow: 'X' },
  '1-1': { pattern: 'TXTXT', desc: 'Cầu 1-1 (zigzag)', follow: alternFollow },
  '1-2_txx': { pattern: 'TXXTXX', desc: 'Cầu 1-2 starting T XX', follow: oneTwoFollow },
  '1-2_xtt': { pattern: 'XTTXTT', desc: 'Cầu 1-2 starting X TT', follow: oneTwoFollow },
  '2-1_tt x': { pattern: 'TTXTTX', desc: 'Cầu 2-1 TT X', follow: twoOneFollow },
  '2-1_xx t': { pattern: 'XXTXXT', desc: 'Cầu 2-1 XX T', follow: twoOneFollow },
  '2-2': { pattern: 'TTXXTTXX', desc: 'Cầu 2-2 TT XX', follow: twoTwoFollow },
  '3-1_ttt x': { pattern: 'TTTXTTTX', desc: 'Cầu 3-1 TTT X', follow: threeOneFollow },
  '3-1_xxx t': { pattern: 'XXXTXXXT', desc: 'Cầu 3-1 XXX T', follow: threeOneFollow },
  '3-2_ttt xx': { pattern: 'TTTXXTTTXX', desc: 'Cầu 3-2 TTT XX', follow: threeTwoFollow },
  '3-2_xxx tt': { pattern: 'XXXTTXXXTT', desc: 'Cầu 3-2 XXX TT', follow: threeTwoFollow },
  '4-1': { pattern: 'TTTTXTTTTX', desc: 'Cầu 4-1', follow: fourOneFollow },
  '4-2': { pattern: 'TTTTXXTTTTXX', desc: 'Cầu 4-2', follow: fourTwoFollow },
  '1-3': { pattern: 'TXXXTXXX', desc: 'Cầu 1-3 T XXX', follow: oneThreeFollow },
  '2-3': { pattern: 'TTXXXTTXXX', desc: 'Cầu 2-3 TT XXX', follow: twoThreeFollow },
  '3-3': { pattern: 'TTTXXXTTTXXX', desc: 'Cầu 3-3 TTT XXX', follow: threeThreeFollow },
  'fib_1-1-2': { pattern: 'TXTTXTTXT', desc: 'Fib-like 1-1-2', follow: fibFollow },
  'fib_1-2-3': { pattern: 'TXXTTTXXTTT', desc: 'Fib-like 1-2-3', follow: fibFollow },
};

function alternFollow(lastSeq) {
  return lastSeq[lastSeq.length - 1] === 'T' ? 'X' : 'T';
}

function oneTwoFollow(lastSeq) {
  const last3 = lastN(lastSeq, 3).join('');
  if (last3.endsWith('TX') || last3.endsWith('XT')) return 'X';
  return 'T';
}

function twoOneFollow(lastSeq) {
  const last3 = lastN(lastSeq, 3).join('');
  if (last3 === 'TTX') return 'T';
  if (last3 === 'XXT') return 'X';
  return lastSeq[lastSeq.length - 1];
}

function twoTwoFollow(lastSeq) {
  const last4 = lastN(lastSeq, 4).join('');
  if (last4.endsWith('TTXX')) return 'T';
  if (last4.endsWith('XXTT')) return 'X';
  return alternFollow(lastSeq);
}

function threeOneFollow(lastSeq) {
  const last4 = lastN(lastSeq, 4).join('');
  if (last4 === 'TTTX') return 'T';
  if (last4 === 'XXXT') return 'X';
  return lastSeq[lastSeq.length - 1];
}

function threeTwoFollow(lastSeq) {
  const last5 = lastN(lastSeq, 5).join('');
  if (last5.endsWith('TTTXX')) return 'T';
  if (last5.endsWith('XXXTT')) return 'X';
  return twoTwoFollow(lastSeq);
}

function fourOneFollow(lastSeq) {
  const last5 = lastN(lastSeq, 5).join('');
  if (last5 === 'TTTTX') return 'T';
  if (last5 === 'XXXXT') return 'X';
  return threeOneFollow(lastSeq);
}

function fourTwoFollow(lastSeq) {
  const last6 = lastN(lastSeq, 6).join('');
  if (last6.endsWith('TTTTXX')) return 'T';
  if (last6.endsWith('XXXXTT')) return 'X';
  return threeTwoFollow(lastSeq);
}

function oneThreeFollow(lastSeq) {
  const last4 = lastN(lastSeq, 4).join('');
  if (last4.endsWith('TXXX')) return 'T';
  if (last4.endsWith('XTTT')) return 'X';
  return oneTwoFollow(lastSeq);
}

function twoThreeFollow(lastSeq) {
  const last5 = lastN(lastSeq, 5).join('');
  if (last5.endsWith('TTXXX')) return 'T';
  if (last5.endsWith('XXTTT')) return 'X';
  return twoTwoFollow(lastSeq);
}

function threeThreeFollow(lastSeq) {
  const last6 = lastN(lastSeq, 6).join('');
  if (last6.endsWith('TTTXXX')) return 'T';
  if (last6.endsWith('XXXTTT')) return 'X';
  return threeTwoFollow(lastSeq);
}

function fibFollow(lastSeq) {
  const lengths = [1, 1, 2, 3, 5];
  let pos = 0;
  for (let len of lengths) {
    pos += len;
    if (pos > lastSeq.length) break;
  }
  return lastSeq[lastSeq.length - 1] === 'T' ? 'X' : 'T';
}

function detectDominantBridge(hist, window = 50) {
  const rs = lastN(hist.map(h => h.ket_qua), window);
  let maxCount = 0;
  let dominant = null;
  let explain = [];
  for (const [key, info] of Object.entries(BRIDGE_TYPES)) {
    const pat = info.pattern;
    const count = countPattern(rs, pat.split(''));
    if (count > maxCount) {
      maxCount = count;
      dominant = key;
      explain = [`Phát hiện cầu ${info.desc} lặp ${count} lần`];
    }
  }
  if (maxCount < 1) return { type: null, follow: null, conf: 0.5, why: ["Không phát hiện cầu rõ"] };
  const info = BRIDGE_TYPES[dominant];
  const pred = typeof info.follow === 'function' ? info.follow(rs) : info.follow;
  const conf = 0.6 + Math.min(0.3, maxCount * 0.05);
  return { type: dominant, pred, conf, why: explain };
}

function bridgeBasedPrediction(hist) {
  const det = detectDominantBridge(hist, 30);
  if (!det.type) {
    return { pred: "T", conf: 0.5, why: det.why };
  }
  let why = det.why;
  why.push(`Theo cầu ${det.type} → ${det.pred}`);
  if (det.type.includes('bet')) {
    why.push("Cầu bệt → theo tiếp streak");
  } else if (det.type === '1-1') {
    why.push("Cầu 1-1 → đảo chiều");
  }
  return { pred: det.pred, conf: det.conf, why };
}

// ---------------------- LAYER 0: LOAD & SHAPE ----------------------
function shapeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(r => r && r.Phien != null && r.Ket_qua != null)
    .map(r => ({
      phien: Number(r.Phien),
      dice: [Number(r.Xuc_xac_1), Number(r.Xuc_xac_2), Number(r.Xuc_xac_3)],
      tong: Number(r.Tong),
      ket_qua: normResult(r.Ket_qua),
      raw: r,
    }))
    .filter(r => r.ket_qua === "T" || r.ket_qua === "X")
    .sort((a, b) => a.phien - b.phien);
}

// ---------------------- LAYER 1: RULES (Heuristic) ----------------------
function rulesPrediction(hist) {
  const results = hist.map(h => h.ket_qua);
  const totals = hist.map(h => h.tong);
  const last = results[results.length - 1];
  const last3 = lastN(results, 3);
  const last5 = lastN(results, 5);
  const last10 = lastN(results, 10);
  const last20 = lastN(results, 20);
  const last5total = lastN(totals, 5);
  const last10total = lastN(totals, 10);
  const last20total = lastN(totals, 20);

  let explain = [];
  let score = { T: 0, X: 0 };

  // Basic frequency rules
  if (last10.filter(r => r === "T").length >= 7) {
    score.T += 5;
    explain.push("10 phiên gần nhất nghiêng Tài cực mạnh");
  }
  if (last10.filter(r => r === "X").length >= 7) {
    score.X += 5;
    explain.push("10 phiên gần nhất nghiêng Xỉu cực mạnh");
  }
  if (last5.filter(r => r === "T").length >= 4) {
    score.T += 4;
    explain.push("5 phiên gần nhất nghiêng Tài mạnh");
  }
  if (last5.filter(r => r === "X").length >= 4) {
    score.X += 4;
    explain.push("5 phiên gần nhất nghiêng Xỉu mạnh");
  }

  // Streak rules
  if (last3.length === 3 && last3.every(r => r === "T")) {
    score.X += 3.5;
    explain.push("3 Tài liên tiếp → đảo Xỉu mạnh");
  }
  if (last3.length === 3 && last3.every(r => r === "X")) {
    score.T += 3.5;
    explain.push("3 Xỉu liên tiếp → đảo Tài mạnh");
  }

  // Zigzag for 1-1
  const zigzag5 = last5.length === 5 && last5.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag5) {
    const pred = last === "T" ? "X" : "T";
    score[pred] += 3;
    explain.push("Cầu zigzag 5 phiên rõ ràng (1-1) → lặp tiếp");
  }

  const avg20 = avg(last20total);
  if (avg20 >= 11.5) {
    score.T += 4;
    explain.push("Trung bình tổng 20 phiên cao (≥11.5) → Tài mạnh");
  } else if (avg20 <= 9.5) {
    score.X += 4;
    explain.push("Trung bình tổng 20 phiên thấp (≤9.5) → Xỉu mạnh");
  }

  const avg10 = avg(last10total);
  if (avg10 >= 11.5) {
    score.T += 3.5;
    explain.push("Trung bình tổng 10 phiên cao (≥11.5) → Tài mạnh");
  } else if (avg10 <= 9.5) {
    score.X += 3.5;
    explain.push("Trung bình tổng 10 phiên thấp (≤9.5) → Xỉu mạnh");
  }
  
  // Parity rules
  const parity10 = lastN(totals, 10).length ? lastN(totals, 10).filter(t => t % 2 === 0).length / lastN(totals, 10).length : 0;
  if (parity10 >= 0.7) {
    score.X += 2.5;
    explain.push("Tỷ lệ chẵn cao trong 10 phiên → Xỉu bias");
  } else if (parity10 <= 0.3) {
    score.T += 2.5;
    explain.push("Tỷ lệ lẻ cao trong 10 phiên → Tài bias");
  }

  const s = streakOfEnd(results);
  if (s >= 5 && s < 8) {
    const opp = last === "T" ? "X" : "T";
    score[opp] += 4;
    explain.push(`Chuỗi ${s} → đảo chiều mạnh`);
  }
  if (s >= 8 && s < 12) {
    score[last] += 3;
    explain.push(`Chuỗi dài ${s} → theo chiều bệt`);
  }

  let pred = null;
  let conf = 0.7;
  if (score.T > score.X + 3) {
    pred = "T";
    conf = 0.75 + Math.min(0.2, (score.T - score.X) * 0.05);
    explain.push("Score nghiêng Tài mạnh");
  } else if (score.X > score.T + 3) {
    pred = "X";
    conf = 0.75 + Math.min(0.2, (score.X - score.T) * 0.05);
    explain.push("Score nghiêng Xỉu mạnh");
  } else {
    pred = last === "T" ? "X" : "T";
    conf = 0.65;
    explain.push("Không nghiêng rõ → đảo chiều default");
  }

  return { pred, conf: Math.min(0.98, conf), why: explain };
}

// ---------------------- LAYER 2: MODEL-BASED ----------------------
function markovPrediction(hist) {
  const rs = hist.map(h => h.ket_qua);
  const use = lastN(rs, 300);
  let tt = 1, tx = 1, xt = 1, xx = 1;
  for (let i = 1; i < use.length; i++) {
    const prev = use[i - 1];
    const cur = use[i];
    if (prev === "T" && cur === "T") tt++;
    if (prev === "T" && cur === "X") tx++;
    if (prev === "X" && cur === "T") xt++;
    if (prev === "X" && cur === "X") xx++;
  }
  const last = use.length ? use[use.length - 1] : null;
  let pT = 0.5, pX = 0.5, why = [];
  if (last === "T") {
    const s = tt + tx; pT = tt / s; pX = tx / s;
  } else if (last === "X") {
    const s = xt + xx; pT = xt / s; pX = xx / s;
  } else {
    return { pred: "T", conf: 0.5, why: ["Không đủ dữ liệu cho Markov"] };
  }
  const pred = pT >= pX ? "T" : "X";
  const conf = Math.max(pT, pX) + 0.1;
  why.push(`Markov dự đoán P(T)=${pT.toFixed(2)}`);
  return { pred, conf: Math.min(0.98, 0.65 + (conf - 0.5) * 0.8), why, pT, pX };
}

function recentPatternPrediction(hist) {
  const rs = hist.map(h => h.ket_qua);
  const use = lastN(rs, 50);
  let why = [];

  const patCounts = (len) => {
    const o = {};
    for (let i = 0; i <= use.length - len; i++) {
      const k = use.slice(i, i + len).join("");
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  };

  const pat5Counts = patCounts(5);
  const pat4Counts = patCounts(4);
  const pat3Counts = patCounts(3);
  function bestEntry(obj) {
    const ent = Object.entries(obj);
    if (!ent.length) return null;
    return ent.sort((a, b) => b[1] - a[1])[0];
  }

  const b5 = bestEntry(pat5Counts);
  const b4 = bestEntry(pat4Counts);
  const b3 = bestEntry(pat3Counts);
  let pred = null;
  let conf = 0.6;
  if (b5 && b5[1] >= 2) {
    const patt = b5[0]; pred = patt[patt.length - 1]; conf = 0.8 + Math.min(0.15, (b5[1] - 2) * 0.05); why.push(`Pattern 5 lặp: ${patt} x${b5[1]}`);
  } else if (b4 && b4[1] >= 3) {
    const patt = b4[0]; pred = patt[patt.length - 1]; conf = 0.75 + Math.min(0.12, (b4[1] - 3) * 0.04); why.push(`Pattern 4 lặp: ${patt} x${b4[1]}`);
  } else if (b3 && b3[1] >= 5) {
    const patt = b3[0]; pred = patt[patt.length - 1]; conf = 0.72 + Math.min(0.1, (b3[1] - 5) * 0.03); why.push(`Pattern 3 lặp: ${patt} x${b3[1]}`);
  } else {
    const weights = use.map((_, i) => Math.pow(1.3, i));
    const tScore = use.reduce((s, v, i) => s + (v === "T" ? weights[i] : 0), 0);
    const xScore = use.reduce((s, v, i) => s + (v === "X" ? weights[i] : 0), 0);
    pred = tScore >= xScore ? "T" : "X";
    const dom = Math.abs(tScore - xScore) / (tScore + xScore || 1);
    conf = 0.65 + Math.min(0.3, dom * 0.9);
    why.push("Trọng số gần đây nghiêng " + (pred === "T" ? "Tài" : "Xỉu"));
  }
  return { pred, conf, why };
}

function breakStreakFilter(hist) {
  const rs = hist.map(h => h.ket_qua);
  const s = streakOfEnd(rs);
  const cur = rs[rs.length - 1];
  let breakProb = 0;
  if (s >= 12) breakProb = 0.9;
  else if (s >= 10) breakProb = 0.85;
  else if (s >= 8) breakProb = 0.8;
  else if (s >= 6) breakProb = 0.75;
  else if (s >= 4) breakProb = 0.65;
  else if (s >= 3) breakProb = 0.6;
  else breakProb = 0.5;

  if (breakProb >= 0.65) {
    const pred = cur === "T" ? "X" : "T";
    return {
      pred,
      conf: Math.min(0.98, breakProb + 0.1),
      why: [`Chuỗi ${s} → xác suất bẻ cầu ${Math.round(breakProb * 100)}%`],
    };
  }
  return {
    pred: cur,
    conf: 0.65 + (1 - breakProb),
    why: [`Chuỗi ${s} chưa đủ để bẻ → theo cầu bệt`],
  };
}

// ---------------------- ENSEMBLE ----------------------
function ensemblePredict(hist) {
  if (!hist || hist.length < 15) {
    return { pred: hist && hist.length ? hist[hist.length - 1].ket_qua : "T", conf: 0.6, why: ["Không đủ dữ liệu, fallback"] };
  }
  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);
  const r5 = bridgeBasedPrediction(hist);

  const votes = [
    { p: r1.pred, c: r1.conf, why: r1.why || [] },
    { p: r2.pred, c: r2.conf, why: r2.why || [] },
    { p: r3.pred, c: r3.conf, why: r3.why || [] },
    { p: r4.pred, c: r4.conf, why: r4.why || [] },
    { p: r5.pred, c: r5.conf, why: r5.why || [] },
  ];

  const scoreT = sum(votes.map(v => v.p === 'T' ? v.c : 0));
  const scoreX = sum(votes.map(v => v.p === 'X' ? v.c : 0));
  const pred = scoreT >= scoreX ? 'T' : 'X';
  const rawConf = Math.max(scoreT, scoreX) / (scoreT + scoreX || 1);
  const agree = votes.filter(v => v.p === pred).length / votes.length;
  const conf = Math.min(0.99, 0.65 + (rawConf - 0.5) * 0.8 + agree * 0.2);
  const why = votes.filter(v => v.p === pred).flatMap(v => v.why).concat([`Đồng thuận ${Math.round(agree*100)}%`]);

  return { pred, conf, why, pieces: { votes } };
}

// ---------------------- BACKTEST + KELLY ----------------------
function overallBacktest(hist, lookback = 300) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 30) return { acc: 0, sample: n, bankroll: null, roi: 0, maxDrawdown: 0, details: [] };
  let correct = 0;
  let bankroll = 1000;
  let peak = bankroll;
  let maxDrawdown = 0;
  for (let i = hist.length - 1 - n; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const res = ensemblePredict(past);
    const actualNext = hist[i + 1].ket_qua;
    if (res.pred === actualNext) {
      correct++;
    }
  }
  const acc = correct / n;
  return { acc, sample: n, bankroll, maxDrawdown, details: [] };
}

function kellyBetSize(confidence, payout = 0.95, bankroll = 1000, baseUnit = 1) {
  const p = Math.max(0.01, Math.min(0.99, confidence));
  const b = payout;
  const q = 1 - p;
  const k = (b * p - q) / b;
  if (k <= 0) return baseUnit;
  const frac = Math.min(0.2, k);
  return Math.max(1, Math.round(bankroll * frac));
}

// ---------------------- RISK LEVEL ----------------------
function riskLevel(conf, hist) {
  const rs = hist.map(h => h.ket_qua);
  const last30 = lastN(rs, 30);
  let switches = 0;
  for (let i = 1; i < last30.length; i++) {
    if (last30[i] !== last30[i - 1]) switches++;
  }
  const switchRate_ = last30.length > 1 ? switches / (last30.length - 1) : 0;
  const s = streakOfEnd(rs);
  const ent = entropy(lastN(rs, 30));

  let risk = 1 - conf;
  risk += switchRate_ * 0.25;
  if (s >= 8) risk += 0.15;
  if (ent > 0.95) risk += 0.2;

  if (risk <= 0.25) return "Rất Thấp";
  if (risk <= 0.35) return "Thấp";
  if (risk <= 0.5) return "Trung bình";
  if (risk <= 0.65) return "Cao";
  return "Rất Cao";
}

// ---------------------- API ROUTES ----------------------
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/du-doan", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const last = hist[hist.length - 1];
    const { pred, conf, why } = ensemblePredict(hist);
    const bt = overallBacktest(hist, 300);
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
    };

    res.json(out);
  } catch (e) {
    console.error("Lỗi API du-doan:", e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/du-doan/full", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const detail = [];
    const start = Math.max(10, hist.length - 50);
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
    const bt = overallBacktest(hist, 500);

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
      },
      chi_tiet_50_phien_gan: detail,
    });
  } catch (e) {
    console.error("Lỗi API du-doan/full:", e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/backtest", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });
    const lookback = Math.min(Number(req.query.lookback) || 500, hist.length - 1);
    const bt = overallBacktest(hist, lookback);
    res.json({
      lookback,
      acc: Math.round((bt.acc || 0) * 10000) / 100,
      sample: bt.sample,
    });
  } catch (e) {
    console.error("Lỗi API backtest:", e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/bridge", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });
    const det = detectDominantBridge(hist, 50);
    res.json({
      dominant_bridge: det.type ? BRIDGE_TYPES[det.type].desc : "Không rõ",
      pred_based_on_bridge: det.pred === "T" ? "Tài" : "Xỉu",
      conf: Math.round(det.conf * 100) + "%",
      why: det.why
    });
  } catch (e) {
    console.error("Lỗi API bridge:", e && e.message);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Ultimate VIP Predictor running at http://localhost:${PORT}`);
});
