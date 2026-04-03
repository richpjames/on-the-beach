declare global {
  interface Window {
    __player: { load: typeof load; stop: typeof stop };
  }
}

let clockInterval: ReturnType<typeof setInterval> | null = null;

let windowEl: HTMLElement;
let titleEl: HTMLElement;
let bodyEl: HTMLElement;
let npBtnEl: HTMLButtonElement;
let npLabelEl: HTMLElement;

export function initPlayer(): void {
  windowEl = document.getElementById("now-playing-player") as HTMLElement;
  titleEl = document.getElementById("player-title-text") as HTMLElement;
  bodyEl = document.getElementById("player-body") as HTMLElement;
  npBtnEl = document.getElementById("taskbar-np-btn") as HTMLButtonElement;
  npLabelEl = document.getElementById("taskbar-np-label") as HTMLElement;

  document.getElementById("player-close")?.addEventListener("click", stop);
  document.getElementById("player-minimize")?.addEventListener("click", minimize);
  npBtnEl.addEventListener("click", toggleWindow);

  initDrag();
  initClock();

  window.__player = { load, stop };
}

function load(
  src: string,
  title: string,
  artist: string,
  playerType: "audio" | "video" = "audio",
): void {
  const label = artist ? `${artist} — ${title}` : title;

  bodyEl.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = playerType === "video" ? "YouTube player" : "Bandcamp player";
  iframe.setAttribute("seamless", "");
  iframe.setAttribute("allow", "autoplay; encrypted-media");
  windowEl.classList.remove("player-window--video", "player-window--apple-music");
  if (playerType === "video") {
    iframe.setAttribute(
      "allow",
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
    );
    iframe.allowFullscreen = true;
    windowEl.classList.add("player-window--video");
  } else if (src.includes("embed.music.apple.com")) {
    windowEl.classList.add("player-window--apple-music");
  }
  bodyEl.appendChild(iframe);
  titleEl.textContent = label;
  npLabelEl.textContent = label;

  npBtnEl.hidden = false;
  delete npBtnEl.dataset.minimized;
  windowEl.hidden = false;
  windowEl.removeAttribute("aria-hidden");
}

function stop(): void {
  bodyEl.innerHTML = "";
  windowEl.classList.remove("player-window--video", "player-window--apple-music");
  npBtnEl.hidden = true;
  windowEl.hidden = true;
  windowEl.setAttribute("aria-hidden", "true");
  windowEl.style.removeProperty("left");
  windowEl.style.removeProperty("top");
  windowEl.style.removeProperty("bottom");
  windowEl.style.removeProperty("right");
}

function minimize(): void {
  windowEl.hidden = true;
  npBtnEl.dataset.minimized = "true";
}

function toggleWindow(): void {
  if (windowEl.hidden) {
    windowEl.hidden = false;
    windowEl.removeAttribute("aria-hidden");
    delete npBtnEl.dataset.minimized;
  } else {
    minimize();
  }
}

function initDrag(): void {
  const titlebar = document.getElementById("player-titlebar")!;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = windowEl.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();

    document.addEventListener(
      "mouseup",
      () => {
        dragging = false;
      },
      { once: true },
    );
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    windowEl.style.left = `${startLeft + (e.clientX - startX)}px`;
    windowEl.style.top = `${startTop + (e.clientY - startY)}px`;
    windowEl.style.bottom = "auto";
    windowEl.style.right = "auto";
  });
}

function initClock(): void {
  const clockEl = document.getElementById("taskbar-clock");
  if (!clockEl) return;

  function tick(): void {
    const now = new Date();
    clockEl!.textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  tick();
  if (clockInterval !== null) clearInterval(clockInterval);
  clockInterval = setInterval(tick, 10_000);
}
