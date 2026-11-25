/* ============================================================
   접월당 蝶月堂 — 주문 데이터 어댑터 (index.html · admin.html 공용)
   ------------------------------------------------------------
   ▶ 저장소 우선순위
     1) Supabase  : JWD_CFG.SUPABASE_URL + SUPABASE_ANON_KEY 가 채워져 있으면 실서버 모드
     2) REST API  : JWD_CFG.API_URL 이 채워져 있으면 기존 커스텀 API 모드
     3) localStorage : 아무것도 없으면 브라우저 저장소(jwd_orders_v1) — 예비/오프라인

   ▶ Supabase 모드
     - 테이블: public.orders
       (id, created_at, status, history, is_test, items, total_amount,
        payment_method, customer, births, memo, agreed)
     - 주문 생성(손님, anon): POST /rest/v1/orders  · Prefer: return=minimal
       (anon 롤은 INSERT 만 허용 — SELECT 불가이므로 return=minimal 필수)
     - 조회/수정/삭제(관리자, authenticated): Authorization: Bearer <access_token>
     - 관리자 로그인: Supabase Auth 이메일 + 비밀번호 (/auth/v1/token?grant_type=password)
   ============================================================ */
window.JWD_CFG = {
  // ★ 실서버(Supabase) — 이 두 값만 채우면 스토어·관리자센터가 함께 서버 모드로 바뀝니다.
  SUPABASE_URL: 'https://oxolhemvfmjabcxmxeuh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94b2xoZW12Zm1qYWJjeG14ZXVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMDg4NDcsImV4cCI6MjExMDg4NDg0N30.AnlFaWE5U5rp-xDO8xKAQ6TlMNxMoezlotqj7ZReWZI',

  API_URL: '',                    // (예비) 커스텀 REST API 주소
  ORDERS_KEY: 'jwd_orders_v1',    // localStorage 키 (관리자센터와 공유)
  SESSION_KEY: 'jwd_sb_session',  // Supabase Auth 세션 저장 키
  STATUSES: ['입금대기', '입금확인', '제작·분석중', '발송완료', '취소·환불'],
};

