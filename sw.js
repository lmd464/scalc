// 크롬이 "설치 가능한 PWA"로 인식하려면 최소한의 서비스 워커가 필요합니다.
// 오프라인 캐싱 없이, 등록만 되는 최소 버전입니다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // 네트워크 요청 그대로 통과
