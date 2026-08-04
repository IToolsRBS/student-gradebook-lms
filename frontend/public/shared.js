export function renderTime() {
  const timeDateEl = document.getElementById("timeDate");
  const timeClockEl = document.getElementById("timeClock");
  if (!timeDateEl || !timeClockEl) return;
  const now = new Date();
  timeDateEl.textContent = now
    .toLocaleDateString([], { day: "2-digit", month: "short" })
    .toUpperCase();
  timeClockEl.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Keep one layout; shrink on small screens, slight lift on large. */
export function fitUiScale() {
  const designWidth = 1280;
  const minScale = 0.68;
  const maxScale = 1.04;
  const next = Math.min(
    maxScale,
    Math.max(minScale, window.innerWidth / designWidth)
  );
  document.documentElement.style.setProperty("--ui-scale", next.toFixed(4));
}

/** Scale logo, nav, sign out, and time together so the header fits horizontally. */
export function fitSiteHeader() {
  const header = document.querySelector(".site-header");
  const brand = header?.querySelector(".brand");
  const nav = header?.querySelector(".site-nav");
  const actions = header?.querySelector(".top-bar-actions");
  if (!header || !brand || !nav || !actions) return;

  const measureUsed = () => {
    const styles = getComputedStyle(header);
    const gap = parseFloat(styles.columnGap) || 0;
    return brand.offsetWidth + nav.scrollWidth + actions.offsetWidth + gap * 2;
  };

  const applyFit = () => {
    fitUiScale();
    header.style.setProperty("--header-fit", "1");
    void header.offsetWidth;

    const styles = getComputedStyle(header);
    const padX =
      (parseFloat(styles.paddingLeft) || 0) +
      (parseFloat(styles.paddingRight) || 0);
    const available = header.clientWidth - padX;
    if (available <= 0) return;
    if (measureUsed() <= available + 1) return;

    let lo = 0.55;
    let hi = 1;
    let best = 0.55;
    for (let i = 0; i < 12; i += 1) {
      const mid = (lo + hi) / 2;
      header.style.setProperty("--header-fit", String(mid));
      void header.offsetWidth;
      if (measureUsed() <= available + 1) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    header.style.setProperty("--header-fit", String(best));
  };

  applyFit();
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", applyFit);
    return;
  }
  if (!header.dataset.fitBound) {
    header.dataset.fitBound = "1";
    const observer = new ResizeObserver(() => applyFit());
    observer.observe(document.documentElement);
    observer.observe(header);
  }
}

export function startClock() {
  fitUiScale();
  renderTime();
  setInterval(renderTime, 1000);
  fitSiteHeader();
}

export async function loadSignedInUser() {
  const userBar = document.getElementById("userBar");
  const userNameEl = document.getElementById("userName");
  if (!userBar || !userNameEl) return;

  try {
    const response = await fetch("/auth/me", { credentials: "same-origin" });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload?.authenticated || !payload?.user) return;
    const label = payload.user.name || payload.user.email || "Signed in";
    userNameEl.textContent = label;
    userBar.hidden = false;
    fitSiteHeader();
  } catch {
    // Auth may be disabled in local development.
  }
}
