require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const PORT = process.env.PORT || 3000;
const SOURCE_URL =
  process.env.SOURCE_URL || "https://fullsrc-daynesun.onrender.com/api/taixiu/history";

const app = express();
app.use(cors());
app.use(express.json());

/* =======================
 * Utils & Normalizers
 * ======================= */
function txFromResultOrTotal(result, total) {
  if (result != null) {
    const s = String(result).trim().toLowerCase();
    if (["t", "tai", "tài"].includes(s)) return "T";
    if (["x", "xiu", "xỉu"].includes(s)) return "X";
    const n = parseInt(s, 10);
    if (!Number.isNaN(n)) return n >= 11 ? "T" : "X";
  }
  if (typeof total === "number" && Number.isFinite(total)) {
    return total >= 11 ? "T" : "X";
  }
  return null;
}

function normalizeRow(row) {
  const session = Number(
    row.session ?? row.phien ?? row.sid ?? row.SID ?? row.Phien ?? null
  );

  let dice =
    row.dice ??
    row.xuc_xac ??
    row.Xuc_xac ??
    (row.Xuc_xac_1 && row.Xuc_xac_2 && row.Xuc_xac_3
      ? `${row.Xuc_xac_1}-${row.Xuc_xac_2}-${row.Xuc_xac_3}`
      : null);

  if (Array.isArray(dice)) dice = dice.join("-");
  if (typeof dice === "string") dice = dice.replace(/[,\s]+/g, "-");

  const total = Number(
    row.total ?? row.tong ?? row.Tong ?? row.sum ?? row.Sum ?? null
  );

  const resultRaw =
    row.result ?? row.ket_qua ?? row.Ket_qua ?? row.result_text ?? null;

  const R = txFromResultOrTotal(resultRaw, total);

  return {
    session: Number.isFinite(session) ? session : null,
    dice: dice ?? null,
    total: Number.isFinite(total) ? total : null,
    R, // 'T' | 'X' | null
    rawResult: resultRaw ?? null
  };
}

function riskFromConfidence(c) {
  if (c >= 0.75) return "thấp";
  if (c >= 0.6) return "trung bình";
  return "cao";
}

function txLabel(t) {
  return t === "T" ? "Tài" : "Xỉu";
}

/* =======================
 * “Engines” mô phỏng theo spec
 * ======================= */

/** AnomalyDetectionEngine — đơn giản: phát hiện outlier tổng & lặp bất thường */
class AnomalyDetectionEngine {
  analyze(newBatch, historical) {
    const details = [];
    let count = 0;

    // Tính trung bình & độ lệch chuẩn trên lịch sử (map T=1, X=0 để làm minh họa)
    const encode = (x) => (x === "T" ? 1 : 0);
    const histEnc = historical.map(encode);
    const mean =
      histEnc.reduce((a, b) => a + b, 0) / Math.max(histEnc.length, 1);
    const sd = Math.sqrt(
      histEnc.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
        Math.max(histEnc.length, 1)
    );

    newBatch.forEach((x, i) => {
      const v = encode(x);
      const z = sd > 0 ? Math.abs((v - mean) / sd) : 0;
      if (z > 2.5) {
        count++;
        details.push({ idx: i, value: x, z });
      }
    });

    return { count, details };
  }
}

/** RealTimePatternEngine — tìm các motif gần cuối và thống kê next-step */
class RealTimePatternEngine {
  extract(batch, historical) {
    const ctxLen = Math.min(5, Math.max(2, Math.floor(historical.length / 50)));
    const ctx = [...historical.slice(-ctxLen), ...batch].slice(-ctxLen);
    if (ctx.length < 2) return { context: ctx, stats: null };

    const hist = historical.join("");
    const key = ctx.join("");
    let hitsT = 0,
      hitsX = 0;
    for (let i = 0; i + ctx.length < hist.length; i++) {
      if (hist.slice(i, i + ctx.length) === key) {
        const nxt = hist[i + ctx.length];
        if (nxt === "T") hitsT++;
        if (nxt === "X") hitsX++;
      }
    }
    const total = hitsT + hitsX;
    const pT = total > 0 ? hitsT / total : 0.5;
    return { context: ctx, stats: { hitsT, hitsX, total, pT } };
  }
}

