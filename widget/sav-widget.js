/**
 * sav-widget.js
 * ------------------------------------------------------------
 * Widget de chat SAV, autonome, à injecter sur n'importe quel
 * site via une seule balise <script>. Aucune dépendance externe.
 *
 * Utilisation minimale :
 *
 *   <script
 *     src="https://TON_DOMAINE/sav-widget.js"
 *     data-api-url="https://TON_API.com"
 *     data-shop-name="Ma Boutique"
 *   ></script>
 *
 * Options disponibles (attributs data-* sur la balise script) :
 *   data-api-url      (obligatoire) URL de base de ton backend Express
 *                      (le widget appelle POST {apiUrl}/api/chat)
 *   data-shop-name     Nom affiché dans l'en-tête (défaut: "Service client")
 *   data-color         Couleur principale du widget, ex: "#4338CA"
 *   data-position       "right" (défaut) ou "left"
 *   data-welcome-message  Message d'accueil affiché à l'ouverture
 * ------------------------------------------------------------
 */
(function () {
  'use strict';

  // Évite une double injection si le script est chargé 2 fois
  if (window.__SAV_WIDGET_LOADED__) return;
  window.__SAV_WIDGET_LOADED__ = true;

  // ------------------------------------------------------------
  // 1. Configuration (lue depuis la balise <script> courante)
  // ------------------------------------------------------------
  var currentScript =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  var config = {
    apiUrl: (currentScript.getAttribute('data-api-url') || '').replace(/\/$/, ''),
    projet: (currentScript.getAttribute('data-project') || '').replace(/\/$/, ''),
    shopName: currentScript.getAttribute('data-shop-name') || 'Service client',
    color: currentScript.getAttribute('data-color') || '#4338CA',
    accent: currentScript.getAttribute('data-accent') || '#00C2A8',
    position: currentScript.getAttribute('data-position') === 'left' ? 'left' : 'right',
    welcomeMessage:
      currentScript.getAttribute('data-welcome-message') ||
      'Bonjour 👋 Comment puis-je vous aider avec votre commande aujourd\u2019hui ?'
  };

  if (!config.apiUrl) {
    console.error('[SAV Widget] data-api-url est requis sur la balise <script>.');
    return;
  }

  // ------------------------------------------------------------
  // 2. Session (persistée en localStorage pour garder le fil
  //    de la conversation entre deux visites)
  // ------------------------------------------------------------
  var STORAGE_SESSION_KEY = 'sav_widget_session_id';
  var STORAGE_HISTORY_KEY = 'sav_widget_history';

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getSessionId() {
    try {
      var id = localStorage.getItem(STORAGE_SESSION_KEY);
      if (!id) {
        id = uuid();
        localStorage.setItem(STORAGE_SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      return uuid(); // localStorage indisponible (mode privé, etc.)
    }
  }

  function loadLocalHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocalHistory(list) {
    try {
      localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) {
      /* silencieux : le widget fonctionne même sans persistance locale */
    }
  }

  var sessionId = getSessionId();

  // ------------------------------------------------------------
  // 3. Styles (injectés en <style>, préfixés "sav-" pour ne
  //    jamais entrer en conflit avec le CSS du site hôte)
  // ------------------------------------------------------------
  var css = [
    '.sav-widget *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
    '.sav-widget{position:fixed;bottom:24px;' + config.position + ':24px;z-index:2147483000;}',
    '.sav-bubble{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;',
    'background:linear-gradient(135deg,' + config.color + ',' + shade(config.color, -18) + ');',
    'box-shadow:0 8px 24px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;',
    'transition:transform .25s ease,box-shadow .25s ease;position:relative;}',
    '.sav-bubble:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 10px 28px rgba(0,0,0,.28);}',
    '.sav-bubble:focus-visible{outline:3px solid ' + config.accent + ';outline-offset:3px;}',
    '.sav-bubble svg{width:26px;height:26px;transition:opacity .18s ease,transform .18s ease;}',
    '.sav-bubble .sav-icon-close{position:absolute;opacity:0;transform:rotate(-45deg) scale(.6);}',
    '.sav-bubble .sav-icon-chat{opacity:1;transform:rotate(0) scale(1);}',
    '.sav-widget.open .sav-icon-chat{opacity:0;transform:rotate(45deg) scale(.6);}',
    '.sav-widget.open .sav-icon-close{opacity:1;transform:rotate(0) scale(1);}',
    '.sav-dot{position:absolute;top:2px;' + (config.position === 'right' ? 'right:2px' : 'left:2px') + ';width:14px;height:14px;border-radius:50%;background:' + config.accent + ';border:2px solid #fff;}',
    '.sav-panel{position:absolute;bottom:76px;' + config.position + ':0;width:368px;max-width:calc(100vw - 32px);',
    'height:520px;max-height:calc(100vh - 140px);background:#fff;border-radius:18px;',
    'box-shadow:0 20px 60px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;',
    'opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .2s ease,transform .2s ease;}',
    '.sav-widget.open .sav-panel{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}',
    '.sav-header{background:linear-gradient(135deg,' + config.color + ',' + shade(config.color, -18) + ');',
    'color:#fff;padding:16px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '.sav-header-avatar{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.18);',
    'display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;}',
    '.sav-header-avatar .sav-status{position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;',
    'border-radius:50%;background:' + config.accent + ';border:2px solid ' + config.color + ';}',
    '.sav-header-text{line-height:1.25;min-width:0;}',
    '.sav-header-title{font-weight:600;font-size:14.5px;}',
    '.sav-header-sub{font-size:12px;opacity:.85;}',
    '.sav-header-close{margin-left:auto;background:none;border:none;color:#fff;opacity:.85;',
    'cursor:pointer;padding:4px;border-radius:6px;}',
    '.sav-header-close:hover{opacity:1;background:rgba(255,255,255,.14);}',
    '.sav-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;',
    'background:#F7F7FB;}',
    '.sav-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;',
    'white-space:pre-wrap;word-wrap:break-word;animation:sav-in .18s ease;}',
    '@keyframes sav-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}',
    '.sav-msg.bot{align-self:flex-start;background:#fff;color:#26263B;border-bottom-left-radius:4px;',
    'box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '.sav-msg.user{align-self:flex-end;background:' + config.color + ';color:#fff;border-bottom-right-radius:4px;}',
    '.sav-msg.error{align-self:flex-start;background:#FDECEC;color:#B42318;border-bottom-left-radius:4px;}',
    '.sav-typing{align-self:flex-start;display:flex;gap:4px;padding:11px 14px;background:#fff;',
    'border-radius:14px;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '.sav-typing span{width:6px;height:6px;border-radius:50%;background:#B7B7C9;',
    'animation:sav-bounce 1.1s infinite ease-in-out;}',
    '.sav-typing span:nth-child(2){animation-delay:.15s;}',
    '.sav-typing span:nth-child(3){animation-delay:.3s;}',
    '@keyframes sav-bounce{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-4px);opacity:1;}}',
    '.sav-inputrow{flex-shrink:0;display:flex;gap:8px;padding:12px;border-top:1px solid #EEEEF2;background:#fff;}',
    '.sav-input{flex:1;resize:none;border:1px solid #E2E2EA;border-radius:12px;padding:9px 12px;',
    'font-size:13.5px;line-height:1.4;max-height:90px;outline:none;transition:border-color .15s ease;}',
    '.sav-input:focus{border-color:' + config.color + ';}',
    '.sav-send{width:38px;height:38px;flex-shrink:0;border-radius:50%;border:none;cursor:pointer;',
    'background:' + config.color + ';color:#fff;display:flex;align-items:center;justify-content:center;',
    'transition:opacity .15s ease,transform .1s ease;}',
    '.sav-send:disabled{opacity:.4;cursor:default;}',
    '.sav-send:not(:disabled):active{transform:scale(.92);}',
    '.sav-send svg{width:16px;height:16px;}',
    '@media (max-width:480px){',
    '  .sav-panel{position:fixed;inset:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0;bottom:0;right:0;left:0;}',
    '  .sav-widget{bottom:16px;' + config.position + ':16px;}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  .sav-bubble,.sav-panel,.sav-msg,.sav-typing span{transition:none!important;animation:none!important;}',
    '}'
  ].join('\n');

  // Éclaircit/assombrit une couleur hex d'un pourcentage donné (utilitaire interne)
  function shade(hex, percent) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(hex, 16);
    var r = (num >> 16) + percent;
    var g = ((num >> 8) & 0x00ff) + percent;
    var b = (num & 0x0000ff) + percent;
    r = Math.max(Math.min(255, r), 0);
    g = Math.max(Math.min(255, g), 0);
    b = Math.max(Math.min(255, b), 0);
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  var styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  // ------------------------------------------------------------
  // 4. DOM
  // ------------------------------------------------------------
  var ICON_CHAT =
    '<svg class="sav-icon-chat" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE =
    '<svg class="sav-icon-close" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_SEND =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  var root = document.createElement('div');
  root.className = 'sav-widget';
  root.innerHTML =
    '<div class="sav-panel" role="dialog" aria-label="' + escapeAttr(config.shopName) + '" aria-hidden="true">' +
      '<div class="sav-header">' +
        '<div class="sav-header-avatar">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="sav-status"></span>' +
        '</div>' +
        '<div class="sav-header-text">' +
          '<div class="sav-header-title">' + escapeHtml(config.shopName) + '</div>' +
          '<div class="sav-header-sub">En ligne</div>' +
        '</div>' +
        '<button class="sav-header-close" type="button" aria-label="Fermer la conversation">' + ICON_CLOSE.replace('sav-icon-close', '') + '</button>' +
      '</div>' +
      '<div class="sav-messages"></div>' +
      '<div class="sav-inputrow">' +
        '<textarea class="sav-input" rows="1" placeholder="Écrivez votre message\u2026" aria-label="Votre message"></textarea>' +
        '<button class="sav-send" type="button" aria-label="Envoyer">' + ICON_SEND + '</button>' +
      '</div>' +
    '</div>' +
    '<button class="sav-bubble" type="button" aria-label="Ouvrir le chat">' +
      '<span class="sav-dot"></span>' + ICON_CHAT + ICON_CLOSE +
    '</button>';

  document.body.appendChild(root);

  var elBubble = root.querySelector('.sav-bubble');
  var elPanel = root.querySelector('.sav-panel');
  var elMessages = root.querySelector('.sav-messages');
  var elInput = root.querySelector('.sav-input');
  var elSend = root.querySelector('.sav-send');
  var elDot = root.querySelector('.sav-dot');
  var elClose = root.querySelector('.sav-header-close');

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------
  // 5. Rendu des messages
  // ------------------------------------------------------------
  var messages = loadLocalHistory(); // [{role:'user'|'bot'|'error', text:'...'}]
  var hasOpenedOnce = messages.length > 0;

  function renderAll() {
    elMessages.innerHTML = '';
    if (messages.length === 0) {
      appendBubble('bot', config.welcomeMessage, false);
    } else {
      messages.forEach(function (m) {
        appendBubble(m.role, m.text, false);
      });
    }
    scrollToBottom();
  }

  function appendBubble(role, text, persist) {
    var div = document.createElement('div');
    div.className = 'sav-msg ' + role;
    div.textContent = text;
    elMessages.appendChild(div);
    if (persist) {
      messages.push({ role: role, text: text });
      saveLocalHistory(messages);
    }
    scrollToBottom();
  }

  var typingEl = null;
  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'sav-typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    elMessages.appendChild(typingEl);
    scrollToBottom();
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  function scrollToBottom() {
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  // ------------------------------------------------------------
  // 6. Ouverture / fermeture
  // ------------------------------------------------------------
  function openPanel() {
    root.classList.add('open');
    elPanel.setAttribute('aria-hidden', 'false');
    elDot.style.display = 'none';
    if (!hasOpenedOnce) {
      renderAll();
      hasOpenedOnce = true;
    }
    setTimeout(function () { elInput.focus(); }, 150);
  }
  function closePanel() {
    root.classList.remove('open');
    elPanel.setAttribute('aria-hidden', 'true');
  }
  elBubble.addEventListener('click', function () {
    root.classList.contains('open') ? closePanel() : openPanel();
  });
  elClose.addEventListener('click', closePanel);

  // ------------------------------------------------------------
  // 7. Envoi des messages -> POST {apiUrl}/api/chat
  // ------------------------------------------------------------
  function autoGrow() {
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 90) + 'px';
  }
  elInput.addEventListener('input', autoGrow);

  elInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  elSend.addEventListener('click', sendMessage);

  var sending = false;
  function sendMessage() {
    var text = elInput.value.trim();
    if (!text || sending) return;

    appendBubble('user', text, true);
    elInput.value = '';
    autoGrow();

    sending = true;
    elSend.disabled = true;
    showTyping();

    fetch(config.apiUrl + '/chat/' + config.projet, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, message: text })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        hideTyping();
        appendBubble('bot', data.reply || 'Désolé, je n\u2019ai pas de réponse pour le moment.', true);
      })
      .catch(function () {
        hideTyping();
        appendBubble(
          'error',
          'Un problème est survenu, merci de réessayer dans un instant.',
          false
        );
      })
      .finally(function () {
        sending = false;
        elSend.disabled = false;
      });
  }
})();