window.JWDOrders = (function () {
  const cfg = () => window.JWD_CFG;
  const key = () => cfg().ORDERS_KEY || 'jwd_orders_v1';

  const sbUrl = () => String((cfg().SUPABASE_URL || '')).replace(/\/+$/, '');
  const sbKey = () => String(cfg().SUPABASE_ANON_KEY || '').trim();
  const isSb = () => !!(sbUrl() && sbKey());
  const isApi = () => !!(cfg().API_URL && String(cfg().API_URL).trim());

  /* ---------- localStorage ---------- */
  function read() {
    try {
      const arr = JSON.parse(localStorage.getItem(key()) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('[JWDOrders] 저장소를 읽지 못했습니다.', e);
      return [];
    }
  }
  function write(list) {
    try {
      localStorage.setItem(key(), JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('jwd:orders-changed', { detail: { count: list.length } }));
      return true;
    } catch (e) {
      console.warn('[JWDOrders] 저장소에 쓰지 못했습니다.', e);
      return false;
    }
  }

  /* ---------- 세션 (Supabase Auth) ---------- */
  function readSession() {
    try {
      const s = JSON.parse(localStorage.getItem(cfg().SESSION_KEY || 'jwd_sb_session') || 'null');
      return s && s.access_token ? s : null;
    } catch (e) { return null; }
  }
  function writeSession(s) {
    try {
      if (s) localStorage.setItem(cfg().SESSION_KEY || 'jwd_sb_session', JSON.stringify(s));
      else localStorage.removeItem(cfg().SESSION_KEY || 'jwd_sb_session');
    } catch (e) { /* 저장 실패는 무시(탭 세션으로만 동작) */ }
  }
  function withExpiry(tok) {
    if (!tok) return null;
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || '',
      expires_at: Date.now() + (Number(tok.expires_in || 3600) - 30) * 1000,
      user: tok.user ? { id: tok.user.id, email: tok.user.email } : null,
    };
  }
  async function sbAuth(path, body, token) {
    const res = await fetch(sbUrl() + '/auth/v1/' + path, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', apikey: sbKey() },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error_description || data.msg || data.error || ('Auth ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data.error_code || data.error || '';
      throw err;
    }
    return data;
  }
  let refreshing = null;
  async function currentToken() {
    let s = readSession();
    if (!s) return null;
    if (!s.expires_at || s.expires_at > Date.now()) return s.access_token;
    if (!s.refresh_token) { writeSession(null); return null; }
    if (!refreshing) {
      refreshing = sbAuth('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
        .then(tok => { const ns = withExpiry(tok); writeSession(ns); return ns ? ns.access_token : null; })
        .catch(e => { console.warn('[JWDOrders] 세션 갱신 실패', e); writeSession(null); return null; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  /* ---------- 레코드 <-> DB 행 ---------- */
  function toRow(o) {
    const row = {
      id: o.id || o.no,
      status: o.status || '입금대기',
      history: o.history || [{ status: o.status || '입금대기', at: o.orderedAt || new Date().toISOString() }],
      is_test: !!(o.test || o.is_test),
      items: o.items || [],
      total_amount: Number(o.total != null ? o.total : o.total_amount) || 0,
      payment_method: o.payMethod || o.payment_method || '계좌이체',
      customer: o.customer || {},
      births: o.births || [],
      memo: o.memo || '',
      agreed: o.agree !== false && o.agreed !== false,
    };
    if (o.orderedAt || o.created_at) row.created_at = o.orderedAt || o.created_at;
    return row;
  }
  function fromRow(r) {
    const births = Array.isArray(r.births) ? r.births : [];
    return {
      id: r.id,
      no: r.id,
      orderedAt: r.created_at,
      createdAt: r.created_at,
      status: r.status,
      history: Array.isArray(r.history) ? r.history : [],
      test: !!r.is_test,
      items: Array.isArray(r.items) ? r.items : [],
      total: Number(r.total_amount) || 0,
      payMethod: r.payment_method || '계좌이체',
      customer: r.customer || {},
      births,
      hasBirth: births.length > 0,
      persons: births.reduce((m, b) => Math.max(m, Number(b.persons) || 0), 0),
      memo: r.memo || '',
      source: 'server',
      agree: r.agreed !== false,
    };
  }

  /* ---------- REST ---------- */
  async function sbFetch(path, opt) {
    const token = await currentToken();
    const req = Object.assign({}, opt || {});
    req.headers = Object.assign({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: sbKey(),
      Authorization: 'Bearer ' + (token || sbKey()),
    }, (opt && opt.headers) || {});
    const res = await fetch(sbUrl() + '/rest/v1/' + path, req);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error('Supabase ' + res.status + ' ' + res.statusText + (body ? ' · ' + body.slice(0, 200) : ''));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const txt = await res.text().catch(() => '');
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  /* ---------- 예비 커스텀 REST ---------- */
  async function apiCall(path, opt) {
    const base = String(cfg().API_URL).replace(/\/+$/, '');
    const res = await fetch(base + (path || ''), Object.assign({
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, opt || {}));
    if (!res.ok) throw new Error('API ' + res.status + ' ' + res.statusText);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  return {
    mode() { return isSb() ? 'supabase' : (isApi() ? 'api' : 'local'); },

    /* ----- 인증 ----- */
    hasSession() { return !!readSession(); },
    sessionUser() { const s = readSession(); return s ? s.user : null; },

    /* ----- 저수준 REST (상품 후기 product_reviews 등 다른 테이블에서 함께 사용) ----- */
    async token() { return currentToken(); },
    async rest(path, opt) { return sbFetch(path, opt); },

    async signIn(email, password) {
      if (!isSb()) throw new Error('Supabase 설정(SUPABASE_URL / SUPABASE_ANON_KEY)이 비어 있습니다.');
      const tok = await sbAuth('token?grant_type=password', { email: email, password: password });
      const s = withExpiry(tok);
      writeSession(s);
      return s;
    },
    async signOut() {
      const s = readSession();
      writeSession(null);
      if (isSb() && s && s.access_token) {
        try { await sbAuth('logout', null, s.access_token); } catch (e) { /* 무시 */ }
      }
      return true;
    },

    /* ----- 주문 ----- */
    async all() {
      if (isSb()) {
        const rows = await sbFetch('orders?select=*&order=created_at.desc');
        return Array.isArray(rows) ? rows.map(fromRow) : [];
      }
      if (isApi()) {
        const d = await apiCall('');
        return Array.isArray(d) ? d : (d && Array.isArray(d.orders) ? d.orders : []);
      }
      return read();
    },

    async get(id) {
      if (isSb()) {
        const rows = await sbFetch('orders?id=eq.' + encodeURIComponent(id) + '&select=*');
        return rows && rows.length ? fromRow(rows[0]) : null;
      }
      const list = await this.all();
      return list.find(o => o.id === id) || null;
    },

    async create(order) {
      if (isSb()) {
        /* Prefer: return=minimal — anon 롤이 SELECT 권한 없이도 INSERT 가 통과합니다. */
        await sbFetch('orders', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(toRow(order)),
        });
        return order;
      }
      if (isApi()) { await apiCall('', { method: 'POST', body: JSON.stringify(order) }); return order; }
      const list = read();
      if (list.some(o => o.id === order.id)) return order;   // 같은 주문번호 중복 방지
      list.unshift(order);
      write(list);
      return order;
    },

    async patch(id, fields) {
      if (isSb()) {
        const row = {};
        if (fields.status !== undefined) row.status = fields.status;
        if (fields.history !== undefined) row.history = fields.history;
        if (fields.memo !== undefined) row.memo = fields.memo;
        if (fields.is_test !== undefined) row.is_test = !!fields.is_test;
        if (fields.items !== undefined) row.items = fields.items;
        if (fields.customer !== undefined) row.customer = fields.customer;
        if (fields.births !== undefined) row.births = fields.births;
        if (fields.total !== undefined) row.total_amount = Number(fields.total) || 0;
        if (fields.payMethod !== undefined) row.payment_method = fields.payMethod;
        if (fields.agree !== undefined) row.agreed = !!fields.agree;
        await sbFetch('orders?id=eq.' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        return fields;
      }
      if (isApi()) {
        await apiCall('/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(fields) });
        return fields;
      }
      const list = read();
      const i = list.findIndex(o => o.id === id);
      if (i < 0) return null;
      list[i] = Object.assign({}, list[i], fields, { updatedAt: new Date().toISOString() });
      write(list);
      return list[i];
    },

    async remove(id) {
      if (isSb()) {
        await sbFetch('orders?id=eq.' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        });
        return true;
      }
      if (isApi()) {
        await apiCall('/' + encodeURIComponent(id), { method: 'DELETE' });
        return true;
      }
      const list = read().filter(o => o.id !== id);
      write(list);
      return true;
    },

    async replace(list) {
      if (isSb() || isApi()) throw new Error('서버 모드에서는 전체 교체를 지원하지 않습니다.');
      return write(list);
    },
  };
})();