/** WeightOptimizationEngine — nhẹ nhàng tinh chỉnh theo gần đây */
class WeightOptimizationEngine {
  calculateNewWeights(perf, oldW) {
    // Nếu 10 dự đoán gần đây tốt hơn 0.6 thì tăng nhẹ DeepSequence/Hybrid
    let sum = 0;
    Object.values(oldW).forEach((v) => (sum += v));
    const base = { ...oldW };
    if (perf.accuracy && perf.accuracy > 0.6) {
      base.deepSequenceModel += 0.02;
      base.hybridAttentionModel += 0.01;
      base.probabilisticGraphicalModel += 0.005;
      base.temporalFusionModel -= 0.015;
      base.quantumInspiredNetwork -= 0.02;
    }
    // Chuẩn hóa sum=1
    let s = 0;
    Object.values(base).forEach((v) => (s += v));
    Object.keys(base).forEach((k) => (base[k] = Math.max(0, base[k] / s)));
    return base;
  }
}

/** AdvancedTrendEngine — phân tích xu hướng: streak, alternation, distribution, totals */
class AdvancedTrendEngine {
  analyze(historical, realtime, perf) {
    const seq = [...historical, ...realtime];
    const n = seq.length;

    // streak hiện tại
    let curLen = 1;
    for (let i = n - 2; i >= 0 && seq[i] === seq[n - 1]; i--) curLen++;

    // alternation gần đây
    const altWindow = Math.min(40, n - 1);
    let flip = 0;
    for (let i = n - altWindow; i < n; i++) {
      if (i > 0 && seq[i] !== seq[i - 1]) flip++;
    }
    const altRatio = altWindow > 0 ? flip / altWindow : 0.5;

    // phân phối gần
    const win = Math.min(80, n);
    const slice = seq.slice(-win);
    const tCnt = slice.filter((x) => x === "T").length;
    const ratioT = win > 0 ? tCnt / win : 0.5;

    return {
      streakDir: seq[n - 1],
      streakLen: curLen,
      altRatio,
      ratioT,
      perfHint: perf?.accuracy ?? 0
    };
  }
}

/** SmartEnsembleEngine — trộn các xác suất thành p(T) cuối */
class SmartEnsembleEngine {
  combinePredictions(analysis, trend, weights, threshold = 0.72) {
    const clamp = (x) => Math.max(0.05, Math.min(0.95, x));
    const pT_deep = clamp(analysis.deepSequenceModel?.pT ?? 0.5);
    const pT_hatt = clamp(analysis.hybridAttentionModel?.pT ?? 0.5);
    const pT_quant = clamp(analysis.quantumInspiredNetwork?.pT ?? 0.5);
    const pT_temp = clamp(analysis.temporalFusionModel?.pT ?? 0.5);
    const pT_prob = clamp(analysis.probabilisticGraphicalModel?.pT ?? 0.5);

    const pT =
      pT_deep * (weights.deepSequenceModel ?? 0.28) +
      pT_hatt * (weights.hybridAttentionModel ?? 0.25) +
      pT_quant * (weights.quantumInspiredNetwork ?? 0.22) +
      pT_temp * (weights.temporalFusionModel ?? 0.15) +
      pT_prob * (weights.probabilisticGraphicalModel ?? 0.1);

    // confidence dựa theo |pT-0.5|, mức phủ dữ liệu (proxy), và tính ổn định trend
    const dist = Math.abs(pT - 0.5) * 2; // 0..1
    const coverage =
      (analysis.coverageMarkov ?? 0.5) * 0.35 +
      (analysis.coverageNgram ?? 0.5) * 0.25 +
      (analysis.coverageAlt ?? 0.5) * 0.15 +
      (analysis.coverageDist ?? 0.5) * 0.15 +
      (analysis.coverageTotals ?? 0.5) * 0.10;

    const stability =
      (trend.streakLen >= 3 ? 0.15 : 0) +
      (trend.altRatio > 0.55 || trend.altRatio < 0.45 ? 0.1 : 0);

    const confidence = Math.max(
      0.5,
      Math.min(0.95, 0.6 * dist + 0.3 * coverage + 0.1 * stability)
    );

    return {
      choice: pT >= 0.5 ? "T" : "X",
      pT,
      confidence,
      passedThreshold: pT >= threshold || pT <= 1 - threshold
    };
  }
}

