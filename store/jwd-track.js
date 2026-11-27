/* ============================================================
   접월당 蝶月堂 — 방문·클릭 통계 수집 (경량 / 의존성 없음)
   ------------------------------------------------------------
   ▶ 하는 일
     · 페이지를 열면 pageview 1건
     · 상품 상세 모달을 열면 product_view
     · 장바구니/신청서에 담으면 cart_add
     · 결제·신청을 시작하면 checkout_start
     → Supabase public.site_events 에 INSERT 만 합니다(anon 롤, SELECT 불가).

   ▶ 유입 경로 (UTM)
     주소에 utm_source · utm_medium · utm_campaign 이 있으면 80자까지 다듬어
     sessionStorage(jwd_utm)에 담아 두고, 같은 탭에서 페이지를 옮겨 다니거나
     상품·장바구니·결제 이벤트를 보내도 그 UTM 이 함께 기록됩니다.
     새 UTM 주소로 다시 들어오면 그 값으로 갱신됩니다.

   ▶ 집계에서 빠지는 경우 (본인·봇 자동 제외)
     1) localStorage.jwd_notrack === '1'   ← 관리자센터를 연 기기, 토글 OFF/ON
     2) 주소에 ?notrack=1 로 들어온 경우     ← 저장해 두고 이 기기는 계속 제외
     3) navigator.webdriver === true        ← 자동화 브라우저

   ▶ 사용법 (페이지마다 아래 한 줄)
     <script src="/store/jwd-track.js" defer></script>
     JWDTRACK.view('saju1') · JWDTRACK.add('saju1') · JWDTRACK.checkout('saju1')
     (상품명은 아래 표에서 자동으로 붙습니다. 필요하면 두 번째 인자로 덮어쓸 수 있습니다.)
   ============================================================ */
