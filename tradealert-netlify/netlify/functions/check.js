const axios  = require("axios");
const admin  = require("firebase-admin");

// ── Firebase init (runs once per cold start) ──────────────────────────────
let firebaseReady = false;
function initFirebase() {
  if (firebaseReady) return;
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "tradealert-2602c" });
    firebaseReady = true;
    console.log("Firebase initialized");
  } catch (e) {
    // Already initialized on warm start
    firebaseReady = true;
  }
}

const db        = () => admin.firestore();
const messaging = () => admin.messaging();

// ── Binance price fetchers ────────────────────────────────────────────────
// Netlify servers are in EU — Binance NOT blocked here!

async function getBinanceSpotPrice(symbol) {
  try {
    const r = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const p = parseFloat(r.data?.price) || 0;
    if (p > 0) { console.log(`  [Binance Spot] ${symbol} = ${p}`); return p; }
  } catch (e) { console.log(`  Binance spot failed ${symbol}: ${e.message}`); }
  return 0;
}

async function getBinanceFuturesPrice(symbol) {
  try {
    const r = await axios.get(
      `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const p = parseFloat(r.data?.price) || 0;
    if (p > 0) { console.log(`  [Binance Futures] ${symbol} = ${p}`); return p; }
  } catch (e) { console.log(`  Binance futures failed ${symbol}: ${e.message}`); }
  // Fallback to spot
  return getBinanceSpotPrice(symbol);
}

async function getBinanceKlines(symbol, interval, isFutures = false) {
  const base = isFutures
    ? "https://fapi.binance.com/fapi/v1/klines"
    : "https://api.binance.com/api/v3/klines";
  try {
    const r = await axios.get(base, {
      params: { symbol, interval, limit: 3 },
      timeout: 6000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (r.data?.length >= 2) {
      console.log(`  [Binance klines] ${symbol} ${interval} OK`);
      return r.data;
    }
  } catch (e) { console.log(`  Binance klines failed ${symbol}: ${e.message}`); }
  return null;
}

// ── TwelveData for Forex ──────────────────────────────────────────────────
const TD_KEY = "99b51c33d39e42b0bde39e5162a70976";
async function getTwelveDataPrice(symbol) {
  try {
    const r = await axios.get(
      `https://api.twelvedata.com/price?apikey=${TD_KEY}&symbol=${symbol}`,
      { timeout: 5000 }
    );
    return parseFloat(r.data?.price) || 0;
  } catch (e) { return 0; }
}
async function getTwelveDataLastClose(symbol, timeframe) {
  const intervalMap = { M1:"1min", M5:"5min", M15:"15min", H1:"1h" };
  try {
    const r = await axios.get(
      `https://api.twelvedata.com/time_series?apikey=${TD_KEY}&symbol=${symbol}&interval=${intervalMap[timeframe]||"5min"}&outputsize=3`,
      { timeout: 8000 }
    );
    const values = r.data?.values;
    if (values?.length >= 2) {
      const close = parseFloat(values[1]?.close) || 0;
      console.log(`    [TwelveData candle] ${symbol} [${timeframe}] = ${close}`);
      return close;
    }
  } catch (e) { console.log(`    TwelveData candle failed: ${e.message}`); }
  return 0;
}

// ── Yahoo Finance for Indices ─────────────────────────────────────────────
async function getYahooPrice(yahooSymbol) {
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`,
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0)" } }
    );
    return parseFloat(r.data?.chart?.result?.[0]?.meta?.regularMarketPrice) || 0;
  } catch (e) { return 0; }
}
async function getYahooLastClose(ySymbol, timeframe) {
  const yInterval = { M1:"1m", M5:"5m", M15:"15m", H1:"60m" }[timeframe] || "5m";
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=2d`,
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0)" } }
    );
    const result = r.data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    const times  = result?.timestamp;
    if (!closes || !times) return 0;
    const nowSec    = Date.now() / 1000;
    const candleSec = getCandleMs(timeframe) / 1000;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] + candleSec <= nowSec && closes[i] != null) {
        console.log(`    [Yahoo candle] ${ySymbol} [${timeframe}] = ${closes[i]}`);
        return closes[i];
      }
    }
  } catch (e) { console.log(`    Yahoo candle failed: ${e.message}`); }
  return 0;
}