/** PredictionStability — xem p của các mô-đun có hội tụ không */
class PredictionStability {
  assess(pred, recent) {
    if (!recent || recent.length < 3) return "initializing";
    const avgP = recent.reduce((a, b) => a + (b.pT ?? 0.5), 0) / recent.length;
    const varP =
      recent.reduce((a, b) => a + Math.pow((b.pT ?? 0.5) - avgP, 2), 0) /
      recent.length;
    return varP < 0.01 ? "stable" : "volatile";
  }
}

/** PerformanceMetricsEngine — proxy accuracy dựa backtest gần */
class PerformanceMetricsEngine {
  calculate(lastPreds) {
    // lastPreds: [{choice, real? maybe}, ...] — ở đây không có ground-truth trực tiếp ⇒ mô phỏng đơn giản
    const k = lastPreds.length;
    const acc = 0.5 + Math.min(0.15, k * 0.005); // giữ ổn định 0.5~0.65 (không ảo tưởng)
    return { accuracy: acc, precision: acc * 0.98, recall: acc * 0.98 };
  }
}

/* =======================
 * Sub-models (mô phỏng)
 * ======================= */

/** DeepSequencePredictor — n-gram tới 5, Markov 1-bước */
class DeepSequencePredictor {
  constructor() {
    this.memoryCells = [];
    this.contextSize = 5;
  }
  async train(data, lr) {
    this.memoryCells = this.memoryCells.slice(-20).concat([Date.now()]);
    return { updatedMemory: this.memoryCells };
  }
  async analyze({ historical }) {
    const seq = historical.join("");
    const n = seq.length;
    const ctxLen = Math.min(this.contextSize, Math.max(2, Math.floor(n / 80)));
    const ctx = seq.slice(-ctxLen);
    let hitsT = 0,
      hitsX = 0;
    for (let i = 0; i + ctx.length < n; i++) {
      if (seq.slice(i, i + ctx.length) === ctx) {
        const nxt = seq[i + ctx.length];
        if (nxt === "T") hitsT++;
        if (nxt === "X") hitsX++;
      }
    }
    const total = hitsT + hitsX;
    const pT = total > 0 ? hitsT / total : 0.5;

    // thêm Markov 1-bước
    let TT = 0,
      TX = 0,
      XT = 0,
      XX = 0;
    for (let i = 1; i < historical.length; i++) {
      const a = historical[i - 1],
        b = historical[i];
      if (a === "T" && b === "T") TT++;
      if (a === "T" && b === "X") TX++;
      if (a === "X" && b === "T") XT++;
      if (a === "X" && b === "X") XX++;
    }
    const last = historical[historical.length - 1];
    const pT_after_T = TT + TX > 0 ? TT / (TT + TX) : 0.5;
    const pT_after_X = XT + XX > 0 ? XT / (XT + XX) : 0.5;

    const pMarkov = last === "T" ? pT_after_T : pT_after_X;

    const pBlend = 0.6 * pT + 0.4 * pMarkov;
    return {
      pT: pBlend,
      context: ctx,
      ngramStats: { hitsT, hitsX, total },
      markov: { pT_after_T, pT_after_X },
      modelType: "deepSequence"
    };
  }
}

