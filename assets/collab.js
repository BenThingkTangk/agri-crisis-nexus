/* ============================================================
   AGRI-NEXUS COMMAND CENTER — collaboration layer
   Authenticated teams, persistent missions + War Room scenarios,
   role-aware member management, and near-real-time in-app alerts.

   This is an *enhancement layer*. When the backend/database is
   unavailable, every call fails soft and the base application keeps
   running on its bundled data — consistent with the ATOM/live model.
   It reaches into the base controller only through window.AGRI_APP.
   ============================================================ */
(function () {
  'use strict';

  var A = window.AGRI_APP;
  if (!A) return; // base app not present — nothing to enhance.

  var esc = A.esc, icon = A.icon;
  var REDUCED = !!A.reduced;

  /* ---------------- state ---------------- */
  var session = null;          // publicSession or null when unauthenticated
  var missionsCache = [];      // last-loaded team missions (for edit prefill)
  var alertsState = { alerts: [], unread: 0, open: 0 };
  var seenAlertIds = Object.create(null); // for arrival stagger animation
  var expandedAlerts = Object.create(null); // alert ids with explainability open
  var alertFilter = { q: '', status: 'all', basis: 'all' };
  var pollTimer = null;
  var currentDrawer = null;    // 'identity' | 'alerts' | null

  // War Room collaboration (server-backed presence + messages).
  var wrState = null;          // last /api/collab state
  var wrTimer = null;          // presence/message poll
  var wrHbTimer = null;        // heartbeat

  var ROLE_RANK = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
  function rankOf(r) { return ROLE_RANK[r] || 0; }
  function canWrite(min) { return session && rankOf(session.role) >= rankOf(min); }

  var SEV_COLOR = {
    critical: 'var(--sev-critical)',
    high: 'var(--sev-high)',
    moderate: 'var(--sev-moderate)',
  };
  var SEV_TO_PRIORITY = { critical: 'critical', high: 'high', moderate: 'medium' };

  /* ---------------- tiny utilities ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  var toastHost = null;
  function toast(msg, kind) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'collabToast';
      toastHost.setAttribute('aria-live', 'polite');
      toastHost.style.cssText =
        'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9999;' +
        'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(toastHost);
    }
    var t = document.createElement('div');
    t.setAttribute('data-testid', 'collab-toast');
    t.textContent = msg;
    t.style.cssText =
      'pointer-events:auto;max-width:min(520px,90vw);padding:10px 16px;border-radius:9px;' +
      'font:500 13px/1.4 var(--sans,system-ui);box-shadow:0 8px 30px rgba(0,0,0,.35);' +
      'border:1px solid var(--border);background:var(--surface,#1a160f);color:var(--text,#f0e9db);' +
      (kind === 'error' ? 'border-left:3px solid var(--sev-critical,#d43e28);' :
       kind === 'ok' ? 'border-left:3px solid var(--cyan,#3ca85a);' : '');
    if (!REDUCED) t.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease' });
    toastHost.appendChild(t);
    setTimeout(function () {
      if (!REDUCED) {
        var a = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease' });
        a.onfinish = function () { t.remove(); };
      } else { t.remove(); }
    }, kind === 'error' ? 5200 : 3200);
  }

  /* ---------------- fetch wrapper ---------------- */
  // Resolves to the parsed JSON on success. Throws Error(message) on failure,
  // and a special {authRequired:true} error on 401 so callers can prompt login.
  function api(path, opts) {
    opts = opts || {};
    var headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (session && session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) {
          var e = new Error(j.message || 'Sign in to continue.');
          e.authRequired = true;
          throw e;
        }
        if (!r.ok || j.ok === false) {
          throw new Error(j.message || j.error || 'Request failed. Please try again.');
        }
        return j;
      });
    });
  }

  /* ============================================================
     SESSION + IDENTITY
     ============================================================ */
  function init() {
    injectStyles();
    refreshSession().catch(function () { paintIdentity(); });
    // Pre-fill invite token banner if arriving via an invite link.
    // (Handled inside the auth form when opened.)
  }

  // Phase III presentation lives in the enhancement layer (same pattern as the
  // dynamic toast host) so the base index.html stylesheet stays untouched.
  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var css =
      '.ai-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}' +
      '.ai-badge{font:600 10px/1 var(--mono,monospace);letter-spacing:.03em;text-transform:uppercase;padding:3px 6px;border-radius:5px;border:1px solid var(--border);color:var(--muted)}' +
      '.ai-badge.modeled{border-color:var(--sev-high,#e08a1e);color:var(--sev-high,#e08a1e)}' +
      '.ai-badge.observed{border-color:var(--cyan,#3ca85a);color:var(--cyan,#3ca85a)}' +
      '.ai-badge.analyst{border-color:var(--muted)}' +
      '.ai-badge.status-escalated{border-color:var(--sev-critical,#d43e28);color:var(--sev-critical,#d43e28)}' +
      '.ai-badge.status-resolved{opacity:.6}' +
      '.ai-explain{margin-top:8px;padding:9px 11px;border:1px solid var(--border);border-left:3px solid var(--sev-high,#e08a1e);border-radius:8px;background:var(--surface,#1a160f)}' +
      '.ai-explain h5{margin:0 0 4px;font:600 11px/1.2 var(--mono,monospace);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}' +
      '.ai-explain ul{margin:0 0 8px;padding-left:16px}.ai-explain li{font-size:12px;margin:2px 0}' +
      '.ai-explain .uncert{font-size:12px;color:var(--sev-high,#e08a1e);font-style:italic}' +
      '.wr-wrap{margin-top:14px;border:1px solid var(--border);border-radius:11px;padding:12px}' +
      '.wr-head{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px}' +
      '.wr-title{font:600 13px/1 var(--sans,system-ui)}' +
      '.wr-sync{font:500 11px/1 var(--mono,monospace);color:var(--muted)}' +
      '.wr-roster{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}' +
      '.wr-member{display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border);border-radius:20px;font-size:12px}' +
      '.wr-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}' +
      '.wr-dot.online{background:var(--cyan,#3ca85a)}.wr-dot.away{background:var(--sev-high,#e08a1e)}.wr-dot.offline{background:var(--muted)}' +
      '.wr-msgs{max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:7px;margin-bottom:9px}' +
      '.wr-msg{font-size:12.5px;line-height:1.4}.wr-msg .who{font-weight:600}.wr-msg.system{color:var(--muted);font-style:italic}' +
      '.wr-msg .mention{color:var(--cyan,#3ca85a);font-weight:600}' +
      '.wr-compose{display:flex;gap:7px}.wr-compose input{flex:1;min-width:0}' +
      '@media (max-width:600px){.wr-msgs{max-height:180px}.ai-acts{flex-wrap:wrap}}';
    try {
      var st = document.createElement('style');
      st.id = 'phase3-collab-style';
      st.textContent = css;
      (document.head || document.body || document.documentElement).appendChild(st);
    } catch (_) { /* non-fatal */ }
  }

  function refreshSession() {
    return api('/api/auth?action=session')
      .then(function (j) {
        session = j.authenticated ? j.session : null;
        paintIdentity();
        if (session) startPolling(); else stopPolling();
        // Session resolves asynchronously, often *after* Command/War Room have
        // already rendered their signed-out placeholders. Re-render every
        // collaboration surface now so a restored session is reflected.
        softRefresh();
        return session;
      })
      .catch(function (err) {
        // Network/DB down: degrade to unauthenticated, keep app usable.
        session = null;
        paintIdentity();
        stopPolling();
        softRefresh();
        throw err;
      });
  }

  function paintIdentity() {
    var label = $('#identityLabel');
    var btn = $('#identityBtn');
    var bell = $('#openAlerts');
    // The env-backed account layer (assets/auth.js) owns the topbar identity
    // button/label. Don't fight it for control when it is present.
    var acctOwnsIdentity = !!window.AGRIOS_AUTH;
    if (label && !acctOwnsIdentity) {
      if (session) {
        label.innerHTML = esc(session.user.displayName) +
          '<span class="role-tag">' + esc(session.role || '') + '</span>';
      } else {
        label.textContent = 'Sign in';
      }
    }
    if (btn && !acctOwnsIdentity) btn.setAttribute('aria-label', session ? 'Account and team' : 'Sign in');
    if (bell) { bell.hidden = !session; }
    if (!session) setAlertBadge(0);
    // Reveal collaboration affordances that depend on write access.
    var nm = $('#newMissionBtn');
    if (nm) nm.hidden = !canWrite('analyst');
  }

  /* ============================================================
     IDENTITY DRAWER (auth / account / teams / members)
     ============================================================ */
  function openIdentity() {
    currentDrawer = 'identity';
    if (session) renderAccountDrawer();
    else renderAuthDrawer('login');
  }

  function drawerBody() { return $('#drawerBody'); }

  // ---- unauthenticated: login / register ----
  function renderAuthDrawer(tab) {
    var inviteFromUrl = new URLSearchParams(location.search).get('invite') || '';
    var isReg = tab === 'register';
    var html =
      '<div class="tabbar" style="display:flex;gap:6px;margin-bottom:14px">' +
        '<button class="btn sm ' + (!isReg ? 'primary' : '') + '" data-testid="auth-tab-login" data-tab="login">Sign in</button>' +
        '<button class="btn sm ' + (isReg ? 'primary' : '') + '" data-testid="auth-tab-register" data-tab="register">Create account</button>' +
      '</div>' +
      '<form class="auth-form" data-testid="auth-form" novalidate>' +
        (isReg ?
          '<div class="field"><label for="afName">Display name</label>' +
          '<input id="afName" name="name" autocomplete="name" required minlength="2" maxlength="80"></div>' : '') +
        '<div class="field"><label for="afEmail">Email</label>' +
          '<input id="afEmail" name="email" type="email" autocomplete="email" required></div>' +
        '<div class="field"><label for="afPass">Password</label>' +
          '<input id="afPass" name="password" type="password" autocomplete="' + (isReg ? 'new-password' : 'current-password') + '" required minlength="' + (isReg ? 10 : 1) + '">' +
          (isReg ? '<span class="meta" style="font-size:11px">At least 10 characters.</span>' : '') + '</div>' +
        (isReg ?
          '<div class="field"><label for="afInvite">Invite token <span style="text-transform:none;color:var(--muted)">(required unless you are the first user)</span></label>' +
          '<input id="afInvite" name="invite" value="' + esc(inviteFromUrl) + '" maxlength="200"></div>' +
          '<div class="field"><label for="afTeam">Team name <span style="text-transform:none;color:var(--muted)">(first user only)</span></label>' +
          '<input id="afTeam" name="team" maxlength="80" placeholder="e.g. Nirmata Operations"></div>' : '') +
        '<div class="collab-err" data-testid="auth-error" role="alert" style="display:none;color:var(--sev-critical);font:500 12px/1.4 var(--mono)"></div>' +
        '<button class="btn primary" type="submit" data-testid="auth-submit">' +
          icon(isReg ? 'user-plus' : 'log-in') + (isReg ? 'Create account' : 'Sign in') + '</button>' +
      '</form>';
    A.openDrawer((isReg ? 'Create your account' : 'Sign in') + '', html);
    currentDrawer = 'identity';

    var body = drawerBody();
    $all('[data-tab]', body).forEach(function (b) {
      b.addEventListener('click', function () { renderAuthDrawer(b.getAttribute('data-tab')); });
    });
    var form = $('.auth-form', body);
    var errEl = $('.collab-err', body);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errEl.style.display = 'none';
      var submit = $('[data-testid="auth-submit"]', form);
      submit.disabled = true;
      var payload, action;
      if (isReg) {
        action = 'register';
        payload = {
          displayName: $('#afName', form).value.trim(),
          email: $('#afEmail', form).value.trim(),
          password: $('#afPass', form).value,
        };
        var inv = $('#afInvite', form).value.trim();
        var tn = $('#afTeam', form).value.trim();
        if (inv) payload.inviteToken = inv;
        if (tn) payload.teamName = tn;
      } else {
        action = 'login';
        payload = { email: $('#afEmail', form).value.trim(), password: $('#afPass', form).value };
      }
      api('/api/auth?action=' + action, { method: 'POST', body: payload })
        .then(function (j) {
          session = j.session;
          toast(isReg ? 'Account created — welcome.' : 'Signed in.', 'ok');
          paintIdentity();
          startPolling();
          softRefresh();
          renderAccountDrawer();
        })
        .catch(function (err) {
          errEl.textContent = err.message || 'Something went wrong.';
          errEl.style.display = 'block';
          submit.disabled = false;
        });
    });
  }

  // ---- authenticated: account + teams + members ----
  function renderAccountDrawer() {
    var s = session;
    var memberships = s.memberships || [];
    var html =
      '<div class="drawer-section">Signed in</div>' +
      '<div class="member-row"><div class="mr-main"><div class="mr-name">' + esc(s.user.displayName) + '</div>' +
        '<div class="mr-sub">' + esc(s.user.email) + '</div></div>' +
        '<button class="btn sm" data-testid="sign-out" data-act="logout">' + icon('log-out') + 'Sign out</button></div>';

    // Team switcher
    html += '<div class="drawer-section">Teams</div><div class="team-switcher" data-testid="team-switcher">' +
      memberships.map(function (m) {
        var active = m.teamId === s.activeTeamId;
        return '<button class="ts-opt' + (active ? ' active' : '') + '" data-team="' + esc(m.teamId) + '"' +
          (active ? ' aria-current="true"' : '') + '>' +
          icon(active ? 'check-circle' : 'circle') +
          '<span>' + esc(m.name) + '</span><span class="ts-role">' + esc(m.role) + '</span></button>';
      }).join('') + '</div>';

    // Members + invites (admin+)
    html += '<div class="drawer-section">Members</div><div id="collabMembers" data-testid="members">' +
      '<div class="meta">Loading…</div></div>';
    if (rankOf(s.role) >= rankOf('admin')) {
      html += '<div class="drawer-section">Invite &amp; roles</div>' +
        '<div id="collabInviteTools" data-testid="invite-tools"></div>';
    }
    if (rankOf(s.role) >= rankOf('admin')) {
      html += '<div class="drawer-section">Team settings</div>' +
        '<form class="auth-form" data-testid="rename-form"><div class="field">' +
        '<label for="renameInput">Rename team</label>' +
        '<div style="display:flex;gap:8px"><input id="renameInput" maxlength="80" value="' +
        esc((memberships.find(function (m) { return m.teamId === s.activeTeamId; }) || {}).name || '') + '">' +
        '<button class="btn sm" type="submit">' + icon('save') + 'Save</button></div></div></form>';
    }

    A.openDrawer('Account &amp; team', html);
    currentDrawer = 'identity';
    var body = drawerBody();

    $('[data-act="logout"]', body).addEventListener('click', doLogout);
    $all('.ts-opt', body).forEach(function (b) {
      b.addEventListener('click', function () { switchTeam(b.getAttribute('data-team')); });
    });
    var rf = $('[data-testid="rename-form"]', body);
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#renameInput', rf).value.trim();
      api('/api/teams?action=rename', { method: 'POST', body: { name: name } })
        .then(function () { toast('Team renamed.', 'ok'); return refreshSession(); })
        .then(function () { renderAccountDrawer(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });

    loadMembers();
    if (rankOf(s.role) >= rankOf('admin')) loadInviteTools();
  }

  function loadMembers() {
    api('/api/teams?action=members').then(function (j) {
      var host = $('#collabMembers');
      if (!host) return;
      var canManage = rankOf(session.role) >= rankOf('admin');
      host.innerHTML = j.members.map(function (m) {
        var isMe = m.user_id === j.me;
        var roleCtl;
        if (canManage && !isMe) {
          roleCtl = '<select class="select" data-testid="role-select" data-user="' + esc(m.user_id) + '" aria-label="Role for ' + esc(m.display_name) + '">' +
            ['viewer', 'analyst', 'admin', 'owner'].map(function (r) {
              // Only an owner may grant owner.
              if (r === 'owner' && session.role !== 'owner') return '';
              return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + r + '</option>';
            }).join('') + '</select>' +
            '<button class="btn sm" data-testid="remove-member" data-user="' + esc(m.user_id) + '" aria-label="Remove ' + esc(m.display_name) + '">' + icon('user-minus') + '</button>';
        } else {
          roleCtl = '<span class="ts-role">' + esc(m.role) + (isMe ? ' · you' : '') + '</span>';
        }
        return '<div class="member-row"><div class="mr-main"><div class="mr-name">' + esc(m.display_name) + '</div>' +
          '<div class="mr-sub">' + esc(m.email) + '</div></div>' + roleCtl + '</div>';
      }).join('');
      A.refreshIcons();
      $all('[data-testid="role-select"]', host).forEach(function (sel) {
        sel.addEventListener('change', function () {
          api('/api/teams?action=set-role', { method: 'POST', body: { userId: sel.getAttribute('data-user'), role: sel.value } })
            .then(function () { toast('Role updated.', 'ok'); loadMembers(); })
            .catch(function (err) { toast(err.message, 'error'); loadMembers(); });
        });
      });
      $all('[data-testid="remove-member"]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/teams?action=remove-member', { method: 'POST', body: { userId: b.getAttribute('data-user') } })
            .then(function () { toast('Member removed.', 'ok'); loadMembers(); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }).catch(function () {
      var host = $('#collabMembers');
      if (host) host.innerHTML = '<div class="meta">Unable to load members.</div>';
    });
  }

  function loadInviteTools() {
    var host = $('#collabInviteTools');
    if (!host) return;
    host.innerHTML =
      '<form class="auth-form" data-testid="invite-form" style="margin-bottom:12px">' +
        '<div class="field"><label for="invRole">New invite</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<select class="select" id="invRole" aria-label="Invite role">' +
        '<option value="viewer">viewer</option><option value="analyst">analyst</option><option value="admin">admin</option></select>' +
        '<input id="invEmail" type="email" placeholder="email (optional)" style="flex:1;min-width:140px">' +
        '<button class="btn sm primary" type="submit">' + icon('mail-plus') + 'Create</button></div></div>' +
      '</form>' +
      '<div id="collabInviteResult"></div>' +
      '<div id="collabInvites" class="meta">Loading invites…</div>';

    $('[data-testid="invite-form"]', host).addEventListener('submit', function (e) {
      e.preventDefault();
      var role = $('#invRole', host).value;
      var email = $('#invEmail', host).value.trim();
      api('/api/teams?action=invite', { method: 'POST', body: { role: role, email: email || undefined } })
        .then(function (j) { showInviteResult(j.invite); loadInvites(); })
        .catch(function (err) { toast(err.message, 'error'); });
    });
    loadInvites();
  }

  function showInviteResult(inv) {
    var host = $('#collabInviteResult');
    if (!host) return;
    var link = location.origin + '/?invite=' + encodeURIComponent(inv.token);
    host.innerHTML =
      '<div class="rule-card" data-testid="invite-result"><div class="rc-h"><span class="rc-name">' +
      esc(inv.role) + ' invite' + (inv.email ? ' · ' + esc(inv.email) : '') + '</span></div>' +
      '<div class="meta" style="margin-bottom:6px">Single-use · copy this link now (shown once):</div>' +
      '<div class="invite-copy" data-testid="invite-link">' + esc(link) + '</div>' +
      '<button class="btn sm" data-testid="copy-invite" style="margin-top:8px">' + icon('copy') + 'Copy link</button></div>';
    A.refreshIcons();
    $('[data-testid="copy-invite"]', host).addEventListener('click', function () {
      copyText(link);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard.', 'ok'); },
        function () { toast('Copy failed — select the link manually.', 'error'); });
    } else {
      toast('Select the link to copy.', 'error');
    }
  }

  function loadInvites() {
    api('/api/teams?action=invites').then(function (j) {
      var host = $('#collabInvites');
      if (!host) return;
      if (!j.invites.length) { host.innerHTML = '<div class="meta">No pending invites.</div>'; return; }
      host.className = '';
      host.innerHTML = j.invites.map(function (iv) {
        return '<div class="member-row"><div class="mr-main"><div class="mr-name">' + esc(iv.role) +
          (iv.email_norm ? ' · ' + esc(iv.email_norm) : ' · open') + '</div>' +
          '<div class="mr-sub">expires ' + fmtWhen(iv.expires_at) + '</div></div>' +
          '<button class="btn sm" data-testid="revoke-invite" data-id="' + esc(iv.id) + '">' + icon('x') + '</button></div>';
      }).join('');
      A.refreshIcons();
      $all('[data-testid="revoke-invite"]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/teams?action=revoke-invite', { method: 'POST', body: { id: b.getAttribute('data-id') } })
            .then(function () { toast('Invite revoked.', 'ok'); loadInvites(); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }).catch(function () {
      var host = $('#collabInvites');
      if (host) host.innerHTML = '<div class="meta">Unable to load invites.</div>';
    });
  }

  function doLogout() {
    api('/api/auth?action=logout', { method: 'POST', body: {} })
      .catch(function () { /* revoke best-effort */ })
      .then(function () {
        session = null;
        stopPolling();
        paintIdentity();
        softRefresh();
        A.closeDrawer();
        toast('Signed out.', 'ok');
      });
  }

  function switchTeam(teamId) {
    api('/api/auth?action=switch-team', { method: 'POST', body: { teamId: teamId } })
      .then(function (j) {
        session = j.session;
        toast('Switched team.', 'ok');
        paintIdentity();
        softRefresh();
        renderAccountDrawer();
      })
      .catch(function (err) { toast(err.message, 'error'); });
  }

  /* ============================================================
     TEAM MISSIONS (Command mode)
     ============================================================ */
  function onCommandRendered() {
    renderTeamMissions();
    var nm = $('#newMissionBtn');
    if (nm) {
      nm.hidden = !canWrite('analyst');
      nm.onclick = function () { openMissionComposer(); };
    }
  }

  function renderTeamMissions() {
    var host = $('#teamMissions');
    if (!host) return;
    if (!session) {
      host.innerHTML = '<div class="empty" data-testid="team-missions-empty" style="padding:18px;text-align:center;color:var(--muted)">' +
        icon('lock') + '<div style="margin-top:6px">Sign in to plan and assign persistent team missions.</div></div>';
      A.refreshIcons();
      return;
    }
    host.innerHTML = skeleton(3);
    api('/api/missions').then(function (j) {
      missionsCache = j.missions || [];
      var meta = $('#teamMissionsMeta');
      if (meta) meta.textContent = j.missions.length + ' persistent · team-scoped';
      if (!j.missions.length) {
        host.innerHTML = '<div class="empty" data-testid="team-missions-empty" style="padding:18px;text-align:center;color:var(--muted)">' +
          icon('clipboard-list') + '<div style="margin-top:6px">No team missions yet.' +
          (canWrite('analyst') ? ' Use “New mission” to create one.' : '') + '</div></div>';
        A.refreshIcons();
        return;
      }
      host.innerHTML = '<div class="tm-grid" style="display:grid;gap:10px">' +
        j.missions.map(missionCard).join('') + '</div>';
      A.refreshIcons();
      bindMissionCards(host);
    }).catch(function (err) {
      host.innerHTML = inlineError(err.authRequired ? 'Sign in to view team missions.' : 'Unable to load missions.',
        'retry-missions');
      var rb = $('[data-testid="retry-missions"]', host);
      if (rb) rb.addEventListener('click', renderTeamMissions);
    });
  }

  var MSTATUS = ['proposed', 'active', 'blocked', 'complete', 'archived'];
  function missionCard(m) {
    var writable = canWrite('analyst');
    var due = m.due_at ? '<span class="chip">' + icon('calendar') + ' ' + fmtWhen(m.due_at) + '</span>' : '';
    var statusCtl = writable
      ? '<select class="select" data-testid="mission-status" data-id="' + esc(m.id) + '" aria-label="Status">' +
        MSTATUS.map(function (s) { return '<option value="' + s + '"' + (m.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>'
      : '<span class="chip">' + esc(m.status) + '</span>';
    return '<div class="tm-card pri-' + esc(m.priority) + ' st-' + esc(m.status) + '" data-testid="mission-card" data-id="' + esc(m.id) + '">' +
      '<div style="display:flex;gap:8px;align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:14px">' + esc(m.title) + '</div>' +
          (m.objective ? '<div class="meta" style="margin-top:3px">' + esc(m.objective) + '</div>' : '') +
        '</div>' +
        '<span class="chip">' + esc(m.priority) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:9px">' +
        (m.pillar ? '<span class="chip">' + esc(m.pillar) + '</span>' : '') +
        (m.geography ? '<span class="chip">' + icon('map-pin') + ' ' + esc(m.geography) + '</span>' : '') +
        (m.assignee_name ? '<span class="chip">' + icon('user') + ' ' + esc(m.assignee_name) + '</span>' : '') +
        due +
        statusCtl +
        (writable ? '<button class="btn sm" data-testid="mission-edit" data-id="' + esc(m.id) + '" aria-label="Edit mission">' + icon('pencil') + '</button>' : '') +
        (writable && m.status !== 'archived' ? '<button class="btn sm" data-testid="mission-archive" data-id="' + esc(m.id) + '" aria-label="Archive mission">' + icon('archive') + '</button>' : '') +
      '</div>' +
      '<div class="mr-sub" style="margin-top:7px">by ' + esc(m.created_by_name || '—') + ' · ' + fmtWhen(m.updated_at || m.created_at) + '</div>' +
    '</div>';
  }

  function bindMissionCards(host) {
    $all('[data-testid="mission-status"]', host).forEach(function (sel) {
      sel.addEventListener('change', function () {
        api('/api/missions?id=' + encodeURIComponent(sel.getAttribute('data-id')),
          { method: 'PATCH', body: { status: sel.value } })
          .then(function () { toast('Mission updated.', 'ok'); renderTeamMissions(); })
          .catch(function (err) { toast(err.message, 'error'); renderTeamMissions(); });
      });
    });
    $all('[data-testid="mission-archive"]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        api('/api/missions?id=' + encodeURIComponent(b.getAttribute('data-id')), { method: 'DELETE' })
          .then(function () { toast('Mission archived.', 'ok'); renderTeamMissions(); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    });
    $all('[data-testid="mission-edit"]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var m = missionsCache.find(function (x) { return x.id === id; });
        openMissionComposer(m ? {
          title: m.title, objective: m.objective, priority: m.priority,
          status: m.status, pillar: m.pillar || '', geography: m.geography || '',
          assigneeId: m.assignee_id || '', dueAt: m.due_at || '',
        } : null, id);
      });
    });
  }

  // Mission composer — used for both New and Edit, and prefilled from alerts.
  function openMissionComposer(prefill, editId) {
    if (!canWrite('analyst')) { toast('Analyst role required to create missions.', 'error'); return; }
    prefill = prefill || {};
    var pillars = A.pillars || [];
    var editing = !!editId;

    var html =
      '<form class="auth-form" data-testid="mission-form">' +
        '<div class="field"><label for="mfTitle">Title</label>' +
          '<input id="mfTitle" required minlength="2" maxlength="200" value="' + esc(prefill.title || '') + '"></div>' +
        '<div class="field"><label for="mfObj">Objective</label>' +
          '<textarea id="mfObj" rows="3" maxlength="4000" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 11px;font:inherit;resize:vertical">' + esc(prefill.objective || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<div class="field" style="flex:1;min-width:120px"><label for="mfPriority">Priority</label>' +
            '<select class="select" id="mfPriority">' +
            ['low', 'medium', 'high', 'critical'].map(function (p) { return '<option value="' + p + '"' + ((prefill.priority || 'medium') === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></div>' +
          '<div class="field" style="flex:1;min-width:120px"><label for="mfStatus">Status</label>' +
            '<select class="select" id="mfStatus">' +
            ['proposed', 'active', 'blocked', 'complete'].map(function (s) { return '<option value="' + s + '"' + ((prefill.status || 'proposed') === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
        '</div>' +
        '<div class="field"><label for="mfPillar">Pillar</label>' +
          '<select class="select" id="mfPillar"><option value="">—</option>' +
          pillars.map(function (p) { return '<option value="' + esc(p) + '"' + (prefill.pillar === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="mfGeo">Geography</label>' +
          '<input id="mfGeo" maxlength="160" value="' + esc(prefill.geography || '') + '"></div>' +
        '<div class="field"><label for="mfAssignee">Assignee</label>' +
          '<select class="select" id="mfAssignee" data-testid="mission-assignee"><option value="">Unassigned</option></select></div>' +
        '<div class="field"><label for="mfDue">Due</label>' +
          '<input id="mfDue" type="date" value="' + esc(prefill.dueAt ? String(prefill.dueAt).slice(0, 10) : '') + '"></div>' +
        (prefill.sourceRef ? '<div class="meta">From alert: ' + esc(prefill.sourceRef) + '</div>' : '') +
        '<div class="collab-err" data-testid="mission-error" role="alert" style="display:none;color:var(--sev-critical);font:500 12px/1.4 var(--mono)"></div>' +
        '<button class="btn primary" type="submit" data-testid="mission-save">' + icon('save') + (editing ? 'Save changes' : 'Create mission') + '</button>' +
      '</form>';
    A.openDrawer(editing ? 'Edit mission' : 'New mission', html);
    currentDrawer = 'identity';
    var body = drawerBody();

    // Load members for the assignee picker.
    api('/api/teams?action=members').then(function (j) {
      var sel = $('#mfAssignee', body);
      if (!sel) return;
      j.members.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.user_id; o.textContent = m.display_name + ' (' + m.role + ')';
        if (prefill.assigneeId === m.user_id) o.selected = true;
        sel.appendChild(o);
      });
    }).catch(function () { /* non-fatal */ });

    var form = $('[data-testid="mission-form"]', body);
    var errEl = $('[data-testid="mission-error"]', body);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errEl.style.display = 'none';
      var save = $('[data-testid="mission-save"]', form);
      save.disabled = true;
      var payload = {
        title: $('#mfTitle', form).value.trim(),
        objective: $('#mfObj', form).value.trim(),
        priority: $('#mfPriority', form).value,
        pillar: $('#mfPillar', form).value || undefined,
        geography: $('#mfGeo', form).value.trim() || undefined,
        assigneeId: $('#mfAssignee', form).value || undefined,
      };
      var due = $('#mfDue', form).value;
      if (due) payload.dueAt = new Date(due + 'T00:00:00Z').toISOString();
      if (!editing) {
        payload.status = $('#mfStatus', form).value;
        if (prefill.sourceRef) payload.sourceRef = prefill.sourceRef;
      } else {
        payload.status = $('#mfStatus', form).value;
      }
      var url = editing ? '/api/missions?id=' + encodeURIComponent(editId) : '/api/missions';
      api(url, { method: editing ? 'PATCH' : 'POST', body: payload })
        .then(function (j) {
          // If this mission was spun up from an alert, persist the linkage.
          var newId = j && j.mission && j.mission.id;
          if (!editing && prefill.alertId && newId) {
            return api('/api/alerts?action=link-mission', { method: 'POST', body: { id: prefill.alertId, missionId: newId } })
              .then(function (aj) { applyAlerts(aj); }).catch(function () {});
          }
        })
        .then(function () {
          toast(editing ? 'Mission updated.' : 'Mission created.', 'ok');
          A.closeDrawer();
          renderTeamMissions();
        })
        .catch(function (err) {
          errEl.textContent = err.message || 'Unable to save mission.';
          errEl.style.display = 'block';
          save.disabled = false;
        });
    });
  }

  /* ============================================================
     WAR ROOM SCENARIOS
     ============================================================ */
  function onSimRendered() {
    loadScenarioHistory();
    updateSaveButtonState();
    renderWarRoom();
  }
  function onSimResolved() {
    updateSaveButtonState();
  }
  function updateSaveButtonState() {
    var btn = document.querySelector('#simSave');
    if (!btn) return;
    var snap = A.getSimSnapshot();
    // Base app already toggles disabled by snapshot; also require auth+analyst.
    if (!snap) { btn.disabled = true; return; }
    btn.disabled = !canWrite('analyst');
    btn.title = canWrite('analyst') ? 'Save this simulation to your team' : 'Sign in as analyst+ to save';
  }

  function saveScenario() {
    var snap = A.getSimSnapshot();
    if (!snap) { toast('Run a simulation first.', 'error'); return; }
    if (!session) { toast('Sign in to save scenarios.', 'error'); openIdentity(); return; }
    if (!canWrite('analyst')) { toast('Analyst role required to save scenarios.', 'error'); return; }
    var payload = {
      title: snap.title || (snap.threat ? snap.threat + ' scenario' : 'Untitled scenario'),
      threat: snap.threat || 'Unknown threat',
      pillar: snap.pillar,
      params: snap.params || {},
      result: snap.result || {},
    };
    api('/api/scenarios', { method: 'POST', body: payload })
      .then(function () { toast('Scenario saved to your team.', 'ok'); loadScenarioHistory(); })
      .catch(function (err) { toast(err.message, 'error'); });
  }

  function loadScenarioHistory() {
    var section = document.querySelector('#scenarioHistorySection');
    var host = document.querySelector('#scenarioHistory');
    if (!section || !host) return;
    if (!session) { section.hidden = true; return; }
    section.hidden = false;
    host.innerHTML = skeleton(2);
    api('/api/scenarios?limit=25').then(function (j) {
      if (!j.scenarios.length) {
        host.innerHTML = '<div class="empty" data-testid="scenario-empty" style="padding:14px;text-align:center;color:var(--muted)">' +
          icon('inbox') + '<div style="margin-top:6px">No saved scenarios yet.</div></div>';
        A.refreshIcons();
        return;
      }
      host.innerHTML = j.scenarios.map(function (s) {
        var r = s.result || {};
        return '<div class="sh-row" data-testid="scenario-row"><div class="shr-main">' +
          '<div class="shr-t">' + esc(s.title) + '</div>' +
          '<div class="shr-s">' + esc(s.threat) + (s.pillar ? ' · ' + esc(s.pillar) : '') +
          (r.rating ? ' · ' + esc(r.rating) : '') + ' · ' + esc(s.created_by_name || '—') + ' · ' + fmtWhen(s.created_at) + '</div></div>' +
          '<button class="btn sm" data-testid="scenario-replay" data-id="' + esc(s.id) + '">' + icon('play') + 'Replay</button>' +
          (canReplayDelete(s) ? '<button class="btn sm" data-testid="scenario-delete" data-id="' + esc(s.id) + '" aria-label="Delete scenario">' + icon('trash-2') + '</button>' : '') +
          '</div>';
      }).join('');
      A.refreshIcons();
      $all('[data-testid="scenario-replay"]', host).forEach(function (b) {
        b.addEventListener('click', function () { replayScenario(b.getAttribute('data-id')); });
      });
      $all('[data-testid="scenario-delete"]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/scenarios?id=' + encodeURIComponent(b.getAttribute('data-id')), { method: 'DELETE' })
            .then(function () { toast('Scenario deleted.', 'ok'); loadScenarioHistory(); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }).catch(function () {
      host.innerHTML = inlineError('Unable to load saved scenarios.', 'retry-scenarios');
      var rb = $('[data-testid="retry-scenarios"]', host);
      if (rb) rb.addEventListener('click', loadScenarioHistory);
    });
  }

  function canReplayDelete(s) {
    return session && (rankOf(session.role) >= rankOf('admin') || s.created_by === session.user.id);
  }

  function replayScenario(id) {
    api('/api/scenarios?id=' + encodeURIComponent(id)).then(function (j) {
      var sc = j.scenario;
      A.applyScenario(sc.params || {});
      toast('Replaying “' + (sc.title || 'scenario') + '”.', 'ok');
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  /* ============================================================
     WAR ROOM — server-backed presence + messages (honest near-real-time).
     The client polls /api/collab and labels the last sync time; presence
     freshness is derived server-side from each member's last heartbeat, so a
     member who stops heartbeating decays online -> away -> offline. We never
     fake realtime — the "synced" label always reflects the last real poll.
     ============================================================ */
  var WR_POLL_MS = 20000, WR_HEARTBEAT_MS = 30000;

  // Locate (or lazily create) the War Room host inside the simulate panel.
  // Returns null when the panel/DOM can't host it (keeps callers fail-soft).
  function warRoomHost() {
    var host = $('#warRoom');
    if (host) return host;
    var anchor = $('#scenarioHistorySection');
    if (!anchor || !anchor.parentNode || typeof anchor.parentNode.insertBefore !== 'function') return null;
    try {
      host = document.createElement('div');
      host.id = 'warRoom';
      host.className = 'section';
      host.setAttribute('data-testid', 'war-room-section');
      anchor.parentNode.insertBefore(host, anchor);
      return host;
    } catch (_) { return null; }
  }

  function renderWarRoom() {
    var host = warRoomHost();
    if (!host) return;
    if (!session) {
      stopWarRoom();
      host.hidden = false;
      host.innerHTML = '<div class="section-title"><h3>' + icon('users') + ' War Room</h3></div>' +
        '<div class="empty" data-testid="war-room-signedout" style="padding:16px;text-align:center;color:var(--muted)">' +
        icon('lock') + '<div style="margin-top:6px">Sign in to join your team\'s War Room.</div></div>';
      A.refreshIcons();
      return;
    }
    host.hidden = false;
    // First paint of the shell (idempotent — re-render fills #wrBody in place).
    if (!$('#wrBody', host)) {
      host.innerHTML =
        '<div class="section-title"><h3>' + icon('users') + ' War Room</h3>' +
          '<span class="wr-sync" data-testid="wr-sync" id="wrSync">connecting…</span></div>' +
        '<div class="wr-wrap"><div id="wrBody" data-testid="war-room"></div></div>';
      A.refreshIcons();
    }
    fetchWarRoom();
    startWarRoom();
  }

  function startWarRoom() {
    stopWarRoom();
    if (!session) return;
    heartbeat();
    wrTimer = setInterval(fetchWarRoom, WR_POLL_MS);
    wrHbTimer = setInterval(heartbeat, WR_HEARTBEAT_MS);
  }
  function stopWarRoom() {
    if (wrTimer) { clearInterval(wrTimer); wrTimer = null; }
    if (wrHbTimer) { clearInterval(wrHbTimer); wrHbTimer = null; }
  }

  function heartbeat() {
    if (!session) return Promise.resolve();
    return api('/api/collab?action=heartbeat', { method: 'POST', body: {} })
      .then(function (j) { wrState = j; paintWarRoom(); })
      .catch(function () { markWarRoomStale(); });
  }

  function fetchWarRoom() {
    if (!session) return Promise.resolve();
    return api('/api/collab?action=state')
      .then(function (j) { wrState = j; paintWarRoom(); })
      .catch(function () { markWarRoomStale(); });
  }

  function markWarRoomStale() {
    var sync = $('#wrSync');
    if (sync) sync.textContent = 'offline — showing last sync';
  }

  function highlightMentions(body) {
    // body is already escaped; wrap @mentions for emphasis.
    return String(body).replace(/(^|\s)(@[\w][\w .-]{0,60})/g, function (m, pre, name) {
      return pre + '<span class="mention">' + name + '</span>';
    });
  }

  function paintWarRoom() {
    var host = $('#warRoom');
    var body = $('#wrBody');
    if (!host || !body || !wrState) return;
    var sync = $('#wrSync');
    if (sync) {
      sync.textContent = (wrState.online || 0) + ' online · synced ' + fmtWhen(wrState.serverTime);
    }
    var members = wrState.members || [];
    var roster = '<div class="wr-roster" data-testid="wr-roster">' + members.map(function (m) {
      return '<span class="wr-member" data-testid="wr-member">' +
        '<span class="wr-dot ' + esc(m.presence || 'offline') + '"></span>' +
        esc(m.name) + '<span class="ts-role">' + esc(m.role || '') + '</span>' +
        (m.focus ? '<span class="meta" style="font-size:10px">· ' + esc(m.focus) + '</span>' : '') +
        '</span>';
    }).join('') + '</div>';

    var messages = wrState.messages || [];
    var msgs = messages.length
      ? messages.map(function (msg) {
          var when = fmtWhen(msg.created_at);
          if (msg.kind === 'system') {
            return '<div class="wr-msg system" data-testid="wr-msg">' + icon('info') + ' ' +
              highlightMentions(esc(msg.body)) + ' <span class="meta">· ' + esc(when) + '</span></div>';
          }
          return '<div class="wr-msg" data-testid="wr-msg"><span class="who">' + esc(msg.user_name || '—') +
            '</span> <span class="meta">' + esc(when) + '</span><div>' + highlightMentions(esc(msg.body)) + '</div></div>';
        }).join('')
      : '<div class="meta" data-testid="wr-empty">No messages yet. Start the conversation.</div>';

    var composer = canWrite('viewer')
      ? '<form class="wr-compose" data-testid="wr-compose">' +
          '<input data-testid="wr-input" maxlength="4000" placeholder="Message the room… use @name to mention" ' +
          'style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font:inherit">' +
          '<button class="btn sm primary" type="submit">' + icon('send') + 'Send</button>' +
        '</form>'
      : '<div class="meta">Sign in as viewer+ to post.</div>';

    body.innerHTML = roster + '<div class="wr-msgs" data-testid="wr-msgs">' + msgs + '</div>' + composer;
    A.refreshIcons();

    var form = $('[data-testid="wr-compose"]', body);
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('[data-testid="wr-input"]', form);
      var text = (input.value || '').trim();
      if (!text) return;
      input.disabled = true;
      api('/api/collab?action=message', { method: 'POST', body: { body: text } })
        .then(function (j) { wrState = j; input.value = ''; input.disabled = false; paintWarRoom(); })
        .catch(function (err) { toast(err.message, 'error'); input.disabled = false; });
    });
  }

  /* ============================================================
     ALERTS
     ============================================================ */
  function setAlertBadge(n) {
    var badge = $('#alertCount');
    if (!badge) return;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = !n;
  }

  function startPolling() {
    if (!session) return;
    stopPolling();
    syncAlerts(); // immediate
    pollTimer = setInterval(syncAlerts, 45000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    stopWarRoom();
  }

  function syncAlerts() {
    if (!session) return Promise.resolve();
    return api('/api/alerts?action=sync', { method: 'POST', body: {} })
      .then(function (j) { applyAlerts(j); })
      .catch(function () {
        // Fall back to a plain list if sync fails (e.g. live feed down).
        return api('/api/alerts?action=list').then(applyAlerts).catch(function () {});
      });
  }

  function applyAlerts(j) {
    alertsState = { alerts: j.alerts || [], unread: j.unread || 0, open: j.open || 0 };
    setAlertBadge(alertsState.unread);
    if (currentDrawer === 'alerts') renderAlertsList();
  }

  function openAlerts() {
    currentDrawer = 'alerts';
    var canDerive = canWrite('analyst');
    var html =
      '<div class="wr-sync" data-testid="alerts-summary" style="margin-bottom:8px"></div>' +
      '<div class="btn-row" style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '<button class="btn sm" data-testid="alerts-mark-all">' + icon('check-check') + 'Mark all read</button>' +
        '<button class="btn sm" data-testid="alerts-refresh">' + icon('refresh-cw') + 'Refresh</button>' +
        (canDerive ? '<button class="btn sm" data-testid="alerts-derive">' + icon('activity') + 'Derive predictive</button>' : '') +
        '<button class="btn sm" data-testid="alerts-rules">' + icon('sliders-horizontal') + 'Alert rules</button>' +
      '</div>' +
      '<div class="alerts-filters" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
        '<input data-testid="alerts-search" placeholder="Search title/region…" value="' + esc(alertFilter.q) + '" style="flex:1;min-width:130px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 9px;font:inherit">' +
        '<select class="select" data-testid="alerts-status">' +
          ['all', 'new', 'acknowledged', 'escalated', 'resolved'].map(function (s) { return '<option value="' + s + '"' + (alertFilter.status === s ? ' selected' : '') + '>' + (s === 'all' ? 'all status' : s) + '</option>'; }).join('') + '</select>' +
        '<select class="select" data-testid="alerts-basis">' +
          ['all', 'observed', 'modeled', 'analyst'].map(function (b) { return '<option value="' + b + '"' + (alertFilter.basis === b ? ' selected' : '') + '>' + (b === 'all' ? 'all basis' : b) + '</option>'; }).join('') + '</select>' +
      '</div>' +
      '<div id="collabAlerts" data-testid="alerts-list"></div>';
    A.openDrawer('Alert Center', html);
    currentDrawer = 'alerts';
    var body = drawerBody();
    $('[data-testid="alerts-mark-all"]', body).addEventListener('click', function () {
      api('/api/alerts?action=mark-all', { method: 'POST', body: {} }).then(applyAlerts).catch(function (e) { toast(e.message, 'error'); });
    });
    $('[data-testid="alerts-refresh"]', body).addEventListener('click', function () { syncAlerts(); toast('Refreshing alerts…'); });
    var db = $('[data-testid="alerts-derive"]', body);
    if (db) db.addEventListener('click', function () {
      db.disabled = true;
      api('/api/alerts?action=derive', { method: 'POST', body: {} })
        .then(function (j) {
          applyAlerts(j);
          toast(j.inserted ? j.inserted + ' new predictive alert' + (j.inserted === 1 ? '' : 's') + ' derived.' : 'No new alerts to derive.', 'ok');
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () { db.disabled = false; });
    });
    $('[data-testid="alerts-rules"]', body).addEventListener('click', openAlertRules);
    var sInput = $('[data-testid="alerts-search"]', body);
    if (sInput) sInput.addEventListener('input', function () { alertFilter.q = sInput.value; renderAlertsList(); });
    var stSel = $('[data-testid="alerts-status"]', body);
    if (stSel) stSel.addEventListener('change', function () { alertFilter.status = stSel.value; renderAlertsList(); });
    var bSel = $('[data-testid="alerts-basis"]', body);
    if (bSel) bSel.addEventListener('change', function () { alertFilter.basis = bSel.value; renderAlertsList(); });
    renderAlertsList();
    // Ensure we have fresh data on open.
    syncAlerts();
  }

  function filteredAlerts() {
    var q = String(alertFilter.q || '').trim().toLowerCase();
    return alertsState.alerts.filter(function (a) {
      if (alertFilter.status !== 'all' && (a.status || 'new') !== alertFilter.status) return false;
      if (alertFilter.basis !== 'all' && (a.basis || 'observed') !== alertFilter.basis) return false;
      if (q) {
        var hay = ((a.title || '') + ' ' + (a.geography || '') + ' ' + ((a.regions || []).join(' ')) + ' ' + ((a.commodities || []).join(' '))).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // Basis is provenance: observed = real ingested trigger, modeled = projection
  // (never certainty), analyst = human-entered signal. Confidence is shown as a
  // bounded percent — the engine caps it below 100 so we never claim certainty.
  var BASIS_LABEL = { observed: 'Observed', modeled: 'Modeled', analyst: 'Analyst' };
  function alertBadges(a) {
    var basis = a.basis || 'observed';
    var out = '<span class="ai-badge ' + esc(basis) + '" data-testid="alert-basis">' + esc(BASIS_LABEL[basis] || basis) + '</span>';
    if (a.confidence != null) {
      out += '<span class="ai-badge" data-testid="alert-confidence">' + Math.round(a.confidence * 100) + '% conf</span>';
    }
    if (a.horizon) out += '<span class="ai-badge">' + esc(a.horizon) + '</span>';
    var st = a.status || 'new';
    if (st !== 'new') out += '<span class="ai-badge status-' + esc(st) + '" data-testid="alert-status">' + esc(st) + '</span>';
    if (basis === 'modeled') out += '<span class="ai-badge modeled" title="Modeled projection — not a forecast of certainty">projection</span>';
    return '<div class="ai-badges">' + out + '</div>';
  }

  function renderAlertsList() {
    var host = $('#collabAlerts');
    if (!host) return;
    var summary = $('[data-testid="alerts-summary"]');
    if (summary) {
      summary.textContent = alertsState.alerts.length + ' alert' + (alertsState.alerts.length === 1 ? '' : 's') +
        ' · ' + alertsState.open + ' open · ' + alertsState.unread + ' unread';
    }
    var list = filteredAlerts();
    if (!list.length) {
      var msg = alertsState.alerts.length
        ? 'No alerts match this filter.'
        : 'No alerts yet. Configure alert rules or derive predictive alerts to start.';
      host.innerHTML = '<div class="empty" data-testid="alerts-empty" style="padding:18px;text-align:center;color:var(--muted)">' +
        icon('bell-off') + '<div style="margin-top:6px">' + esc(msg) + '</div></div>';
      A.refreshIcons();
      return;
    }
    var writable = canWrite('analyst');
    host.innerHTML = list.map(function (a, i) {
      var isNew = !seenAlertIds[a.id] && !a.is_read;
      var stagger = (isNew && !REDUCED) ? ' style="animation-delay:' + Math.min(i, 8) * 45 + 'ms"' : '';
      var cls = 'alert-item' + (a.is_read ? '' : ' unread') + (isNew && !REDUCED ? ' alert-arrival' : '');
      var st = a.status || 'new';
      return '<div class="' + cls + '"' + stagger + ' data-testid="alert-item" data-id="' + esc(a.id) + '">' +
        '<span class="ai-sev" style="background:' + (SEV_COLOR[a.severity] || 'var(--muted)') + '"></span>' +
        '<div class="ai-main"><div class="ai-t">' + esc(a.title) + '</div>' +
        '<div class="ai-s">' + esc(a.source || '') + (a.category ? ' · ' + esc(a.category) : '') +
        (a.geography ? ' · ' + esc(a.geography) : '') + ' · ' + fmtWhen(a.event_at || a.created_at) +
        (a.owner_name ? ' · owner ' + esc(a.owner_name) : '') + '</div>' +
        alertBadges(a) +
        '<div class="ai-acts" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
          (a.is_read ? '' : '<button class="btn sm" data-testid="alert-read" data-id="' + esc(a.id) + '">' + icon('check') + 'Mark read</button>') +
          '<button class="btn sm" data-testid="alert-explain" data-id="' + esc(a.id) + '">' + icon('help-circle') + 'Why?</button>' +
          (a.url ? '<a class="btn sm" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + icon('external-link') + 'Source</a>' : '') +
          (writable && st === 'new' ? '<button class="btn sm" data-testid="alert-acknowledge" data-id="' + esc(a.id) + '">' + icon('eye') + 'Acknowledge</button>' : '') +
          (writable && (st === 'new' || st === 'acknowledged') ? '<button class="btn sm" data-testid="alert-escalate" data-id="' + esc(a.id) + '">' + icon('trending-up') + 'Escalate → mission</button>' : '') +
          (writable && st !== 'resolved' ? '<button class="btn sm" data-testid="alert-resolve" data-id="' + esc(a.id) + '">' + icon('check-circle') + 'Resolve</button>' : '') +
          (writable ? '<button class="btn sm" data-testid="alert-mission" data-id="' + esc(a.id) + '">' + icon('plus') + 'Create mission</button>' : '') +
        '</div>' +
        '<div class="ai-explain-host" data-explain-for="' + esc(a.id) + '"></div>' +
        '</div></div>';
    }).join('');
    A.refreshIcons();
    list.forEach(function (a) { seenAlertIds[a.id] = true; });

    $all('[data-testid="alert-read"]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        api('/api/alerts?action=mark-read', { method: 'POST', body: { id: b.getAttribute('data-id') } })
          .then(applyAlerts).catch(function (e) { toast(e.message, 'error'); });
      });
    });
    $all('[data-testid="alert-explain"]', host).forEach(function (b) {
      b.addEventListener('click', function () { toggleExplain(b.getAttribute('data-id')); });
    });
    bindAlertLifecycle(host, 'alert-acknowledge', 'acknowledge');
    bindAlertLifecycle(host, 'alert-resolve', 'resolve');
    $all('[data-testid="alert-escalate"]', host).forEach(function (b) {
      b.addEventListener('click', function () { escalateAlert(b.getAttribute('data-id')); });
    });
    $all('[data-testid="alert-mission"]', host).forEach(function (b) {
      b.addEventListener('click', function () { createMissionFromAlert(b.getAttribute('data-id')); });
    });
    // Re-open any explainability panels that were expanded before re-render.
    Object.keys(expandedAlerts).forEach(function (id) { if (expandedAlerts[id]) renderExplain(id); });
  }

  function bindAlertLifecycle(host, testid, action) {
    $all('[data-testid="' + testid + '"]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        api('/api/alerts?action=' + action, { method: 'POST', body: { id: b.getAttribute('data-id') } })
          .then(function (j) { applyAlerts(j); toast('Alert ' + action + 'd.', 'ok'); })
          .catch(function (e) { toast(e.message, 'error'); b.disabled = false; });
      });
    });
  }

  function toggleExplain(id) {
    expandedAlerts[id] = !expandedAlerts[id];
    if (expandedAlerts[id]) renderExplain(id);
    else {
      var host = $('[data-explain-for="' + id + '"]');
      if (host) host.innerHTML = '';
    }
  }

  function renderExplain(id) {
    var host = $('[data-explain-for="' + id + '"]');
    if (!host) return;
    host.innerHTML = '<div class="meta" style="margin-top:6px">Loading explanation…</div>';
    api('/api/alerts?action=explain&id=' + encodeURIComponent(id)).then(function (j) {
      var ex = j.explanation || {};
      var atom = j.atom || {};
      var gen = atom.generator || 'deterministic';
      function ul(items) {
        return '<ul>' + (items || []).map(function (x) {
          if (x && typeof x === 'object') {
            if (x.url) return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.label || x.url) + '</a></li>';
            return '<li>' + esc(x.label || JSON.stringify(x)) + '</li>';
          }
          return '<li>' + esc(x) + '</li>';
        }).join('') + '</ul>';
      }
      host.innerHTML =
        '<div class="ai-explain" data-testid="alert-explain-panel">' +
          '<h5>Why this fired' + (gen === 'deterministic' ? ' · deterministic fallback' : ' · ' + esc(gen)) + '</h5>' +
          (ex.label ? '<div style="font-size:12.5px;margin-bottom:6px">' + esc(ex.label) + '</div>' : '') +
          (ex.whyFired && ex.whyFired.length ? ul(ex.whyFired) : '') +
          (ex.evidence && ex.evidence.length ? '<h5>Evidence</h5>' + ul(ex.evidence) : '') +
          (ex.thresholds && ex.thresholds.length ? '<h5>Thresholds</h5>' + ul(ex.thresholds) : '') +
          (ex.assumptions && ex.assumptions.length ? '<h5>Assumptions</h5>' + ul(ex.assumptions) : '') +
          (ex.nextEffects && ex.nextEffects.length ? '<h5>Likely next effects</h5>' + ul(ex.nextEffects) : '') +
          (ex.recommendedDecisions && ex.recommendedDecisions.length ? '<h5>Recommended decisions</h5>' + ul(ex.recommendedDecisions) : '') +
          (ex.uncertainty ? '<div class="uncert">' + esc(ex.uncertainty) + '</div>' : '') +
        '</div>';
      A.refreshIcons();
    }).catch(function () {
      host.innerHTML = '<div class="meta" style="margin-top:6px">Unable to load explanation.</div>';
    });
  }

  function createMissionFromAlert(id) {
    var a = alertsState.alerts.find(function (x) { return x.id === id; });
    if (!a) return;
    openMissionComposer({
      title: a.title,
      priority: SEV_TO_PRIORITY[a.severity] || 'medium',
      geography: a.geography || (a.regions && a.regions[0]) || '',
      sourceRef: (a.source || 'alert') + ':' + a.id,
      objective: a.url ? 'Source: ' + a.url : '',
      alertId: a.id,
    });
  }

  // Escalate = flip the alert to 'escalated' AND spin up a linked mission. The
  // composer is pre-filled and, on save, the alert is linked to the new mission.
  function escalateAlert(id) {
    if (!canWrite('analyst')) { toast('Analyst role required.', 'error'); return; }
    api('/api/alerts?action=escalate', { method: 'POST', body: { id: id } })
      .then(function (j) {
        applyAlerts(j);
        toast('Escalated — open a mission to coordinate response.', 'ok');
        createMissionFromAlert(id);
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  // ---- alert rules builder ----
  function openAlertRules() {
    currentDrawer = 'identity';
    var canEdit = canWrite('analyst');
    var html =
      (canEdit ? '<button class="btn sm primary" data-testid="rule-new" style="margin-bottom:12px">' + icon('plus') + 'New rule</button>' : '<div class="meta" style="margin-bottom:12px">Analyst role required to edit rules.</div>') +
      '<div id="collabRules" data-testid="rules-list"></div>';
    A.openDrawer('Alert rules', html);
    currentDrawer = 'identity';
    var body = drawerBody();
    var nb = $('[data-testid="rule-new"]', body);
    if (nb) nb.addEventListener('click', function () { openRuleForm(null); });
    loadRules();
  }

  function loadRules() {
    var host = $('#collabRules');
    if (!host) return;
    host.innerHTML = skeleton(2);
    api('/api/alerts?action=rules').then(function (j) {
      if (!j.rules.length) {
        host.innerHTML = '<div class="empty" style="padding:16px;text-align:center;color:var(--muted)">' +
          icon('filter') + '<div style="margin-top:6px">No alert rules. Create one to materialize matching live events into alerts.</div></div>';
        A.refreshIcons();
        return;
      }
      var canEdit = canWrite('analyst');
      host.innerHTML = j.rules.map(function (r) {
        return '<div class="rule-card" data-testid="rule-card">' +
          '<div class="rc-h"><span class="ai-sev" style="background:' + (r.enabled ? 'var(--cyan)' : 'var(--muted)') + '"></span>' +
          '<span class="rc-name">' + esc(r.name) + '</span>' +
          '<span class="ts-role">' + (r.enabled ? 'enabled' : 'off') + '</span></div>' +
          '<div class="meta">≥ ' + esc(r.min_severity) + ' severity' +
          (r.categories && r.categories.length ? ' · categories: ' + esc(r.categories.join(', ')) : '') +
          (r.geographies && r.geographies.length ? ' · geo: ' + esc(r.geographies.join(', ')) : '') + '</div>' +
          (canEdit ? '<div class="btn-row" style="display:flex;gap:6px;margin-top:9px">' +
            '<button class="btn sm" data-testid="rule-edit" data-id="' + esc(r.id) + '">' + icon('pencil') + 'Edit</button>' +
            '<button class="btn sm" data-testid="rule-delete" data-id="' + esc(r.id) + '">' + icon('trash-2') + 'Delete</button></div>' : '') +
          '</div>';
      }).join('');
      A.refreshIcons();
      $all('[data-testid="rule-edit"]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          var r = j.rules.find(function (x) { return x.id === b.getAttribute('data-id'); });
          openRuleForm(r);
        });
      });
      $all('[data-testid="rule-delete"]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/alerts?action=rule-delete', { method: 'POST', body: { id: b.getAttribute('data-id') } })
            .then(function () { toast('Rule deleted.', 'ok'); loadRules(); })
            .catch(function (err) { toast(err.message, 'error'); });
        });
      });
    }).catch(function () {
      host.innerHTML = inlineError('Unable to load rules.', 'retry-rules');
      var rb = $('[data-testid="retry-rules"]', host);
      if (rb) rb.addEventListener('click', loadRules);
    });
  }

  function openRuleForm(rule) {
    rule = rule || {};
    var editing = !!rule.id;
    var html =
      '<form class="auth-form" data-testid="rule-form">' +
        '<div class="field"><label for="rfName">Rule name</label>' +
          '<input id="rfName" required minlength="2" maxlength="120" value="' + esc(rule.name || '') + '"></div>' +
        '<div class="field"><label><input type="checkbox" id="rfEnabled"' + (rule.enabled === false ? '' : ' checked') + '> Enabled</label></div>' +
        '<div class="field"><label for="rfSev">Minimum severity</label>' +
          '<select class="select" id="rfSev">' +
          ['moderate', 'high', 'critical'].map(function (s) { return '<option value="' + s + '"' + ((rule.min_severity || 'moderate') === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="rfCats">Categories <span style="text-transform:none;color:var(--muted)">(comma-separated, optional)</span></label>' +
          '<input id="rfCats" maxlength="300" value="' + esc((rule.categories || []).join(', ')) + '" placeholder="drought, conflict"></div>' +
        '<div class="field"><label for="rfGeo">Geographies <span style="text-transform:none;color:var(--muted)">(comma-separated, optional)</span></label>' +
          '<input id="rfGeo" maxlength="300" value="' + esc((rule.geographies || []).join(', ')) + '" placeholder="Sahel, Horn of Africa"></div>' +
        '<div class="collab-err" data-testid="rule-error" role="alert" style="display:none;color:var(--sev-critical);font:500 12px/1.4 var(--mono)"></div>' +
        '<button class="btn primary" type="submit" data-testid="rule-save">' + icon('save') + (editing ? 'Save rule' : 'Create rule') + '</button>' +
      '</form>';
    A.openDrawer(editing ? 'Edit alert rule' : 'New alert rule', html);
    currentDrawer = 'identity';
    var body = drawerBody();
    var form = $('[data-testid="rule-form"]', body);
    var errEl = $('[data-testid="rule-error"]', body);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errEl.style.display = 'none';
      var save = $('[data-testid="rule-save"]', form);
      save.disabled = true;
      var payload = {
        name: $('#rfName', form).value.trim(),
        enabled: $('#rfEnabled', form).checked,
        minSeverity: $('#rfSev', form).value,
        categories: splitList($('#rfCats', form).value),
        geographies: splitList($('#rfGeo', form).value),
      };
      if (editing) payload.id = rule.id;
      api('/api/alerts?action=rule-save', { method: 'POST', body: payload })
        .then(function () { toast(editing ? 'Rule saved.' : 'Rule created.', 'ok'); openAlertRules(); })
        .catch(function (err) {
          errEl.textContent = err.message || 'Unable to save rule.';
          errEl.style.display = 'block';
          save.disabled = false;
        });
    });
  }

  function splitList(v) {
    return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* ---------------- shared render helpers ---------------- */
  function skeleton(n) {
    var one = '<div class="skel" style="height:58px;border-radius:9px;margin-bottom:10px;' +
      'background:linear-gradient(90deg,var(--surface) 25%,var(--bg-2,#1b2027) 37%,var(--surface) 63%);' +
      'background-size:400% 100%;' + (REDUCED ? '' : 'animation:skelShimmer 1.3s ease infinite;') + '"></div>';
    var out = '';
    for (var i = 0; i < n; i++) out += one;
    return out;
  }
  function inlineError(msg, retryTestId) {
    return '<div class="collab-inline-error" style="padding:14px;border:1px solid var(--border);border-left:3px solid var(--sev-high);border-radius:9px;color:var(--muted)">' +
      esc(msg) + ' <button class="btn sm" data-testid="' + esc(retryTestId) + '" style="margin-left:8px">' + icon('refresh-cw') + 'Retry</button></div>';
  }

  // Re-render every collaboration surface currently on screen (after auth/team change).
  function softRefresh() {
    if ($('#teamMissions')) renderTeamMissions();
    if (document.querySelector('#scenarioHistorySection')) { loadScenarioHistory(); updateSaveButtonState(); }
    if ($('#warRoom') || document.querySelector('#scenarioHistorySection')) renderWarRoom();
    if (session) syncAlerts(); else setAlertBadge(0);
  }

  /* ---------------- public bridge ---------------- */
  window.AGRI_COLLAB = {
    init: init,
    refreshSession: refreshSession,
    openIdentity: openIdentity,
    openAlerts: openAlerts,
    onCommandRendered: onCommandRendered,
    onSimRendered: onSimRendered,
    onSimResolved: onSimResolved,
    saveScenario: saveScenario,
    openMissionComposer: openMissionComposer,
  };
})();
