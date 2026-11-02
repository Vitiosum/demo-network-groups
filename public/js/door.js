// The vault door: engraving, bolts and dial are drawn here, then animated on demand.
const NS = "http://www.w3.org/2000/svg";
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : ms));

function svg(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.append(node);
  return node;
}

// Guilloché: woven rosettes, the engraving found on banknotes and safe dials.
function guilloche(group, { cx, cy, inner, outer, petals, curves, wobble = 0 }) {
  for (let k = 0; k < curves; k++) {
    const phase = (k / curves) * 2 * Math.PI; // each curve shifted by a fraction of one petal
    let d = "";
    for (let i = 0; i <= 720; i++) {
      const t = (i / 720) * 2 * Math.PI;
      const r = inner + (outer - inner) * (0.5 + 0.5 * Math.sin(petals * t + phase)) + wobble * Math.sin(petals * 3 * t - phase);
      d += `${i ? "L" : "M"}${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
    }
    svg("path", { d: `${d}Z` }, group);
  }
}

function rivets(group, { cx, cy, r, count, size }) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    svg("circle", { cx: (cx + r * Math.cos(a)).toFixed(2), cy: (cy + r * Math.sin(a)).toFixed(2), r: size }, group);
  }
}

export function createDoor(vault) {
  const dial = vault.querySelector("#dial");

  // Engraving: the door plate, the dial face and a faint watermark around the frame.
  guilloche(vault.querySelector("#doorGuilloche"), { cx: 200, cy: 200, inner: 112, outer: 142, petals: 28, curves: 24, wobble: 1.5 });
  guilloche(vault.querySelector("#doorGuilloche"), { cx: 200, cy: 200, inner: 74, outer: 104, petals: 20, curves: 20, wobble: 1 });
  guilloche(vault.querySelector("#dialGuilloche"), { cx: 200, cy: 200, inner: 19, outer: 31, petals: 14, curves: 14 });
  guilloche(vault.querySelector("#rosette"), { cx: 300, cy: 300, inner: 262, outer: 288, petals: 48, curves: 16, wobble: 1.5 });
  rivets(vault.querySelector("#doorRivets"), { cx: 200, cy: 200, r: 187, count: 24, size: 3.2 });
  rivets(vault.querySelector("#frameRivets"), { cx: 200, cy: 200, r: 186, count: 32, size: 3.4 });

  // Dial: 100 graduations, a number every 10, each one upright along its radius.
  const ticks = vault.querySelector("#dialTicks");
  for (let n = 0; n < 100; n++) {
    const a = (n / 100) * 2 * Math.PI - Math.PI / 2;
    const r1 = n % 5 === 0 ? 44.5 : 48;
    svg("line", {
      x1: (200 + r1 * Math.cos(a)).toFixed(2), y1: (200 + r1 * Math.sin(a)).toFixed(2),
      x2: (200 + 53 * Math.cos(a)).toFixed(2), y2: (200 + 53 * Math.sin(a)).toFixed(2),
      "stroke-width": n % 10 === 0 ? 1.4 : 0.6,
    }, ticks);
    if (n % 10 === 0) {
      const label = svg("text", { x: (200 + 37 * Math.cos(a)).toFixed(2), y: (200 + 37 * Math.sin(a)).toFixed(2), transform: `rotate(${n * 3.6} ${(200 + 37 * Math.cos(a)).toFixed(2)} ${(200 + 37 * Math.sin(a)).toFixed(2)})` }, ticks);
      label.textContent = String(n);
    }
  }

  // Bolts all around the edge: they lock into the frame.
  const bolts = vault.querySelector("#bolts");
  for (let i = 0; i < 12; i++) {
    const bolt = document.createElement("span");
    bolt.className = "bolt";
    bolt.style.setProperty("--a", `${15 + i * 30}deg`);
    bolts.append(bolt);
  }

  let angle = 0; // current dial rotation, in degrees
  const turn = async (to, duration) => {
    if (reducedMotion) {
      dial.style.transform = `rotate(${to}deg)`;
    } else {
      await dial.animate([{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${to}deg)` }], {
        duration, easing: "cubic-bezier(.45,.05,.25,1)", fill: "forwards",
      }).finished;
    }
    angle = to;
  };

  // Right to the first number (two full turns first), left to the second, right to the third.
  async function dialCombination([a, b, c]) {
    const base = angle - (((angle % 360) + 360) % 360);
    const first = base + 720 + ((100 - a) % 100) * 3.6;
    const second = first - 360 - (((b - a + 100) % 100) * 3.6);
    const third = second + (((b - c + 100) % 100) * 3.6);
    await turn(first, 1100);
    await turn(second, 900);
    await turn(third, 600);
  }

  return {
    async open(combination) {
      await dialCombination(combination);
      vault.dataset.state = "unlocking"; // handle turns, bolts retract
      await wait(900);
      vault.dataset.state = "open"; // the door swings
      await wait(1700);
    },
    async close() {
      vault.dataset.state = "unlocking"; // the door swings back, bolts still in
      await wait(1800);
      vault.dataset.state = "locked";
      await wait(600);
    },
    alarm() {
      vault.classList.remove("is-alarm", "is-shaking");
      void vault.offsetWidth; // restart the animations
      vault.classList.add("is-alarm", "is-shaking");
      setTimeout(() => vault.classList.remove("is-shaking"), 650);
      setTimeout(() => vault.classList.remove("is-alarm"), 2800);
    },
  };
}

// Moves a marker along a track: 0 is the left end, 1 the right end.
export function travel(marker, track, from, to, duration, easing = "cubic-bezier(.55,0,.25,1)", stop = null) {
  const max = (stop ?? track.clientWidth - marker.offsetWidth - 8);
  const keyframes = [{ transform: `translateX(${from * max}px)` }, { transform: `translateX(${to * max}px)` }];
  if (reducedMotion) {
    marker.style.transform = keyframes[1].transform;
    return Promise.resolve();
  }
  return marker.animate(keyframes, { duration, easing, fill: "forwards" }).finished;
}
