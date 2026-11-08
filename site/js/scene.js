// GYRE landing scene · "one line, turning" (geometry and motion unchanged, re-lit for the abyss): a glass cube, one jagged line spinning inside it, leaving a trail of light
// that stacks into a sphere and later loosens into dust. Scroll drives everything through five keyframes (one per chapter).
// The trail is a ring buffer of K snapshots × P points; one snapshot is written and uploaded per frame (updateRange only).
window.GYRE = (() => {
  const canvas = document.getElementById("c"); if (!canvas || !window.THREE) return { flare() {} };
  /* ---- keyframes: lo/hi = active part of the line (-1..1), spin turns/s, jag roughness, pitch/yaw/dist camera,
          shift = cube offset (fraction of screen, + moves the cube right), scatter = trails drift into dust, trail = brightness */
  const KEYS = [
    { lo: -1,   hi: 1,    spin: 0.02, jag: 1.7, pitch: 0.04,  yaw: 0.0, dist: 7.4, shift: 0.2,  scatter: 0,   trail: 0.55 }, // one trembling line: a single tick
    { lo: -1,   hi: 0.05, spin: 0.55, jag: 1.0, pitch: -0.38, yaw: 0.9, dist: 7.0, shift: -0.2, scatter: 0,   trail: 1 },    // it turns and remembers: signals
    { lo: -1,   hi: 1,    spin: 0.42, jag: 1.0, pitch: 0.4,   yaw: 1.9, dist: 6.5, shift: 0.2,  scatter: 0,   trail: 1 },    // memory stacks into a sphere: evidence
    { lo: -1,   hi: 1,    spin: 0.3,  jag: 0.8, pitch: 0.1,   yaw: 2.6, dist: 6.8, shift: -0.2, scatter: 0.2, trail: 0.9 },  // held, and judged: forecasts graded
    { lo: 0.86, hi: 1,    spin: 0.7,  jag: 1.5, pitch: 0.18,  yaw: 3.4, dist: 10.5, shift: 0,   scatter: 1.4, trail: 1 }     // then it lets go: your wallet, your keys
  ];
  const P = 190, K = 170;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TAU = Math.PI * 2, fract = (x) => x - Math.floor(x);
  const hash1 = (n) => fract(Math.sin(n * 127.1 + 17.3) * 43758.5453);
  function noise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; }
  const smooth = (t) => t * t * (3 - 2 * t), clamp01 = (v) => Math.min(1, Math.max(0, v)), lerp = (a, b, t) => a + (b - a) * t;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x04121c, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const world = new THREE.Group(); scene.add(world);
  const SHARED = { uTint: { value: new THREE.Color(0x3fe0d0) }, uFoam: { value: new THREE.Color(0xe8f6f5) }, uScale: { value: 500 }, uFrame: { value: 0 }, uK: { value: K }, uTime: { value: 0 }, uScatter: { value: 0 }, uTrail: { value: 1 } };

  /* ---- glass cube ---- */
  const S = 1.12;
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3fe0d0, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending, depthWrite: false });
  world.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(S * 2, S * 2, S * 2)), edgeMat));
  const faceMat = new THREE.ShaderMaterial({
    uniforms: Object.assign({ uS: { value: S }, uFace: { value: 1 } }, SHARED),
    vertexShader: `varying vec2 vUv; varying vec3 vP; void main(){ vUv = uv; vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime; uniform float uS; uniform float uFace; uniform vec3 uTint; varying vec2 vUv; varying vec3 vP;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      void main(){
        float e = min(min(vUv.x,1.-vUv.x), min(vUv.y,1.-vUv.y));
        float glow = exp(-e*16.)*.22 + smoothstep(.1,-1.,vP.y/uS)*.16 + step(vP.y,-uS*.99)*exp(-length(vP.xz)*1.6)*.32;
        float grain = smoothstep(.35, 1., h(gl_FragCoord.xy + fract(uTime*7.)*91.));
        gl_FragColor = vec4(uTint, (.025 + glow)*(.25 + 1.6*grain)*uFace);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  world.add(new THREE.Mesh(new THREE.BoxGeometry(S * 2, S * 2, S * 2), faceMat));

  /* ---- trails: ring buffer of K snapshots of the line ---- */
  const V = K * P;
  const tPos = new Float32Array(V * 3), tStamp = new Float32Array(V).fill(-1e9), tRnd = new Float32Array(V);
  for (let i = 0; i < V; i++) tRnd[i] = Math.random();
  const posAttr = new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage);
  const stampAttr = new THREE.BufferAttribute(tStamp, 1).setUsage(THREE.DynamicDrawUsage);
  const rndAttr = new THREE.BufferAttribute(tRnd, 1);
  const idx = new Uint32Array(K * P * 2);
  for (let s = 0; s < K; s++) for (let p = 0; p < P; p++) { const k = (s * P + p) * 2; idx[k] = s * P + p; idx[k + 1] = ((s + 1) % K) * P + p; }
  const idxAttr = new THREE.BufferAttribute(idx, 1);
  function trailGeo(indexed) { const g = new THREE.BufferGeometry(); g.setAttribute("position", posAttr); g.setAttribute("aStamp", stampAttr); g.setAttribute("aRnd", rndAttr); if (indexed) g.setIndex(idxAttr); return g; }
  const TRAIL_V = `attribute float aStamp; attribute float aRnd;
    uniform float uFrame; uniform float uK; uniform float uScale; uniform float uSize; uniform float uScatter; uniform float uTrail; uniform float uTime;
    varying float vA;
    void main(){
      float age = (uFrame - aStamp)/uK;
      vA = (age < 0. || age > 1.) ? 0. : pow(1. - age, 1.5);
      vec3 p = position;
      float s = uScatter*age*(.35 + aRnd);
      p += normalize(p + vec3(.0001))*s*.6 + vec3(sin(aRnd*40. + uTime)*.15, .5, cos(aRnd*31. + uTime)*.15)*s;
      vec4 mv = modelViewMatrix*vec4(p,1.);
      gl_PointSize = uSize*uScale/max(.1,-mv.z)*(.6 + aRnd*.8);
      vA *= (.55 + .45*aRnd)*uTrail;
      gl_Position = projectionMatrix*mv;
    }`;
  const lineMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uSize: { value: 0 }, uAlpha: { value: 0.16 } }, SHARED),
    vertexShader: TRAIL_V, fragmentShader: `uniform float uAlpha; uniform float uScatter; uniform vec3 uTint; uniform vec3 uFoam; varying float vA; void main(){ gl_FragColor = vec4(mix(uTint, uFoam, vA*.5), vA*uAlpha*(1. - min(uScatter,1.)*.6)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const dotMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uSize: { value: 0.008 }, uAlpha: { value: 0.55 } }, SHARED),
    vertexShader: TRAIL_V, fragmentShader: `uniform float uAlpha; uniform float uScatter; uniform vec3 uTint; varying float vA;
      void main(){ float d = smoothstep(.5, .1, length(gl_PointCoord - .5)); gl_FragColor = vec4(uTint, d*vA*uAlpha*(1. + uScatter*.8)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const geoA = trailGeo(true), geoB = trailGeo(true), geoD = trailGeo(false);
  [new THREE.LineSegments(geoA, lineMat), new THREE.LineSegments(geoB, lineMat), new THREE.Points(geoD, dotMat)].forEach((o) => { o.frustumCulled = false; world.add(o); });

  const gPos = new Float32Array(P * 3), gAlpha = new Float32Array(P);
  const genGeo = new THREE.BufferGeometry();
  genGeo.setAttribute("position", new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage));
  genGeo.setAttribute("aA", new THREE.BufferAttribute(gAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const gen = new THREE.Line(genGeo, new THREE.ShaderMaterial({ uniforms: { uFoam: SHARED.uFoam },
    vertexShader: `attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uFoam; varying float vA; void main(){ gl_FragColor = vec4(uFoam, vA*.9); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  gen.frustumCulled = false; world.add(gen);

  /* ---- the spinning line, driven by the blended keyframe ---- */
  let theta = 0, frame = 0, head = 0, time = 0, pulse = 0;
  function writeSnapshot(dt, k) {
    theta += TAU * k.spin * dt;
    const R = 0.82, Ry = 0.8, base = head * P * 3, jag = k.jag + pulse * 1.6;
    for (let i = 0; i < P; i++) {
      const u = i / (P - 1), yN = u * 2 - 1, on = yN >= k.lo - 0.001 && yN <= k.hi + 0.001;
      const prof = Math.sqrt(Math.max(0, 1 - yN * yN));
      const open = clamp01(k.spin * 3);
      let r = lerp(0.04, R * prof * (0.86 + 0.14 * noise1(u * 3)), open);
      r += ((noise1(u * 26 + time * 0.6) - 0.5) * 0.09 + (noise1(u * 90 + time * 2.3) - 0.5) * 0.035) * jag;
      r += Math.sin(theta * 2 + u * 31 + time * 0.8) * 0.028 * prof * open;
      const y = yN * Ry + (noise1(u * 45 + time * 2.7) - 0.5) * 0.022 * jag + Math.sin(theta * 3 + u * 17) * 0.012 * open;
      const a = theta + (noise1(u * 12) - 0.5) * 0.35;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      tPos[base + i * 3] = x; tPos[base + i * 3 + 1] = y; tPos[base + i * 3 + 2] = z;
      tStamp[head * P + i] = on ? frame : -1e9;
      gPos[i * 3] = x; gPos[i * 3 + 1] = y; gPos[i * 3 + 2] = z;
      const edgeFade = Math.min(clamp01((yN - k.lo) * 14), clamp01((k.hi - yN) * 14));
      gAlpha[i] = on ? edgeFade * (0.55 + 0.45 * noise1(u * 60 + time * 5)) : 0;
    }
    posAttr.updateRange = { offset: base, count: P * 3 }; posAttr.needsUpdate = true;
    stampAttr.updateRange = { offset: head * P, count: P }; stampAttr.needsUpdate = true;
    genGeo.attributes.position.needsUpdate = true; genGeo.attributes.aA.needsUpdate = true;
    geoA.setDrawRange((head + 1) * P * 2, (K - 1 - head) * P * 2);
    geoB.setDrawRange(0, head * P * 2);
    SHARED.uFrame.value = frame;
    frame++; head = (head + 1) % K;
  }

  /* ---- scroll state ---- */
  const chapters = [...document.querySelectorAll(".chapter")];
  const fill = document.getElementById("fill"), hint = document.getElementById("hint");
  const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("in", e.isIntersecting)), { threshold: 0.45 });
  chapters.forEach((c) => io.observe(c));
  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const last = Math.max(1, Math.min(KEYS.length, chapters.length) - 1);
  let prog = 0;
  function blendKeys(p) {
    const i = Math.min(Math.floor(p), KEYS.length - 2), t = smooth(clamp01(p - i)), A = KEYS[i], B = KEYS[i + 1], o = {};
    for (const key in A) o[key] = lerp(A[key], B[key], t);
    return o;
  }
  // progress is measured against the chapters only, so the footer below them does not stretch the story
  function storyProgress() { const end = chapters.length ? chapters[chapters.length - 1].offsetTop : maxScroll(); return clamp01(scrollY / Math.max(1, end)) * last; }

  /* ---- pointer parallax ---- */
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener("pointermove", (e) => { ptr.x = e.clientX / innerWidth * 2 - 1; ptr.y = e.clientY / innerHeight * 2 - 1; }, { passive: true });

  let W = 1, H = 1, mobile = false;
  function resize() {
    W = innerWidth; H = innerHeight; const dpr = Math.min(devicePixelRatio, 2);
    renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
    camera.aspect = W / H; mobile = camera.aspect < 0.85; camera.updateProjectionMatrix();
    SHARED.uScale.value = H * dpr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }
  addEventListener("resize", resize);

  /* ---- a live alert makes the line shiver and the trail flash for a moment ---- */
  function flare(strength = 1) { pulse = Math.min(2, pulse + 0.7 * strength); }

  let lastT = performance.now();
  function loop(now) {
    const dt = Math.min(1 / 30, (now - lastT) / 1000); lastT = now;
    time += dt; SHARED.uTime.value = time; pulse *= Math.pow(0.08, dt);
    const target = storyProgress();
    prog += (target - prog) * Math.min(1, dt * (reduceMotion ? 20 : 3.2));
    const k = blendKeys(prog);
    writeSnapshot(dt, k);
    SHARED.uScatter.value = k.scatter; SHARED.uTrail.value = k.trail + pulse * 0.5;
    faceMat.uniforms.uFace.value = 1 - k.scatter * 0.35 + pulse * 0.4;
    edgeMat.opacity = 0.62 - k.scatter * 0.2 + pulse * 0.25;
    if (fill) fill.style.height = (prog / last * 100) + "%";
    if (hint) hint.style.opacity = prog < 0.15 ? 1 : 0;

    ptr.sx = lerp(ptr.sx, reduceMotion ? 0 : ptr.x, Math.min(1, dt * 2));
    ptr.sy = lerp(ptr.sy, reduceMotion ? 0 : ptr.y, Math.min(1, dt * 2));
    const yaw = k.yaw + time * (reduceMotion ? 0 : 0.05) + ptr.sx * 0.25;
    const pitch = k.pitch - ptr.sy * 0.12;
    const dist = k.dist * (mobile ? 1.8 : 1);
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
    camera.lookAt(0, 0, 0);
    if (mobile) camera.setViewOffset(W, H, 0, H * 0.25, W, H); else camera.setViewOffset(W, H, -k.shift * W, 0, W, H);   // phones: lift the cube clear of the copy, which sits low
    world.rotation.y = smooth(clamp01(prog - 3)) * 0.5;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  resize();
  requestAnimationFrame(loop);
  return { flare, chapters: chapters.length };
})();
