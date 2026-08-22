/* Shared across every page: theme toggle with a safe storage fallback. */
(function(){
  var store = {
    get: function(k){ try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var saved = store.get('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';

  function toggle(){
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  }
  ['themeToggle', 'themeToggleMobile'].forEach(function(id){
    var btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', toggle);
  });
})();
