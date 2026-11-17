/* ===========================================================================
   INTRO — plays once when the app loads.

   1. three clips back to back (preloaded, next starts on the frame the
      previous one ends), video layer fades in over fadeInMs
   2. black burst: a circle grows from the notch centre until it covers the
      whole screen (ease-in) + an 80ms white-blue flash at the notch
   3. hold: fully black for holdMs, video layer hidden
   4. reveal: the circle shrinks back into the notch (ease-out); everything
      outside it is transparent so the real desktop shows through
   5. cleanup: videos freed, overlay removed by main, notch takes over

   skipIntro() (Esc / click, exposed too) jumps straight to step 4.
   =========================================================================== */

(async function () {
  const info = await window.notch.introInfo();      // { config, clips, originY }
  const CONFIG = info.config;
  const CLIPS = info.clips;                          // absolute file:// URLs
  const ORIGIN_Y = info.originY;                     // notch bottom edge (DIP, display-relative)

  const layer = document.getElementById("videoLayer");
  const vids = [document.getElementById("clip0"),
                document.getElementById("clip1"),
                document.getElementById("clip2")];
  const burst = document.getElementById("burst");
  const flash = document.getElementById("flash");

  layer.style.setProperty("--fade-ms", CONFIG.fadeInMs + "ms");

  let phase = "idle";        // idle | video | burst | hold | reveal | done
  let origin = { x: 0, y: 0 };
  let rMax = 0;              // radius that reaches the farthest corner
  let rFinal = CONFIG.finalRadius;

  const log = (m) => console.log("INTRO " + m);     // → debug.log via main

  /* ---- geometry: notch centre + radius that covers every pixel -------- */
  function geometry() {
    // CSS px == DIP here, so this is correct on HiDPI and any screen size.
    const W = window.screen.width;
    const H = window.screen.height;
    origin = { x: W / 2, y: ORIGIN_Y };             // top centre, notch bottom
    const corners = [[0, 0], [W, 0], [0, H], [W, H]];
    rMax = Math.max(...corners.map(([cx, cy]) =>
      Math.hypot(cx - origin.x, cy - origin.y))) + 8;   // +8px pad: no uncovered pixel
    rFinal = Math.min(CONFIG.finalRadius, rMax);

    const d = rMax * 2;
    burst.style.width = d + "px";
    burst.style.height = d + "px";
    burst.style.left = (origin.x - rMax) + "px";
    burst.style.top = (origin.y - rMax) + "px";

    const fd = 220;
    flash.style.width = fd + "px";
    flash.style.height = fd + "px";
    flash.style.left = (origin.x - fd / 2) + "px";
    flash.style.top = (origin.y - fd / 2) + "px";
    log("geom screen=" + W + "x" + H + " origin=" + Math.round(origin.x) + "," +
        Math.round(origin.y) + " rMax=" + Math.round(rMax));
  }

  const anims = (el) => el.getAnimations ? el.getAnimations() : [];

  /* ---- step 1: videos ------------------------------------------------- */
  function reset() {
    anims(burst).forEach((a) => a.cancel());
    anims(flash).forEach((a) => a.cancel());
    burst.style.transform = "scale(0)";
    flash.style.opacity = "0";
    layer.style.display = "";
    layer.style.opacity = "0";
    vids.forEach((v, i) => {
      try { v.pause(); v.currentTime = 0; } catch {}
      v.classList.toggle("on", i === 0);
    });
  }

  function startIntro() {
    if (phase !== "idle" && phase !== "done") return;   // already running
    reset();
    geometry();
    phase = "video";
    log("start clips=" + CLIPS.map((c) => c.split("/").pop()).join(","));

    // Wait until all three are decoded to their first frame, then fade in
    // and play clip1. Clips 2/3 get a play()+pause() warm-up so their first
    // frame is paint-ready when their turn comes (zero-gap handoff).
    const ready = vids.map((v, i) => new Promise((res) => {
      if (v.readyState >= 2) return res();
      v.addEventListener("loadeddata", res, { once: true });
      v.addEventListener("error", () => { log("clip" + i + " load error"); res(); }, { once: true });
      setTimeout(res, 2500);                       // never deadlock the intro
    }));

    Promise.all(ready).then(() => {
      if (phase !== "video") return;
      vids.forEach((v, i) => {
        if (i === 0) return;                       // clip0 plays below, no warm-up race
        v.play().then(() => { v.pause(); v.currentTime = 0; }).catch(() => {});
      });
      layer.style.opacity = "1";                   // 150ms fade-in
      vids[0].play().catch((e) => log("play0 " + e.message));
      log("clip1");
    });
  }

  function swapTo(j) {
    const next = vids[j];
    const prev = vids[j - 1];
    const go = () => {
      next.currentTime = 0;
      next.classList.add("on");                    // same tick as prev hides:
      next.play().catch(() => {});                 // compositor commits both
      prev.classList.remove("on");                 // together → no flicker
      prev.pause();
      log("clip" + (j + 1));
    };
    if (next.readyState >= 2) go();                // preloaded → starts on the
    else next.addEventListener("canplay", go, { once: true });  // previous end frame
  }

  vids.forEach((v, i) => {
    v.src = CLIPS[i];
    v.addEventListener("ended", () => {
      if (phase !== "video") return;
      if (i < vids.length - 1) swapTo(i + 1);
      else toBurst();                              // clip3 ends → burst now
    });
  });

  /* ---- step 2: black burst ------------------------------------------- */
  function toBurst() {
    if (phase !== "video") return;
    phase = "burst";
    log("burst");
    flash.style.opacity = "1";
    anims(flash).forEach((a) => a.cancel());
    flash.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: CONFIG.flashMs, easing: "ease-out", fill: "forwards" });

    const grow = burst.animate(
      [{ transform: "scale(0)" }, { transform: "scale(1)" }],
      { duration: CONFIG.burstMs, easing: CONFIG.burstEase, fill: "forwards" });
    grow.finished.then(() => { if (phase === "burst") toHold(); }).catch(() => {});
  }

  /* ---- step 3: hold (hide the videos while fully black) --------------- */
  function toHold() {
    phase = "hold";
    vids.forEach((v) => v.pause());
    layer.style.display = "none";                  // video layer hidden
    log("hold");
    setTimeout(() => { if (phase === "hold") toReveal(); }, CONFIG.holdMs);
  }

  /* ---- step 4: reveal — outside the circle is transparent ------------- */
  function toReveal() {
    phase = "reveal";
    log("reveal rFinal=" + rFinal);
    const shrink = burst.animate(
      [{ transform: "scale(1)" }, { transform: "scale(" + (rFinal / rMax) + ")" }],
      { duration: CONFIG.revealMs, easing: CONFIG.revealEase, fill: "forwards" });
    shrink.finished.then(() => { if (phase === "reveal") finish(); }).catch(() => {});
  }

  /* ---- step 5: cleanup ------------------------------------------------ */
  function freeVideos() {
    vids.forEach((v) => {
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch {}   // release decoders
      v.remove();
    });
  }

  function finish() {
    if (phase === "done") return;
    phase = "done";
    log("done");
    freeVideos();
    window.notch.introDone();                      // main shows the notch + removes us
  }

  /* ---- skip: straight to step 4 (Esc / click, via main) --------------- */
  function skipIntro() {
    if (phase === "video" || phase === "burst") {
      // jump to step 4's starting state: instantly full black
      anims(burst).forEach((a) => a.cancel());
      anims(flash).forEach((a) => a.cancel());
      flash.style.opacity = "0";
      burst.style.transform = "scale(1)";
      vids.forEach((v) => v.pause());
      layer.style.display = "none";
      log("skip → reveal");
      toReveal();
    } else if (phase === "hold") {
      log("skip hold → reveal");
      toReveal();
    } else if (phase === "reveal") {
      anims(burst).forEach((a) => a.cancel());
      burst.style.transform = "scale(" + (rFinal / rMax) + ")";
      log("skip reveal → done");
      finish();
    }
  }

  window.notch.onIntroSkip(skipIntro);
  window.startIntro = startIntro;                  // exposed for debugging
  window.skipIntro = skipIntro;

  startIntro();                                     // runs once, on load
})();
