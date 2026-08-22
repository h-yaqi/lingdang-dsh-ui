'use strict';

/**
 * 注入到 GUI 设置页"通用设置"区域的卡片脚本（在页面 main world 中执行）。
 *
 * 策略：
 * - MutationObserver 监听 DOM，找到"通用设置"标题后在其所在容器末尾插入
 *   "关于 dsh-desktop"卡片（版本信息 + 检查更新按钮）；
 * - 防重复注入（window.__dshDesktopInjected + 卡片 id）；
 * - 定时兜底重试（SPA 路由切换/重渲染时卡片可能被移除）。
 * 返回该脚本字符串，由主进程 executeJavaScript 注入。
 */
module.exports = `(function () {
  'use strict';
  if (window.__dshDesktopInjected) return;
  window.__dshDesktopInjected = true;

  var CARD_ID = 'dsh-desktop-about-card';
  var headingTexts = ['通用设置', 'General', '一般设置'];

  function headingEl() {
    var all = document.querySelectorAll('h1,h2,h3,h4,div,span,strong');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 2) continue;
      if (!el.offsetParent) continue;
      var t = (el.textContent || '').trim();
      if (headingTexts.indexOf(t) !== -1) return el;
    }
    return null;
  }

  function containerOf(heading) {
    var c = heading.closest('section') || heading.closest('[class*="card"]') ||
      heading.parentElement && heading.parentElement.parentElement || heading.parentElement;
    return c;
  }

  function buildCard() {
    var card = document.createElement('div');
    card.id = CARD_ID;
    card.style.cssText =
      'margin:14px 2px;padding:14px 18px;border:1px solid rgba(127,127,127,.28);' +
      'border-radius:10px;background:rgba(127,127,127,.07);font-size:13px;line-height:1.9;';
    card.innerHTML =
      '<div style="font-weight:700;margin-bottom:8px;">关于 dsh-desktop</div>' +
      '<div>桌面端版本：<b id="dshd-appver">…</b></div>' +
      '<div>dsh 版本：<b id="dshd-dshver">…</b></div>' +
      '<div>Node 版本：<b id="dshd-nodever">…</b></div>' +
      '<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<button id="dshd-checkbtn" style="padding:5px 14px;border-radius:7px;border:1px solid rgba(127,127,127,.45);' +
      'background:transparent;color:inherit;cursor:pointer;font-size:13px;">检查更新</button>' +
      '<span id="dshd-status" style="opacity:.8;"></span></div>';
    return card;
  }

  function ensureCard() {
    var heading = headingEl();
    if (!heading) return false;
    var container = containerOf(heading);
    if (!container) return false;
    if (document.getElementById(CARD_ID)) return true;
    var card = buildCard();
    container.appendChild(card);

    if (window.dshDesktop && window.dshDesktop.getVersions) {
      window.dshDesktop.getVersions().then(function (v) {
        var set = function (id, val) {
          var el = document.getElementById(id);
          if (el) el.textContent = val;
        };
        set('dshd-appver', v.appVersion);
        set('dshd-dshver', v.dshVersion);
        set('dshd-nodever', v.nodeVersion);
      }).catch(function () {
        var el = document.getElementById('dshd-appver');
        if (el) el.textContent = '不可用';
      });
    } else {
      var el = document.getElementById('dshd-appver');
      if (el) el.textContent = '未连接桌面端';
    }

    var btn = document.getElementById('dshd-checkbtn');
    var st = document.getElementById('dshd-status');
    if (btn && window.dshDesktop && window.dshDesktop.checkUpdate) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        st.textContent = '检查中…';
        window.dshDesktop.checkUpdate().then(function (r) {
          st.textContent = (r && r.message) || (r && r.status) || '完成';
          btn.disabled = false;
        }).catch(function () {
          st.textContent = '检查失败';
          btn.disabled = false;
        });
      });
    } else {
      btn.disabled = true;
      st.textContent = '（未连接桌面端，更新不可用）';
    }
    return true;
  }

  var mo = new MutationObserver(function () {
    ensureCard();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(ensureCard, 1200);
  setInterval(function () {
    if (!document.getElementById(CARD_ID)) ensureCard();
  }, 3000);
})();
`;
