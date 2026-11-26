// The photo and contact links render immediately. Only load footage when it can play.
const film = document.querySelector('#shop-film');
if (film) {
  const control = document.querySelector('.hero-playback');
  const stage = film.closest('.cinematic-stage');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const prefersStill = () => motion.matches || navigator.connection?.saveData === true;
  let wantsPlayback = !prefersStill();
  let inView = false;
  let generation = 0;
  function sync() {
    const current = ++generation;
    if (!wantsPlayback || !inView || document.hidden) {
      film.pause();
      control.textContent = 'Play video';
      return;
    }
    if (!film.hasAttribute('src')) {
      film.src = matchMedia('(max-width: 700px)').matches ? film.dataset.phone : film.dataset.desktop;
    }
    control.textContent = 'Pause video';
    film.play().catch(() => {
      if (current !== generation) return;
      wantsPlayback = false;
      control.textContent = 'Play video';
    });
  }
  film.addEventListener('playing', () => { film.classList.add('has-frame'); });
  film.addEventListener('error', () => {
    film.classList.remove('has-frame');
    control.hidden = true;
  });
  control.hidden = false;
  control.addEventListener('click', () => { wantsPlayback = !wantsPlayback; sync(); });
  function preferenceChanged() {
    if (prefersStill()) { wantsPlayback = false; sync(); film.classList.remove('has-frame'); }
  }
  motion.addEventListener('change', preferenceChanged);
  navigator.connection?.addEventListener('change', preferenceChanged);
  document.addEventListener('visibilitychange', sync);
  if ('IntersectionObserver' in window && typeof IntersectionObserver === 'function') {
    new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }).observe(stage);
  } else {
    inView = true;
    sync();
  }
}

// Mobile menu: toggles, closes on Escape or link click, returns focus to the button.
const toggle = document.querySelector(".menu-toggle");
const nav = document.getElementById("site-nav");
function setMenu(open, { focusToggle = false } = {}) {
  toggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("menu-open", open);
  if (open) nav.querySelector("a")?.focus();
  else if (focusToggle) toggle.focus();
}
toggle?.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
nav?.addEventListener("click", (e) => e.target.closest("a") && setMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("menu-open")) setMenu(false, { focusToggle: true });
});
matchMedia("(min-width: 901px)").addEventListener("change", (e) => e.matches && setMenu(false));

// On the homepage, reveal the phone contact bar after the main actions pass the header.
// Keep the ordinary bar when observation is unavailable, including without JavaScript.
// Observe the introduction through its final actions, so short screens also catch
// jumps from above the buttons to below them without an intermediate scroll frame.
const contactIntro = document.querySelector('.cinematic-copy');
if (contactIntro && typeof IntersectionObserver === 'function') {
  const root = document.documentElement;
  let contactObserver;
  const watchContactActions = () => {
    contactObserver?.disconnect();
    const headerHeight = parseFloat(getComputedStyle(root).getPropertyValue('--header')) || 0;
    contactObserver = new IntersectionObserver(([entry]) => {
      root.classList.toggle('contact-past-hero', !entry.isIntersecting && entry.boundingClientRect.bottom <= headerHeight);
    }, { rootMargin: `-${headerHeight}px 0px 0px 0px` });
    contactObserver.observe(contactIntro);
  };
  root.classList.add('contact-enhanced');
  watchContactActions();
  for (const query of ['(max-width: 700px)', '(max-width: 900px)']) {
    matchMedia(query).addEventListener('change', watchContactActions);
  }
}

// Hero tabs (manual only: no auto-rotation). Arrow keys, Home and End move between tabs.
const tabs = [...document.querySelectorAll(".hero-tabs [role=tab]")];
function select(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls"));
    panel.hidden = !on;
    panel.classList.toggle("is-active", on);
  }
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => select(t));
  t.addEventListener("keydown", (e) => {
    const target = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[e.key];
    if (!target) return;
    e.preventDefault();
    select(target);
    target.focus();
  });
});

// Videos: autoplay only when the visitor hasn't asked for reduced motion; always pausable (WCAG 2.2.2).
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
for (const video of document.querySelectorAll("video[data-autoplay]")) {
  const button = video.parentElement.querySelector(".video-toggle");
  const sync = () => {
    button.setAttribute("aria-pressed", String(video.paused));
    button.textContent = video.paused ? "Play video" : "Pause video";
  };
  video.addEventListener("play", sync);
  video.addEventListener("pause", sync);
  button.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
  if (!still) video.play().catch(sync);
  sync();
}

// Appointment form: validates locally with per-field messages; nothing is sent while the site is a preview.
const form = document.querySelector("form#appointment");
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const status = form.querySelector(".form-status");
  const invalid = [];
  for (const field of form.querySelectorAll("[required]")) {
    const bad = field.type === "tel" ? field.value.replace(/\D/g, "").length < 10 : !field.value.trim();
    field.setAttribute("aria-invalid", String(bad));
    document.getElementById(field.getAttribute("aria-describedby")).hidden = !bad;
    if (bad) invalid.push(field);
  }
  if (invalid.length) {
    status.textContent = `Please fix ${invalid.length === 1 ? "1 field" : `${invalid.length} fields`} above.`;
    invalid[0].focus();
    return;
  }
  status.textContent = form.dataset.previewNote;
});
