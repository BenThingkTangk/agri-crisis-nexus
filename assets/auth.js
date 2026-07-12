/* ============================================================
   AgriOS · account authentication (client)
   Server-validated sign-in for Nirmata Holdings operators.

   The session token lives ONLY in this module's memory and is replayed
   via the Authorization: Bearer header. Nothing is written to
   localStorage / sessionStorage / cookies / IndexedDB, so a page reload
   requires signing in again. Passwords are never stored, prefilled,
   logged, or placed in a URL. This is separate from the outer access
   gate and from the DB-backed team collaboration layer.
   ============================================================ */
(function () {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  // In-memory session only. Cleared on reload, logout, or expiry.
  var state = { token: null, user: null, expiresAt: null };
  var expiryTimer = null;
  var listeners = [];
  var lastFocus = null;

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](getSession()); } catch (e) { /* isolate subscribers */ }
    }
  }

  function getSession() {
    if (!state.token || !state.user) return null;
    return { user: { email: state.user.email, name: state.user.name, role: state.user.role }, expiresAt: state.expiresAt };
  }
  function isAuthed() { return !!(state.token && state.user); }
  function getRole() { return state.user ? state.user.role : null; }
  function isOwner() { return getRole() === 'owner'; }
  function authHeader() { return state.token ? { Authorization: 'Bearer ' + state.token } : {}; }

  // fetch wrapper that injects the bearer header and force-signs-out on 401.
  function authFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {}, authHeader());
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401 && isAuthed()) { clearSession('Your session ended. Please sign in again.'); }
      return r;
    });
  }

  function scheduleExpiry() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    if (!state.expiresAt) return;
    var ms = new Date(state.expiresAt).getTime() - Date.now();
    if (!isFinite(ms)) return;
    if (ms <= 0) { clearSession('Your session expired. Please sign in again.'); return; }
    // setTimeout caps around ~24.8 days; our sessions are <=12h so this is safe.
    expiryTimer = setTimeout(function () { clearSession('Your session expired. Please sign in again.'); }, ms);
  }

  function setSession(data) {
    state.token = data.token;
    state.user = data.user;
    state.expiresAt = data.expiresAt || null;
    scheduleExpiry();
    updateIdentityUI();
    notify();
  }

  function clearSession(message) {
    var had = isAuthed();
    state.token = null; state.user = null; state.expiresAt = null;
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    updateIdentityUI();
    notify();
    if (had && message) { renderView('login'); setStatus(message, 'err'); }
  }

  // ---- identity button (topbar) --------------------------------------------
  function updateIdentityUI() {
    var label = $('#identityLabel');
    var btn = $('#identityBtn');
    if (label) {
      if (isAuthed()) {
        label.innerHTML = esc(state.user.name) + '<span class="role-tag">' + esc(state.user.role) + '</span>';
      } else {
        label.textContent = 'Sign in';
      }
    }
    if (btn) btn.setAttribute('aria-label', isAuthed() ? 'Account menu' : 'Sign in');
  }

  // ---- modal dialog --------------------------------------------------------
  var overlay = null, dialog = null, statusEl = null, currentView = null;

  function ensureModal() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'acct-overlay';
    overlay.setAttribute('data-testid', 'account-overlay');
    overlay.hidden = true;
    dialog = document.createElement('div');
    dialog.className = 'acct-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'acctTitle');
    dialog.setAttribute('data-testid', 'account-dialog');
    if (REDUCED) dialog.classList.add('no-anim');
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') trapTab(e);
    });
  }

  function focusables() {
    return Array.prototype.slice.call(
      dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')
    ).filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
  }
  function trapTab(e) {
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'acct-status ' + (kind === 'err' ? 'is-err' : kind === 'ok' ? 'is-ok' : '');
  }

  function renderView(view) {
    ensureModal();
    currentView = view;
    if (view === 'account' && isAuthed()) renderAccount();
    else renderLogin();
  }

  function renderLogin() {
    dialog.innerHTML =
      '<div class="acct-head">' +
        '<h2 id="acctTitle" class="acct-title">Sign in to AgriOS</h2>' +
        '<button type="button" class="acct-x" data-testid="account-close" aria-label="Close sign-in">&times;</button>' +
      '</div>' +
      '<form class="acct-form" data-testid="account-login-form" novalidate autocomplete="off">' +
        '<div class="field">' +
          '<label for="acctEmail">Email</label>' +
          '<input id="acctEmail" name="email" type="email" inputmode="email" autocomplete="username" ' +
            'autocapitalize="none" spellcheck="false" required data-testid="account-email" />' +
        '</div>' +
        '<div class="field">' +
          '<label for="acctPassword">Password</label>' +
          '<div class="acct-pw">' +
            '<input id="acctPassword" name="password" type="password" autocomplete="current-password" ' +
              'required data-testid="account-password" />' +
            '<button type="button" class="acct-pw-toggle" data-testid="account-pw-toggle" ' +
              'aria-label="Show password" aria-pressed="false">Show</button>' +
          '</div>' +
        '</div>' +
        '<p class="acct-status" role="alert" aria-live="assertive" data-testid="account-error"></p>' +
        '<button type="submit" class="btn primary acct-submit" data-testid="account-submit">Sign in</button>' +
        '<p class="acct-hint">Nirmata Holdings operators only. This is separate from the platform access code.</p>' +
      '</form>';
    statusEl = $('.acct-status', dialog);

    var form = $('.acct-form', dialog);
    var pw = $('#acctPassword', dialog);
    var toggle = $('.acct-pw-toggle', dialog);
    var submit = $('.acct-submit', dialog);
    $('.acct-x', dialog).addEventListener('click', close);
    toggle.addEventListener('click', function () {
      var show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      pw.focus();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submitLogin(form, submit);
    });
    setTimeout(function () { var em = $('#acctEmail', dialog); if (em) em.focus(); }, 30);
  }

  function submitLogin(form, submit) {
    var email = String(form.email.value || '').trim().toLowerCase();
    var password = String(form.password.value || '');
    if (!email || !password) { setStatus('Enter your email and password.', 'err'); return; }
    submit.disabled = true;
    var prev = submit.textContent;
    submit.textContent = 'Signing in…';
    submit.classList.add('is-loading');
    setStatus('', '');

    fetch('/api/account?action=login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
    }).then(function (res) {
      var r = res.r, j = res.j;
      // Never retain the password beyond this point.
      try { form.password.value = ''; } catch (e) {}
      if (r.ok && j && j.token && j.user) {
        setSession({ token: j.token, user: j.user, expiresAt: j.expiresAt });
        renderAccount();
        return;
      }
      if (r.status === 429) {
        var ra = r.headers.get('Retry-After');
        var secs = ra ? parseInt(ra, 10) : 0;
        setStatus(secs > 0
          ? 'Too many attempts. Try again in about ' + secs + 's.'
          : 'Too many attempts. Please wait a moment and try again.', 'err');
      } else if (r.status === 503) {
        setStatus('Sign-in is temporarily unavailable. Please try again later.', 'err');
      } else {
        setStatus('Incorrect email or password.', 'err');
      }
    }).catch(function () {
      setStatus('Network error. Please try again.', 'err');
    }).then(function () {
      submit.disabled = false;
      submit.textContent = prev;
      submit.classList.remove('is-loading');
    });
  }

  function renderAccount() {
    ensureModal();
    var u = state.user || {};
    dialog.innerHTML =
      '<div class="acct-head">' +
        '<h2 id="acctTitle" class="acct-title">Account</h2>' +
        '<button type="button" class="acct-x" data-testid="account-close" aria-label="Close account">&times;</button>' +
      '</div>' +
      '<div class="acct-identity" data-testid="account-identity">' +
        '<div class="acct-avatar" aria-hidden="true">' + esc((u.name || '?').slice(0, 1).toUpperCase()) + '</div>' +
        '<div class="acct-who">' +
          '<div class="acct-name" data-testid="account-name">' + esc(u.name || '') + '</div>' +
          '<div class="acct-email" data-testid="account-email-display">' + esc(u.email || '') + '</div>' +
          '<div class="acct-role"><span class="role-tag" data-testid="account-role">' + esc(u.role || '') + '</span>' +
            (u.role === 'owner' ? ' · high-impact actions enabled' : ' · standard access') + '</div>' +
        '</div>' +
      '</div>' +
      '<p class="acct-status" role="status" aria-live="polite"></p>' +
      '<button type="button" class="btn acct-signout" data-testid="account-signout">Sign out</button>';
    statusEl = $('.acct-status', dialog);
    $('.acct-x', dialog).addEventListener('click', close);
    $('.acct-signout', dialog).addEventListener('click', function () { doSignOut(); });
    setTimeout(function () { var b = $('.acct-signout', dialog); if (b) b.focus(); }, 30);
  }

  function doSignOut() {
    var token = state.token;
    // Best-effort server revoke; client memory clear is authoritative.
    if (token) {
      fetch('/api/account?action=logout', { method: 'POST', headers: authHeader() }).catch(function () {});
    }
    clearSession();
    close();
  }

  function open() {
    ensureModal();
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add('acct-open');
    renderView(isAuthed() ? 'account' : 'login');
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('acct-open');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function onChange(cb) { if (typeof cb === 'function') { listeners.push(cb); cb(getSession()); } }

  window.AGRIOS_AUTH = {
    open: open,
    close: close,
    signOut: doSignOut,
    getSession: getSession,
    isAuthed: isAuthed,
    getRole: getRole,
    isOwner: isOwner,
    authHeader: authHeader,
    authFetch: authFetch,
    onChange: onChange,
  };
})();
