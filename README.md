# ddak 모바일 실험 (M0)

[ddak](https://github.com/madsys11/ddak)의 모바일 연결 계획(`docs/mobile-plan.md`)을 실기기에서 먼저 확인하는 실험용 저장소다.
실제 앱 코드가 아니며, 실험이 끝나면 보관(archive)한다.

- 화면: GitHub Pages의 정적 PWA (`index.html`, `app.js`, `sw.js`)
- 맥 쪽: `server/spike-server.mjs` — 127.0.0.1에서만 듣고 `tailscale serve`가 tailnet HTTPS로 내준다

## 실행 (맥)

```sh
cd server && npm ci
node spike-server.mjs          # 페어링 코드가 출력된다
tailscale serve --bg 47811     # https://<맥 이름>.<tailnet>.ts.net → 127.0.0.1:47811
```

토큰·푸시 구독·기록은 저장소가 아니라 `~/.ddak-mobile-spike/`에 둔다.

## 보는 것

계획서 M0의 1~7: 고정 출처에서 각 맥 API를 CORS로 부르기(Chrome 로컬 네트워크 접근 권한 포함), 맥 하나가 꺼졌을 때,
폰이 만든 VAPID 키로 Web Push, `Tailscale-User-Login` 헤더, fetch 스트림 SSE 재연결, 페어링 흐름.