// ── Symbol maps ───────────────────────────────────────────────────────────
const CRYPTO_MAP = {
  BTC:"BTCUSDT", ETH:"ETHUSDT", BNB:"BNBUSDT", SOL:"SOLUSDT",
  XRP:"XRPUSDT", ADA:"ADAUSDT", DOGE:"DOGEUSDT", AVAX:"AVAXUSDT",
  DOT:"DOTUSDT", MATIC:"MATICUSDT", LINK:"LINKUSDT", UNI:"UNIUSDT",
  ATOM:"ATOMUSDT", LTC:"LTCUSDT", BCH:"BCHUSDT", NEAR:"NEARUSDT",
  ARB:"ARBUSDT", OP:"OPUSDT", SHIB:"SHIBUSDT", TRX:"TRXUSDT"
};
const METAL_MAP  = { XAU:"XAUUSDT", XAG:"XAGUSDT" };
const FOREX_MAP  = {
  EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY",
  GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDGBP:"USD/GBP"
};
const INDEX_MAP  = {
  SPX500:"%5EGSPC", US30:"%5EDJI", US100:"%5EIXIC",
  DXY:"DX-Y.NYB", NIF50:"%5ENSEI"
};

async function fetchInstantPrice(pairSymbol) {
  if (CRYPTO_MAP[pairSymbol])  return getBinanceSpotPrice(CRYPTO_MAP[pairSymbol]);
  if (METAL_MAP[pairSymbol])   return getBinanceFuturesPrice(METAL_MAP[pairSymbol]);
  if (FOREX_MAP[pairSymbol])   return getTwelveDataPrice(FOREX_MAP[pairSymbol]);
  if (INDEX_MAP[pairSymbol])   return getYahooPrice(INDEX_MAP[pairSymbol]);
  return 0;
}

async function fetchCandleClose(pairSymbol, timeframe) {
  if (CRYPTO_MAP[pairSymbol]) {
    const klines = await getBinanceKlines(CRYPTO_MAP[pairSymbol],
      getCandleInterval(timeframe), false);
    if (klines) {
      const close = parseFloat(klines[klines.length - 2][4]);
      console.log(`    [Binance candle] ${pairSymbol} [${timeframe}] = ${close}`);
      return close;
    }
  }
  if (METAL_MAP[pairSymbol]) {
    const klines = await getBinanceKlines(METAL_MAP[pairSymbol],
      getCandleInterval(timeframe), true);
    if (klines) {
      const close = parseFloat(klines[klines.length - 2][4]);
      console.log(`    [Binance futures candle] ${pairSymbol} [${timeframe}] = ${close}`);
      return close;
    }
    // Fallback spot
    const sk = await getBinanceKlines(METAL_MAP[pairSymbol], getCandleInterval(timeframe), false);
    if (sk) return parseFloat(sk[sk.length - 2][4]);
  }
  if (FOREX_MAP[pairSymbol])  return getTwelveDataLastClose(FOREX_MAP[pairSymbol], timeframe);
  if (INDEX_MAP[pairSymbol])  return getYahooLastClose(INDEX_MAP[pairSymbol], timeframe);
  return 0;
}

// ── FCM sender ────────────────────────────────────────────────────────────
async function sendFCM(fcmToken, alert, price) {
  const hitType = alert.candleClose
    ? `Candle Close · ${alert.timeframe}` : "Instant Hit";
  const msg = {
    token: fcmToken,
    data: {
      type:"PRICE_ALERT", alertId:String(alert.id),
      pairSymbol:String(alert.pairSymbol||""),
      pairName:String(alert.pairName||""),
      pairEmoji:String(alert.pairEmoji||""),
      targetPrice:String(alert.targetPrice),
      currentPrice:String(price),
      direction:String(alert.direction||""),
      hitType, isAlarm:String(alert.alarm!==false),
      isSoundEnabled:String(alert.soundEnabled!==false),
      isVibration:String(alert.vibrationEnabled!==false),
    },
    android: { priority:"high" },
  };
  const resp = await messaging().send(msg);
  console.log(`  ✅ FCM sent: ${resp}`);
}