/** HybridAttentionPredictor — attention thời gian + attention đặc trưng */
class HybridAttentionPredictor {
  async train() {
    return {};
  }
  extractFeatures(historical) {
    const n = historical.length;
    // streak
    let len = 1;
    for (let i = n - 2; i >= 0 && historical[i] === historical[n - 1]; i--)
      len++;
    // alternation
    const W = Math.min(40, n - 1);
    let flip = 0;
    for (let i = n - W; i < n; i++) if (i > 0 && historical[i] !== historical[i - 1]) flip++;
    const altRatio = W > 0 ? flip / W : 0.5;
    // distribution
    const win = Math.min(80, n);
    const slice = historical.slice(-win);
    const tCnt = slice.filter((x) => x === "T").length;
    const ratioT = win > 0 ? tCnt / win : 0.5;
    return { streakLen: len, streakDir: historical[n - 1], altRatio, ratioT, win };
  }
  async analyze({ historical }) {
    const f = this.extractFeatures(historical);
    // attention thời gian: trọng số cao hơn cho gần đây
    // p(T) từ đặc trưng:
    let pT = 0.5;
    // streak: nếu đang Tài dài → nghiêng T; nếu Xỉu dài → nghiêng X
    if (f.streakDir === "T") pT += Math.min(0.2, f.streakLen * 0.02);
    else pT -= Math.min(0.2, f.streakLen * 0.02);

    // alternation cao → dễ đảo chiều so với phiên cuối
    if (f.altRatio > 0.55) pT += f.streakDir === "T" ? -0.08 : 0.08;
    else if (f.altRatio < 0.45) pT += f.streakDir === "T" ? 0.05 : -0.05;

    // distribution: lệch > 55% thì thiên hướng hồi quy nhẹ
    if (f.ratioT > 0.55) pT -= 0.06 * (f.ratioT - 0.55) * 10;
    if (f.ratioT < 0.45) pT += 0.06 * (0.45 - f.ratioT) * 10;

    pT = Math.max(0.05, Math.min(0.95, pT));

    return { pT, features: f, modelType: "hybridAttention" };
  }
}

/** QuantumInspiredNetwork — giao thoa giữa Momentum & Mean-reversion */
class QuantumInspiredNetwork {
  async train() {
    return {};
  }
  async analyze({ historical }) {
    const n = historical.length;
    // momentum prob ~ xác suất giữ chiều sau streak ≥ 2
    let mom = 0.5;
    if (n >= 10) {
      let keep = 0,
        tot = 0;
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && historical[j + 1] === historical[i]) j++;
        const L = j - i + 1;
        if (L >= 2 && j + 1 < n) {
          keep += historical[j + 1] === historical[i] ? 1 : 0;
          tot++;
        }
        i = j + 1;
      }
      mom = tot > 0 ? keep / tot : 0.5;
    }
    // mean-reversion prob ~ xác suất đảo chiều sau chuỗi ≥ 2
    const mr = 1 - mom;

    // pha giao thoa theo alternation gần đây
    let alt = 0.5;
    for (let i = 1; i < n; i++) alt += historical[i] !== historical[i - 1] ? 1 : 0;
    alt = n > 1 ? (alt - 0.5) / (n - 1) : 0.5; // ~ tỷ lệ flip

    const phi = (alt - 0.5) * Math.PI; // -π/2..π/2
    const pBlend = Math.max(
      0.05,
      Math.min(0.95, mom + mr + 2 * Math.sqrt(mom * mr) * Math.cos(phi) - 0.5)
    );
    // map về 0..1
    const pT =
      historical[n - 1] === "T"
        ? pBlend
        : 1 - pBlend;

    return { pT, components: { mom, mr, phi }, modelType: "quantumInspired" };
  }
}

/** TemporalFusionPredictor — gộp nhiều cửa sổ thời gian */
class TemporalFusionPredictor {
  async train() { return {}; }
  probFromWindow(seq, w) {
    if (seq.length < w + 1) return 0.5;
    const slice = seq.slice(-w);
    // đơn giản: nếu gần đây T nhiều hơn → pT tăng nhẹ
    const tCnt = slice.filter((x) => x === "T").length;
    return 0.5 + (tCnt / w - 0.5) * 0.5; // giảm biên
  }
  async analyze({ historical }) {
    const p8 = this.probFromWindow(historical, 8);
    const p20 = this.probFromWindow(historical, 20);
    const p60 = this.probFromWindow(historical, 60);
    const pT = 0.45 * p8 + 0.35 * p20 + 0.20 * p60;
    return { pT, windows: { p8, p20, p60 }, modelType: "temporalFusion" };
  }
}

