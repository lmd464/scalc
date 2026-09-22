# AI 기술적분석 서버리스 함수

물타기 계산기 앱이 종목의 RSI/이동평균/MACD/볼린저밴드를 계산해서 Claude에게 해석을 요청하는
Cloudflare Worker입니다. `ANTHROPIC_API_KEY`를 안전하게 보관하기 위해, 이 코드는 앱과 별도로
Cloudflare에 배포해야 합니다.

## 1. 준비물

- Cloudflare 계정 (무료, [dash.cloudflare.com](https://dash.cloudflare.com)에서 가입)
- Anthropic API 키 ([console.anthropic.com](https://console.anthropic.com)에서 발급)
  - **주의**: 발급받은 키를 Claude와의 채팅에 붙여넣지 마세요. 아래 3번 단계에서 Cloudflare
    대시보드나 터미널에 직접 입력해야 합니다.

## 2. 배포

```bash
cd worker
npm install -g wrangler   # 이미 설치되어 있으면 생략
wrangler login            # 브라우저가 열리며 Cloudflare 계정 로그인
wrangler deploy
```

배포가 끝나면 `https://watering-calc-ai.<your-subdomain>.workers.dev` 형태의 URL이 출력됩니다.
이 URL을 복사해두세요 — 앱의 "연동설정"에 입력해야 합니다.

## 3. API 키 등록 (Secret)

```bash
wrangler secret put ANTHROPIC_API_KEY
```

프롬프트가 뜨면 Anthropic 콘솔에서 발급받은 키(`sk-ant-...`)를 붙여넣고 엔터. 이 값은
Cloudflare 서버에만 암호화 저장되고, 소스코드나 배포 결과물 어디에도 노출되지 않습니다.

## 4. (선택) 하루 호출 한도 설정 — 비용 보호

누군가 Worker 주소를 알아내서 무제한으로 요청하면 Anthropic API 비용이 계속 발생할 수 있습니다.
아래를 설정하면 하루 30회(코드에서 `DAILY_LIMIT` 값 수정 가능)로 자동 제한됩니다.

```bash
wrangler kv namespace create RATE_KV
```

출력된 `id` 값을 `wrangler.toml`의 주석 처리된 `[[kv_namespaces]]` 블록에 채우고 주석을
해제한 뒤, 다시 `wrangler deploy`를 실행하세요.

## 5. 앱에 연결

`https://lmd464.github.io/scalc/` 접속 → 포트폴리오 카드의 "⚙ 연동설정"에 2번 단계에서
받은 Worker URL을 입력하고 저장하면, "AI 기술적분석" 버튼이 활성화됩니다.

## 동작 방식 요약

1. 앱이 Worker에 `{ ticker: "SOXL" }`을 POST
2. Worker가 Yahoo Finance 공개 API(키 불필요)에서 최근 1년 일봉 시세를 가져옴
3. RSI(14), SMA(20/50/200), MACD(12,26,9), 볼린저밴드(20,2), 52주 고저를 계산
4. 계산된 숫자를 Claude API(`claude-opus-5`)에 보내 3줄 요약 분석을 요청
5. 결과를 JSON으로 앱에 반환 → 화면에 표시

시세/지표 계산은 전부 Worker 안에서 결정론적으로 처리되고, Claude는 이미 계산된 숫자를
**해석만** 합니다 (계산 자체를 Claude에게 맡기지 않음 — 더 저렴하고 정확함).
