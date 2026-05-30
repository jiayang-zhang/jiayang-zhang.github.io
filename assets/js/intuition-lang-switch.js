(function () {
  var storageKey = 'intuitionLanguage';
  function getSavedLanguage() {
    var saved = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch (e) {
      saved = null;
    }
    return saved === 'en' || saved === 'or' ? saved : 'zh';
  }
  function saveLanguage(lang) {
    try {
      localStorage.setItem(storageKey, lang);
    } catch (e) {
      // ignore storage errors
    }
  }
  function updateBlocks(lang) {
    document.querySelectorAll('.lang-block[data-lang]').forEach(function (block) {
      block.style.display = block.dataset.lang === lang ? 'block' : 'none';
    });
    document.querySelectorAll('[data-lang-button]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.langButton === lang);
    });
  }
  function setLanguage(lang) {
    if (lang !== 'en' && lang !== 'or') {
      lang = 'zh';
    }
    saveLanguage(lang);
    updateBlocks(lang);
  }
  function attachSwitcherEvents() {
    document.querySelectorAll('[data-lang-button]').forEach(function (button) {
      button.addEventListener('click', function () {
        setLanguage(button.dataset.langButton);
      });
    });
  }
  function init() {
    if (!document.querySelector('.lang-block[data-lang]')) {
      return;
    }
    var lang = getSavedLanguage();
    setLanguage(lang);
    attachSwitcherEvents();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
