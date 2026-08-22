/* One line icon per category, drawn on a 24x24 grid with a 1.7 stroke so
   they sit consistently next to 14–15px text. Kept as raw path data rather
   than files so a category chip costs no extra request. */
window.CATEGORY_ICONS = {
  'ai-agents':      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  'ai-media':       '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="m3 14 4-4 4 4 3-3 4 4"/><circle cx="8.5" cy="8.5" r="1.2"/>',
  'dev-tools':      '<path d="m9 18-6-6 6-6M15 6l6 6-6 6"/>',
  'infrastructure': '<rect x="3" y="4" width="18" height="6" rx="1.6"/><rect x="3" y="14" width="18" height="6" rx="1.6"/><path d="M7 7h.01M7 17h.01"/>',
  'seo':            '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.7-4.7M8 11l2 2 3.5-4"/>',
  'marketing':      '<path d="M3 11v3a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1Z"/><path d="M17 8a5 5 0 0 1 0 8"/>',
  'sales':          '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
  'social':         '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.7 7.4-4.3M8.3 13.3l7.4 4.3"/>',
  'writing':        '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'design':         '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 1 0 0 20c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-5-4-9-9-9Z"/>',
  'productivity':   '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8.5 15l2 2 4-4"/>',
  'analytics':      '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="13" y="7" width="3" height="10" rx="1"/>',
  'finance':        '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  'ecommerce':      '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  'hiring':         '<rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M2.5 12h19"/>',
  'education':      '<path d="m12 4 10 5-10 5L2 9Z"/><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
  'health':         '<path d="M20.5 6.5a5 5 0 0 0-8.5-2 5 5 0 0 0-8.5 2c0 5 8.5 11 8.5 11s8.5-6 8.5-11Z"/>',
  'crypto':         '<circle cx="12" cy="12" r="9"/><path d="M9.5 8h4a2.5 2.5 0 0 1 0 5h-4h4.5a2.5 2.5 0 0 1 0 5H9.5M11 6v12"/>',
  'security':       '<path d="M12 2.5 4.5 6v6c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  'games':          '<rect x="2.5" y="7" width="19" height="11" rx="4"/><path d="M7.5 11v3M6 12.5h3M15.5 12h.01M18 14h.01"/>',
  'travel':         '<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  'agencies':       '<path d="M3 21V8l6-4 6 4v13"/><path d="M15 21V11l6 3v7M3 21h18M7 12h.01M7 16h.01M11 12h.01M11 16h.01"/>',
  'domains':        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 2.5 15.2 0 18M12 3c-2.5 2.8-2.5 15.2 0 18"/>',
  'profiles':       '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  'other':          '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  '__all':          '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>'
};

window.categoryIcon = function(slug){
  var d = window.CATEGORY_ICONS[slug] || window.CATEGORY_ICONS.other;
  return '<svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
       + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
       + d + '</svg>';
};