/** AdvancedProbabilisticModel — Naive-Bayes nhẹ với feature discretes */
class AdvancedProbabilisticModel {
  async train() { return {}; }
  async analyze({ historical }) {
    const n = historical.length;
    const last = historical[n - 1];
    // features: lastSide, streakLen≥3, altHigh
    let streak = 1;
    for (let i = n - 2; i >= 0 && historical[i] === last; i--) streak++;
    let flip = 0;
    for (let i = 1; i < Math.min(n, 40); i++)
      if (historical[n - i] !== historical[n - i - 1]) flip++;
    const altHigh = (flip / Math.min(39, n - 1)) > 0.55;

    // Likelihoods (heuristic)
    let logOdds = 0; // log(P(T)/P(X))
    if (last === "T") logOdds += Math.log(1.05);
    else logOdds -= Math.log(1.05);
    if (streak >= 3) logOdds += last === "T" ? Math.log(1.08) : -Math.log(1.08);
    if (altHigh) logOdds += last === "T" ? -Math.log(1.12) : Math.log(1.12);

    const odds = Math.exp(logOdds);
    const pT = odds / (1 + odds);
    return { pT, features: { last, streak, altHigh }, modelType: "probGraph" };
  }
}

/* =======================
 * AdvancedTaiXiuPredictor (theo spec)
 * ======================= */
class AdvancedTaiXiuPredictor {
  constructor() {
    this.historicalData = [];
    this.realTimeData = [];
    this.metaData = { lastUpdate: null, dataQuality: 1.0, anomalyCount: 0 };

    this.models = this.initializeAdvancedModels();
    this.performanceMetrics = {
      accuracy: 0, precision: 0, recall: 0, last10Predictions: []
    };
    this.config = {
      dataWindow: 500,
      predictionThreshold: 0.72,
      adaptiveLearningRate: 0.01,
      ensembleWeights: this.calculateInitialWeights()
    };

    // engines
    this.anomalyEngine = new AnomalyDetectionEngine();
    this.patternEngine = new RealTimePatternEngine();
    this.weightEngine = new WeightOptimizationEngine();
    this.trendEngine = new AdvancedTrendEngine();
    this.ensembleEngine = new SmartEnsembleEngine();
    this.stabilityEngine = new PredictionStability();
    this.metricsEngine = new PerformanceMetricsEngine();
  }

  initializeAdvancedModels() {
    return {
      deepSequenceModel: new DeepSequencePredictor(),
      hybridAttentionModel: new HybridAttentionPredictor(),
      quantumInspiredNetwork: new QuantumInspiredNetwork(),
      temporalFusionModel: new TemporalFusionPredictor(),
      probabilisticGraphicalModel: new AdvancedProbabilisticModel()
    };
  }
  calculateInitialWeights() {
    return {
      deepSequenceModel: 0.28,
      hybridAttentionModel: 0.25,
      quantumInspiredNetwork: 0.22,
      temporalFusionModel: 0.15,
      probabilisticGraphicalModel: 0.10
    };
  }

  preprocessData(data) {
    return data
      .map((x) => (x === "T" || x === "X" ? x : null))
      .filter(Boolean);
  }

  detectAnomalies(data) {
    if (this.historicalData.length < 50) return { count: 0, details: [] };
    return this.anomalyEngine.analyze(data, this.historicalData);
  }

  updateDataQuality(anomalyReport) {
    const denom = Math.max(this.historicalData.length, 1);
    const ratio = anomalyReport.count / denom;
    this.metaData.dataQuality = Math.max(0.1, 1 - ratio * 2);
  }

  extractRealTimePatterns(data) {
    return this.patternEngine.extract(data, this.historicalData);
  }

  async adaptiveModelTraining() {
    const trainingData = {
      historical: this.historicalData,
      realTime: this.realTimeData,
      meta: this.metaData
    };
    await Promise.all(
      Object.values(this.models).map((m) =>
        m.train(trainingData, this.config.adaptiveLearningRate)
      )
    );
    // điều chỉnh trọng số
    this.config.ensembleWeights = this.weightEngine.calculateNewWeights(
      this.performanceMetrics,
      this.config.ensembleWeights
    );
  }

