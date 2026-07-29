(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('themeSelect');
    if (!sel) return;
    sel.value = localStorage.getItem('navilist_theme') || 'auto';
    sel.addEventListener('change', function () {
      localStorage.setItem('navilist_theme', sel.value);
      document.documentElement.setAttribute('data-theme', sel.value);
    });
  });
})();
