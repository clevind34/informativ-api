/**
 * Informativ Identity Login Module
 * Drop-in authentication for all consumer sites.
 *
 * Usage in consumer HTML:
 *   1. Add before </head>:
 *      <script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>
 *
 *   2. Add after the widget script:
 *      <script>
 *        // --- Informativ Identity Login ---
 *        (paste this entire IIFE block)
 *      </script>
 *
 *   3. Replace static API_HEADERS with:
 *      function _getApiHeaders() {
 *        var h = { 'Content-Type': 'application/json' };
 *        var t = window._identityToken;
 *        if (t) h['Authorization'] = 'Bearer ' + t;
 *        return h;
 *      }
 *
 * The module:
 *   - Points Netlify Identity widget at the gateway's Identity endpoint
 *   - Shows a login overlay if no active session
 *   - Stores the JWT in window._identityToken for API calls
 *   - Auto-refreshes tokens before expiry
 *   - Exposes window._identityUser (email, roles, team, rep_name)
 *   - Adds a user pill + logout button to the page
 */
(function() {
  'use strict';

  var IDENTITY_URL = 'https://informativ-sales-api.netlify.app/.identity';

  // Initialize Netlify Identity Widget pointed at the gateway
  if (window.netlifyIdentity) {
    window.netlifyIdentity.init({
      APIUrl: IDENTITY_URL
    });
  }

  // Global token for API calls
  window._identityToken = null;
  window._identityUser = null;

  // --- Login Overlay ---
  function createLoginOverlay() {
    if (document.getElementById('identity-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'identity-overlay';
    overlay.innerHTML = [
      '<div style="position:fixed;inset:0;background:rgba(0,20,50,0.92);z-index:99999;',
      'display:flex;align-items:center;justify-content:center;font-family:\'Plus Jakarta Sans\',sans-serif">',
      '<div style="background:#fff;border-radius:16px;padding:48px 40px;max-width:400px;width:90%;',
      'text-align:center;box-shadow:0 24px 80px rgba(0,0,0,0.3)">',
      '<div style="width:56px;height:56px;background:linear-gradient(135deg,#6627E8,#002757);',
      'border-radius:12px;margin:0 auto 24px;display:flex;align-items:center;justify-content:center">',
      '<svg width="28" height="28" fill="none" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
      '<h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#002757">Informativ</h2>',
      '<p style="margin:0 0 32px;font-size:14px;color:#6B7280">Sign in to continue</p>',
      '<button id="identity-login-btn" style="width:100%;padding:14px 24px;background:linear-gradient(135deg,#6627E8,#4F1FBA);',
      'color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;',
      'letter-spacing:0.02em;transition:transform 0.15s,box-shadow 0.15s">Sign In</button>',
      '</div></div>'
    ].join('');

    document.body.appendChild(overlay);

    document.getElementById('identity-login-btn').addEventListener('click', function() {
      if (window.netlifyIdentity) {
        window.netlifyIdentity.open('login');
      }
    });
  }

  function removeLoginOverlay() {
    var el = document.getElementById('identity-overlay');
    if (el) {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(function() { el.remove(); }, 300);
    }
  }

  // --- User Pill (top-right corner) ---
  function createUserPill(user) {
    if (document.getElementById('identity-pill')) return;

    var email = user.email || '';
    var name = email.split('@')[0] || 'User';
    var initials = name.charAt(0).toUpperCase();

    var pill = document.createElement('div');
    pill.id = 'identity-pill';
    pill.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;display:flex;align-items:center;gap:8px;' +
      'background:#fff;border:1px solid #E5E7EB;border-radius:40px;padding:6px 14px 6px 8px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.08);font-family:\'Plus Jakarta Sans\',sans-serif;font-size:13px;';

    pill.innerHTML = [
      '<div style="width:28px;height:28px;background:#6627E8;border-radius:50%;display:flex;',
      'align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">',
      initials, '</div>',
      '<span style="color:#374151;font-weight:600">', name, '</span>',
      '<button id="identity-logout-btn" style="background:none;border:none;color:#9CA3AF;cursor:pointer;',
      'font-size:16px;padding:0 0 0 4px;line-height:1" title="Sign out">',
      '<svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '</button>'
    ].join('');

    document.body.appendChild(pill);

    document.getElementById('identity-logout-btn').addEventListener('click', function() {
      if (window.netlifyIdentity) {
        window.netlifyIdentity.logout();
      }
    });
  }

  function removeUserPill() {
    var el = document.getElementById('identity-pill');
    if (el) el.remove();
  }

  // --- Session Handler ---
  function handleLogin(user) {
    if (!user || !user.token) return;

    window._identityToken = user.token.access_token;
    window._identityUser = {
      email: user.email,
      id: user.id,
      roles: (user.app_metadata || {}).roles || [],
      team: (user.app_metadata || {}).team || null,
      rep_name: (user.app_metadata || {}).rep_name || null,
    };

    removeLoginOverlay();
    createUserPill(user);

    // Dispatch event for consumer app to react
    window.dispatchEvent(new CustomEvent('identity:login', { detail: window._identityUser }));
  }

  function handleLogout() {
    window._identityToken = null;
    window._identityUser = null;
    removeUserPill();
    createLoginOverlay();

    window.dispatchEvent(new CustomEvent('identity:logout'));
  }

  // --- Token Refresh ---
  function scheduleTokenRefresh(user) {
    if (!user || !user.token) return;

    // GoTrue tokens have exp claim. Refresh 60s before expiry.
    try {
      var parts = user.token.access_token.split('.');
      var payload = JSON.parse(atob(parts[1]));
      var expiresAt = payload.exp * 1000;
      var refreshIn = expiresAt - Date.now() - 60000; // 60s before expiry

      if (refreshIn > 0) {
        setTimeout(function() {
          if (window.netlifyIdentity) {
            var current = window.netlifyIdentity.currentUser();
            if (current) {
              current.jwt().then(function(token) {
                window._identityToken = token;
                scheduleTokenRefresh(current);
              });
            }
          }
        }, refreshIn);
      }
    } catch (e) {
      // If token parsing fails, refresh every 50 min
      setTimeout(function() {
        if (window.netlifyIdentity) {
          var current = window.netlifyIdentity.currentUser();
          if (current) {
            current.jwt().then(function(token) {
              window._identityToken = token;
            });
          }
        }
      }, 50 * 60 * 1000);
    }
  }

  // --- Init ---
  function init() {
    if (!window.netlifyIdentity) {
      console.warn('[Identity] Netlify Identity widget not loaded');
      return;
    }

    // Check for existing session
    var user = window.netlifyIdentity.currentUser();
    if (user) {
      // Refresh token to ensure it's current
      user.jwt().then(function(token) {
        window._identityToken = token;
        user.token = user.token || {};
        user.token.access_token = token;
        handleLogin(user);
        scheduleTokenRefresh(user);
      }).catch(function() {
        // Token refresh failed — force re-login
        handleLogout();
      });
    } else {
      createLoginOverlay();
    }

    // Listen for identity events
    window.netlifyIdentity.on('login', function(user) {
      handleLogin(user);
      scheduleTokenRefresh(user);
      window.netlifyIdentity.close();
    });

    window.netlifyIdentity.on('logout', function() {
      handleLogout();
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