  async updateData(newData) {
    try {
      const processed = this.preprocessData(newData);
      const anomalyReport = this.detectAnomalies(processed);
      this.metaData.anomalyCount += anomalyReport.count;
      this.updateDataQuality(anomalyReport);

      this.historicalData = [...this.historicalData, ...processed].slice(
        -this.config.dataWindow
      );

      this.realTimeData = this.extractRealTimePatterns(processed);

      await this.adaptiveModelTraining();
      this.metaData.lastUpdate = new Date();
      return { success: true, anomalyReport };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  crossModelAnalysis(individual) {
    // độ lệch giữa mô hình
    const arr = [
      individual.deepSequenceModel?.pT ?? 0.5,
      individual.hybridAttentionModel?.pT ?? 0.5,
      individual.quantumInspiredNetwork?.pT ?? 0.5,
      individual.temporalFusionModel?.pT ?? 0.5,
      individual.probabilisticGraphicalModel?.pT ?? 0.5
    ];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const varP = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
    return { mean, varP };
  }

  async multilayerAnalysis() {
    const analysis = {};
    const promises = Object.entries(this.models).map(async ([name, model]) => {
      analysis[name] = await model.analyze({
        historical: this.historicalData,
        realTime: this.realTimeData?.context ?? []
      });
    });
    await Promise.all(promises);

    analysis.crossModel = this.crossModelAnalysis(analysis);

    // coverage proxies
    analysis.coverageMarkov = Math.min(1, this.historicalData.length / 120);
    analysis.coverageNgram = Math.min(1, this.historicalData.length / 200);
    analysis.coverageAlt = Math.min(1, this.historicalData.length / 60);
    analysis.coverageDist = Math.min(1, this.historicalData.length / 80);
    analysis.coverageTotals = 0.7; // không có totals trong class này ⇒ đặt cố định

    return analysis;
  }

  advancedTrendAnalysis() {
    return this.trendEngine.analyze(
      this.historicalData,
      this.realTimeData?.context ?? [],
      this.performanceMetrics
    );
  }

  ensemblePrediction(analysis, trend) {
    return this.ensembleEngine.combinePredictions(
      analysis,
      trend,
      this.config.ensembleWeights,
      this.config.predictionThreshold
    );
  }

  checkPredictionStability(pred) {
    return this.stabilityEngine.assess(
      pred,
      this.performanceMetrics.last10Predictions
    );
  }

  recordPredictionPerformance(pred) {
    this.performanceMetrics.last10Predictions = [
      ...this.performanceMetrics.last10Predictions.slice(-9),
      pred
    ];
    const m = this.metricsEngine.calculate(
      this.performanceMetrics.last10Predictions
    );
    this.performanceMetrics = { ...this.performanceMetrics, ...m };
  }

  async predict() {
    try {
      if (this.historicalData.length < 100)
        throw new Error("Insufficient data for reliable prediction");

      const analysis = await this.multilayerAnalysis();
      const trend = this.advancedTrendAnalysis();
      const finalPred = this.ensemblePrediction(analysis, trend);
      const stability = this.checkPredictionStability(finalPred);
      this.recordPredictionPerformance(finalPred);

      return {
        ...finalPred,
        stability,
        dataQuality: this.metaData.dataQuality,
        modelWeights: this.config.ensembleWeights,
        diagnostics: { analysis, trend }
      };
    } catch (e) {
      return { error: e.message, confidence: 0, recommendation: "No-pred" };
    }
  }
}

/* =======================
 * Fetch & Transform
 * ======================= */
async function fetchSource() {
  const res = await axios.get(SOURCE_URL, { timeout: 15000 });
  if (!Array.isArray(res.data)) throw new Error("SOURCE_URL không trả về mảng.");
  return res.data;
}

function sortAndNormalize(raw) {
  const rows = raw.map(normalizeRow).filter((r) => r.session != null);
  rows.sort((a, b) => a.session - b.session);
  return rows;
}

/* =======================
 * Explain builder cho response
 * ======================= */
function buildExplanation(pred) {
  const a = pred?.diagnostics?.analysis || {};
  const trend = pred?.diagnostics?.trend || {};
  const ds = a.deepSequenceModel || {};
  const ha = a.hybridAttentionModel || {};
  const qi = a.quantumInspiredNetwork || {};
  const tf = a.temporalFusionModel || {};
  const pg = a.probabilisticGraphicalModel || {};
  const cross = a.crossModel || {};

  return [
    `Deep-sequence: n-gram ctx="${ds.context ?? ""}", hitsT=${ds.ngramStats?.hitsT ?? 0}, hitsX=${ds.ngramStats?.hitsX ?? 0}, Markov P(T|T)=${ds.markov?.pT_after_T?.toFixed?.(2) ?? "?"}, P(T|X)=${ds.markov?.pT_after_X?.toFixed?.(2) ?? "?"}.`,
    `Hybrid-attention: streak=${ha.features?.streakLen ?? "?"} (${ha.features?.streakDir === "T" ? "Tài" : "Xỉu"}), alt=${(ha.features?.altRatio ?? 0.5).toFixed(2)}, T-ratio=${(ha.features?.ratioT ?? 0.5).toFixed(2)}.`,
    `Quantum-inspired: momentum=${qi.components?.mom?.toFixed?.(2) ?? "?"}, mean-rev=${qi.components?.mr?.toFixed?.(2) ?? "?"}, phi≈${qi.components?.phi?.toFixed?.(2) ?? "?"}.`,
    `Temporal-fusion: p8=${tf.windows?.p8?.toFixed?.(2) ?? "?"}, p20=${tf.windows?.p20?.toFixed?.(2) ?? "?"}, p60=${tf.windows?.p60?.toFixed?.(2) ?? "?"}.`,
    `Prob-graph: streak=${pg.features?.streak ?? "?"}, altHigh=${pg.features?.altHigh ?? "?"}.`,
    `Cross-model: mean pT≈${cross.mean?.toFixed?.(3) ?? "?"}, var≈${cross.varP?.toFixed?.(4) ?? "?"}.`,
    `=> Ensemble p(T)≈${pred?.pT?.toFixed?.(3) ?? "?"} ⇒ ${txLabel(pred?.choice)}.`
  ].join(" ");
}

/* =======================
 * API Routes
 * ======================= */

// Thông tin
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "TaiXiu Advanced Ensemble API",
    endpoints: [
      "/api/taixiu/history",
      "/api/taixiu/predict",        // dự đoán cho phiên kế tiếp (gắn ở dòng cuối)
      "/api/taixiu/predict/stream", // 'mỗi phiên một độ tin cậy' (rolling)
      "/api/taixiu/backtest?limit=150"
    ]
  });
});

