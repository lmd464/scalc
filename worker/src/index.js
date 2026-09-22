// 물타기 계산기 - AI 기술적분석 서버리스 함수 (Cloudflare Workers)
//
// 역할:
//   1. 프론트(index.html)에서 종목 티커를 받음
//   2. Yahoo Finance 공개 API에서 일봉 시세를 가져와 RSI/이동평균/MACD/볼린저밴드 계산
//   3. 계산된 지표를 Claude API에 보내 해석/코멘트를 받음
//   4. 결과를 JSON으로 프론트에 반환
//
// 비밀값(ANTHROPIC_API_KEY)은 Cloudflare 대시보드의 Worker 환경변수(Secret)로만 저장하고,
// 이 소스 코드나 프론트엔드에는 절대 넣지 않습니다.

const ALLOWED_ORIGIN = 'https://lmd464.github.io';
const DAILY_LIMIT = 30; // 하루 최대 분석 요청 수 (비용 보호용 상한선)
const MODEL = 'claude-opus-5';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST 요청만 허용됩니다.' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '잘못된 요청 형식입니다.' }, 400, origin);
    }

    const ticker = (body.ticker || '').trim().toUpperCase();
    if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      return json({ error: '유효한 종목 코드를 입력하세요. (예: SOXL)' }, 400, origin);
    }

    // ---- 일일 호출 한도 체크 (KV 바인딩이 없으면 한도 체크를 건너뜀) ----
    const capKey = `calls:${new Date().toISOString().slice(0, 10)}`;
    if (env.RATE_KV) {
      const countStr = await env.RATE_KV.get(capKey);
      const count = countStr ? parseInt(countStr, 10) : 0;
      if (count >= DAILY_LIMIT) {
        return json({ error: `오늘 분석 요청 한도(${DAILY_LIMIT}회)를 초과했습니다. 내일 다시 시도해주세요.` }, 429, origin);
      }
    }

    try {
      const candles = await fetchDailyCandles(ticker);
      if (!candles || candles.closes.length < 30) {
        return json({ error: `'${ticker}' 시세 데이터를 충분히 가져오지 못했습니다.` }, 502, origin);
      }
      const indicators = computeIndicators(candles);
      const analysis = await askClaude(env.ANTHROPIC_API_KEY, ticker, indicators);

      if (env.RATE_KV) {
        const countStr = await env.RATE_KV.get(capKey);
        const count = countStr ? parseInt(countStr, 10) : 0;
        await env.RATE_KV.put(capKey, String(count + 1), { expirationTtl: 60 * 60 * 26 });
      }

      return json({ ticker, indicators, analysis }, 200, origin);
    } catch (e) {
      return json({ error: e.message || '분석 중 오류가 발생했습니다.' }, 500, origin);
    }
  }
};

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

// ---- 시세 조회 (Yahoo Finance 공개 차트 API, 키 불필요) ----
async function fetchDailyCandles(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; watering-calc/1.0)' } });
  if (!res.ok) throw new Error('시세 조회 실패');
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(`'${ticker}' 종목을 찾을 수 없습니다.`);
  const q = result.indicators.quote[0];
  const closes = [], highs = [], lows = [];
  for (let i = 0; i < q.close.length; i++) {
    if (q.close[i] == null) continue;
    closes.push(q.close[i]);
    highs.push(q.high[i]);
    lows.push(q.low[i]);
  }
  return { closes, highs, lows };
}

// ---- 보조지표 계산 ----
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// values 배열과 같은 길이의 배열을 반환 (앞부분은 undefined)
function emaSeries(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdSeries = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] !== undefined && ema26[i] !== undefined) macdSeries.push(ema12[i] - ema26[i]);
  }
  const signalSeries = emaSeries(macdSeries, 9);
  if (!signalSeries) return null;
  const line = macdSeries[macdSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { line, signal, histogram: line - signal };
}

function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, mid: mean, lower: mean - mult * std };
}

function round(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function computeIndicators(candles) {
  const { closes, highs, lows } = candles;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const m = macd(closes);
  const bb = bollinger(closes);
  const window52w = Math.min(closes.length, 252);

  return {
    currentPrice: round(last),
    changePct: round(((last - prev) / prev) * 100),
    sma20: round(sma(closes, 20)),
    sma50: round(sma(closes, 50)),
    sma200: round(sma(closes, 200)),
    rsi14: round(rsi(closes, 14), 1),
    macd: m ? { line: round(m.line, 4), signal: round(m.signal, 4), histogram: round(m.histogram, 4) } : null,
    bollinger: bb ? { upper: round(bb.upper), mid: round(bb.mid), lower: round(bb.lower) } : null,
    high52w: round(Math.max(...highs.slice(-window52w))),
    low52w: round(Math.min(...lows.slice(-window52w)))
  };
}

// ---- Claude API 호출 ----
async function askClaude(apiKey, ticker, ind) {
  if (!apiKey) throw new Error('서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다.');

  const prompt = `다음은 ${ticker}의 최신 기술적 지표입니다 (일봉 기준):

현재가: $${ind.currentPrice} (전일대비 ${ind.changePct}%)
20일 이동평균(SMA20): ${ind.sma20 !== null ? '$' + ind.sma20 : '데이터 부족'}
50일 이동평균(SMA50): ${ind.sma50 !== null ? '$' + ind.sma50 : '데이터 부족'}
200일 이동평균(SMA200): ${ind.sma200 !== null ? '$' + ind.sma200 : '데이터 부족'}
RSI(14): ${ind.rsi14 !== null ? ind.rsi14 : '데이터 부족'}
MACD: ${ind.macd ? `라인 ${ind.macd.line} / 시그널 ${ind.macd.signal} / 히스토그램 ${ind.macd.histogram}` : '데이터 부족'}
볼린저밴드(20,2): ${ind.bollinger ? `상단 $${ind.bollinger.upper} / 중간 $${ind.bollinger.mid} / 하단 $${ind.bollinger.lower}` : '데이터 부족'}
52주 최고: $${ind.high52w} / 52주 최저: $${ind.low52w}

위 지표들만 근거로 짧게 분석해줘. 형식:
1. 한 줄 요약 (강세/약세/중립 중 하나를 명시)
2. 근거 2~3개 (지표 기반으로 구체적으로)
3. 주의할 점 1개

마지막 줄에 "이것은 투자 조언이 아니라 지표에 대한 기계적 해석입니다."라고 반드시 명시해줘.
전체 300자 이내, 한국어로 답해.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API 오류 (${res.status}): ${errText.slice(0, 150)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '분석 결과를 받지 못했습니다.';
}