(function () {
  'use strict';

  var SB_URL = 'https://oxolhemvfmjabcxmxeuh.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94b2xoZW12Zm1qYWJjeG14ZXVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMDg4NDcsImV4cCI6MjExMDg4NDg0N30.AnlFaWE5U5rp-xDO8xKAQ6TlMNxMoezlotqj7ZReWZI';
  var VID_KEY = 'jwd_vid';            // 순방문자 식별자 (localStorage)
  var OFF_KEY = 'jwd_notrack';        // '1' 이면 이 기기는 집계 제외
  var SEED_KEY = 'jwd_notrack_seeded';
  var UTM_KEY = 'jwd_utm';            // 유입 경로 (sessionStorage · 탭마다)
  var UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign'];
  var UTM_MAX = 80;

  /* 상품명 표 — 페이지가 이름을 넘기지 않아도 상품별 집계가 같은 이름으로 묶이도록 */
  var NAMES = {
    'saju1': '종합 사주분석지 · 1인',
    'saju2': '종합 사주분석지 · 2인',
    'new2027': '2027 정미년 신년운세',
    'ziwei1': '자미두수 명반 정밀 분석지 · 1인',
    'ziwei2': '자미두수 명반 정밀 분석지 · 2인',
    'diary-basic': '2027 사주 개운 굿노트 다이어리 · 기본형',
    'diary-saju': '2027 사주 개운 굿노트 다이어리 · 원국 기입형',
    'diary-premium': '2027 사주 굿노트 다이어리 · 프리미엄 맞춤 일진형',
    'name-read': '정통 사주 기반 이름 감명',
    'name-adult': '사주 맞춤 성인 개명 작명',
    'name-baby': '사주 용신 맞춤 신생아 작명',
    'name-shop': '대표자 사주·업종 맞춤 사업 상호 작명',
    'date-pick': '개업·이사·결혼·계약 정통 길일 택일',
    'tal-wish': '기원부적 (인쇄용 PDF)',
    'tal-custom': '나만의 부적 (사주 맞춤)',
    'wall-ohaeng': '2027 오행 개운 스마트폰 배경화면',
    'wall-zodiac-minhwa': '2027 나비 쫓는 12지신 민화 스마트폰 배경화면',
    'wall-zodiac-night': '2027 달빛 아래 나비 12지신 스마트폰 배경화면',
    'wall-zodiac-watercolor': '2027 수채화 밤·달빛 12지신 스마트폰 배경화면'
  };

  function ls(fn) { try { return fn(localStorage); } catch (e) { return null; } }
  function ss(fn) { try { return fn(sessionStorage); } catch (e) { return null; } }
  function cut(s, n) { return s == null ? null : String(s).slice(0, n); }

  /* ---------- 유입 경로(UTM) ----------
     주소에 UTM 이 있으면 이번 유입으로 보고 sessionStorage 를 새로 채운다.
     없으면 같은 탭에서 받아 둔 값을 그대로 이어 쓴다. */
  function utmFromUrl() {
    try {
      var q = new URLSearchParams(location.search);
      var out = {}, has = false;
      for (var i = 0; i < UTM_PARAMS.length; i++) {
        var v = q.get(UTM_PARAMS[i]);
        v = v == null ? '' : v.trim();
        if (v) { out[UTM_PARAMS[i]] = cut(v, UTM_MAX); has = true; }
      }
      return has ? out : null;
    } catch (e) { return null; }
  }

  function utmStored() {
    var raw = ss(function (s) { return s.getItem(UTM_KEY); });
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  function utm() {
    var fresh = utmFromUrl();
    if (fresh) { ss(function (s) { s.setItem(UTM_KEY, JSON.stringify(fresh)); }); return fresh; }
    return utmStored();
  }

  function excluded() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('notrack') === '1') { ls(function (s) { s.setItem(OFF_KEY, '1'); }); return true; }
    } catch (e) { /* URLSearchParams 없는 아주 오래된 브라우저는 무시 */ }
    if (navigator.webdriver) return true;
    if (ls(function (s) { return s.getItem(OFF_KEY); }) === '1') return true;
    return false;
  }

  function visitorId() {
    var v = ls(function (s) { return s.getItem(VID_KEY); });
    if (v && typeof v === 'string') return v;
    v = 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    ls(function (s) { s.setItem(VID_KEY, v); });
    return v;
  }

  function send(type, pid, pname) {
    if (excluded()) return false;
    var u = utm() || {};
    var body = {
      visitor_id: visitorId(),
      event_type: type,
      page_path: cut(location.pathname, 120),
      product_id: pid ? cut(pid, 80) : null,
      product_name: pid ? cut(pname || NAMES[pid] || pid, 160) : null,
      referrer: cut(document.referrer || '', 300) || null,
      utm_source: u.utm_source || null,
      utm_medium: u.utm_medium || null,
      utm_campaign: u.utm_campaign || null
    };
    try {
      fetch(SB_URL + '/rest/v1/site_events', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: SB_KEY,
          Authorization: 'Bearer ' + SB_KEY,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(body)
      })['catch'](function () { /* 전송 실패는 방문자에게 알리지 않음 */ });
      return true;
    } catch (e) {
      return false;
    }
  }

  window.JWDTRACK = {
    track: function (type, pid, pname) { return send(type, pid, pname); },
    view: function (pid, pname) { return send('product_view', pid, pname); },
    add: function (pid, pname) { return send('cart_add', pid, pname); },
    checkout: function (pid, pname) { return send('checkout_start', pid, pname); },
    name: function (pid) { return NAMES[pid] || pid; },
    excluded: excluded,
    utm: utm,
    /* 관리자센터 첫 방문 시 자사몰 전체에서 이 기기를 제외 */
    seedOff: function () {
      var done = ls(function (s) { return s.getItem(SEED_KEY); });
      if (done === '1') return;
      ls(function (s) { s.setItem(OFF_KEY, '1'); s.setItem(SEED_KEY, '1'); });
    }
  };

  /* ---------- 페이지뷰 ---------- */
  function pageview() { send('pageview'); }
  if (document.readyState === 'complete') pageview();
  else window.addEventListener('load', pageview);
})();