async function triggerAlert(alert, price) {
  console.log(`  🎯 HIT: ${alert.pairSymbol} price=${price} target=${alert.targetPrice}`);
  try {
    await db().collection("alerts").doc(alert.id)
      .update({ triggered:true, hitAt:Date.now(), hitPrice:price });
    let token = null;
    const uDoc = await db().collection("users").doc(alert.userId).get();
    if (uDoc.exists) { token = uDoc.data().fcmToken; }
    else {
      const all = await db().collection("users").limit(1).get();
      if (!all.empty) token = all.docs[0].data().fcmToken;
    }
    if (!token) { console.log(`  ❌ No FCM token`); return; }
    await sendFCM(token, alert, price);
  } catch (e) { console.error(`  ❌ triggerAlert: ${e.message}`); }
}

// ── Main check ────────────────────────────────────────────────────────────
async function checkAlerts() {
  const now   = new Date();
  const nowMs = now.getTime();
  console.log(`\n========== CHECK ${now.toISOString()} ==========`);

  const snapshot = await db().collection("alerts")
    .where("triggered","==",false).get();
  if (snapshot.empty) { console.log("No active alerts."); return; }
  console.log(`Found ${snapshot.size} active alert(s)`);

  const instant = [], candle = [];
  snapshot.forEach(doc => {
    const a = { id:doc.id, ...doc.data() };
    const t = a.candleClose ? `candle_${a.timeframe}` : "instant";
    console.log(`  ${a.pairSymbol} target=${a.targetPrice} dir=${a.direction} type=${t}`);
    if (a.candleClose) candle.push(a); else instant.push(a);
  });

  // Instant alerts
  const byPair = {};
  for (const a of instant) {
    if (!byPair[a.pairSymbol]) byPair[a.pairSymbol] = [];
    byPair[a.pairSymbol].push(a);
  }
  for (const [pair, alerts] of Object.entries(byPair)) {
    const price = await fetchInstantPrice(pair);
    console.log(`  [Instant] ${pair} = ${price}`);
    if (!price) continue;
    for (const a of alerts) {
      const hit = a.direction==="above" ? price>=a.targetPrice : price<=a.targetPrice;
      console.log(`    hit=${hit} price=${price} target=${a.targetPrice}`);
      if (hit) await triggerAlert(a, price);
    }
  }

  // Candle close alerts — only fire within 90s of candle boundary
  const byPairTF = {};
  for (const a of candle) {
    const key = `${a.pairSymbol}_${a.timeframe}`;
    if (!byPairTF[key]) byPairTF[key] = [];
    byPairTF[key].push(a);
  }
  for (const [key, alerts] of Object.entries(byPairTF)) {
    const [pair, tf] = key.split("_");
    const candleMs   = getCandleMs(tf);
    const secAfter   = (nowMs - Math.floor(nowMs/candleMs)*candleMs) / 1000;
    console.log(`  [Candle ${tf}] ${pair}: ${secAfter.toFixed(0)}s after boundary`);
    if (secAfter > 90) { console.log(`    ⏳ skip`); continue; }
    const close = await fetchCandleClose(pair, tf);
    console.log(`    close=${close}`);
    if (!close) continue;
    for (const a of alerts) {
      const hit = a.direction==="above" ? close>=a.targetPrice : close<=a.targetPrice;
      console.log(`    hit=${hit} close=${close} target=${a.targetPrice}`);
      if (hit) await triggerAlert(a, close);
    }
  }
  console.log(`========== DONE ==========\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getCandleMs(tf) {
  return { M1:60000, M5:300000, M15:900000, H1:3600000 }[tf] || 300000;
}
function getCandleInterval(tf) {
  return { M1:"1m", M5:"5m", M15:"15m", H1:"1h" }[tf] || "5m";
}

// ── Netlify Function handler ──────────────────────────────────────────────
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    initFirebase();
    await checkAlerts();
    return { statusCode:200, body: JSON.stringify({ ok:true, time:new Date().toISOString() }) };
  } catch (err) {
    console.error("Handler error:", err.message);
    return { statusCode:500, body: JSON.stringify({ error:err.message }) };
  }
};