// Lịch sử chuẩn hóa
app.get("/api/taixiu/history", async (_req, res) => {
  try {
    const raw = await fetchSource();
    const rows = sortAndNormalize(raw);
    res.json({
      count: rows.length,
      data: rows.map((r) => ({
        phien: r.session,
        xuc_xac: r.dice,
        tong: r.total,
        ket_qua: r.R ? txLabel(r.R) : null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Fetch error" });
  }
});

// Dự đoán phiên kế tiếp — gắn vào dòng cuối
app.get("/api/taixiu/predict", async (_req, res) => {
  try {
    const raw = await fetchSource();
    const rows = sortAndNormalize(raw);
    const seq = rows.map((r) => r.R).filter(Boolean);

    const predictor = new AdvancedTaiXiuPredictor();
    await predictor.updateData(seq);
    const pred = await predictor.predict();

    const out = rows.map((r) => ({
      phien: r.session,
      xuc_xac: r.dice,
      tong: r.total,
      ket_qua: r.R ? txLabel(r.R) : null,
      phien_sau: r.session + 1,
      du_doan: null,
      do_tin_cay: null,
      giai_thich: null,
      rui_ro: null
    }));

    // gắn dự đoán vào dòng cuối
    const last = out[out.length - 1];
    if (pred?.choice) {
      last.du_doan = txLabel(pred.choice);
      last.do_tin_cay = Number(((pred.confidence ?? 0.6) * 100).toFixed(1));
      last.giai_thich = buildExplanation(pred);
      last.rui_ro = riskFromConfidence(pred.confidence ?? 0.6);
    }

    res.json({
      updatedAt: new Date().toISOString(),
      count: out.length,
      data: out,
      next: {
        phien: rows[rows.length - 1]?.session + 1,
        du_doan: last.du_doan,
        do_tin_cay: last.do_tin_cay,
        giai_thich: last.giai_thich,
        rui_ro: last.rui_ro
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Predict error" });
  }
});

// Stream — “mỗi phiên một độ tin cậy” (rolling prediction cho phiên tiếp theo tại mỗi thời điểm)
app.get("/api/taixiu/predict/stream", async (req, res) => {
  try {
    const limit = Math.max(60, Math.min(400, Number(req.query.limit) || 160));
    const raw = await fetchSource();
    let rows = sortAndNormalize(raw);
    if (rows.length > limit) rows = rows.slice(-limit);

    const recs = [];
    for (let i = 0; i < rows.length; i++) {
      const seq = rows.slice(0, i + 1).map((r) => r.R).filter(Boolean);
      if (seq.length < 100) {
        recs.push({
          phien: rows[i].session,
          phien_sau: rows[i].session + 1,
          du_doan: null,
          do_tin_cay: null,
          giai_thich: "Không đủ dữ liệu (>100) để dự đoán đáng tin.",
          rui_ro: "cao"
        });
        continue;
      }
      const predictor = new AdvancedTaiXiuPredictor();
      await predictor.updateData(seq);
      const pred = await predictor.predict();
      recs.push({
        phien: rows[i].session,
        phien_sau: rows[i].session + 1,
        du_doan: txLabel(pred.choice),
        do_tin_cay: Number(((pred.confidence ?? 0.6) * 100).toFixed(1)),
        giai_thich: buildExplanation(pred),
        rui_ro: riskFromConfidence(pred.confidence ?? 0.6)
      });
    }

    res.json({ window: rows.length, data: recs });
  } catch (e) {
    res.status(500).json({ error: e.message || "Stream error" });
  }
});

// Backtest — trượt theo thời gian để ước tính độ đúng (proxy)
app.get("/api/taixiu/backtest", async (req, res) => {
  try {
    const limit = Math.max(120, Math.min(600, Number(req.query.limit) || 200));
    const raw = await fetchSource();
    let rows = sortAndNormalize(raw);
    if (rows.length > limit) rows = rows.slice(-limit);

    const seqFull = rows.map((r) => r.R).filter(Boolean);
    const recs = [];
    let correct = 0,
      totalPred = 0;

    for (let cut = 100; cut < seqFull.length - 1; cut++) {
      const seq = seqFull.slice(0, cut);
      const predictor = new AdvancedTaiXiuPredictor();
      await predictor.updateData(seq);
      const pred = await predictor.predict();
      const realNext = seqFull[cut]; // kết quả “phiên sau” tại thời điểm cut

      const ok = pred.choice === realNext;
      totalPred++;
      if (ok) correct++;

      recs.push({
        phien: rows[cut - 1].session,
        phien_sau: rows[cut - 1].session + 1,
        du_doan: txLabel(pred.choice),
        do_tin_cay: Number(((pred.confidence ?? 0.6) * 100).toFixed(1)),
        thuc_te: txLabel(realNext),
        dung_khong: ok,
        rui_ro: riskFromConfidence(pred.confidence ?? 0.6)
      });
    }

    const acc = totalPred > 0 ? Number(((correct / totalPred) * 100).toFixed(1)) : null;

    res.json({
      evaluated: totalPred,
      accuracy_percent: acc,
      data: recs
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Backtest error" });
  }
});

/* =======================
 * Start
 * ======================= */
app.listen(PORT, () => {
  console.log(`✅ TaiXiu Advanced Ensemble API running on :${PORT}`);
});
