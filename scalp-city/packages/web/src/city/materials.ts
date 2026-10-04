import * as THREE from 'three';

/**
 * Building material with procedural windows computed from world position,
 * so windows keep their size on buildings of any height. Built on
 * MeshStandardMaterial so it keeps scene lighting and fog.
 */
export function createWindowMaterial(opts: { base: string; lit: string; density: number; seed: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: opts.base, roughness: 0.55, metalness: 0.35 });
  const uniforms = {
    uLit: { value: new THREE.Color(opts.lit) },
    uDensity: { value: opts.density },
    uSeed: { value: opts.seed },
    uTime: { value: 0 },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 scWp = vec4(transformed, 1.0);
        vec3 scN = normal;
        #ifdef USE_INSTANCING
          scWp = instanceMatrix * scWp;
          scN = mat3(instanceMatrix) * scN;
        #endif
        scWp = modelMatrix * scWp;
        vWPos = scWp.xyz;
        vWNormal = normalize(mat3(modelMatrix) * scN);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNormal;
        uniform vec3 uLit;
        uniform float uDensity;
        uniform float uSeed;
        uniform float uTime;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32+uSeed); return fract(p.x*p.y); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float side = abs(vWNormal.y) < 0.5 ? 1.0 : 0.0;
          vec2 g = vec2((abs(vWNormal.x) > 0.5 ? vWPos.z : vWPos.x) * 4.4, vWPos.y * 4.8);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.72);
          float on = step(1.0 - uDensity, h21(cell));
          float flicker = 0.85 + 0.15 * sin(uTime * 0.6 + h21(cell + 7.0) * 40.0);
          float tone = h21(cell + 3.1);
          vec3 c = mix(uLit, vec3(0.55, 0.7, 1.0), step(0.7, tone));
          totalEmissiveRadiance += c * win * on * side * flicker * 0.42 * smoothstep(0.2, 1.2, vWPos.y);
        }`,
      );
  };
  (m as THREE.MeshStandardMaterial & { userData: { uniforms: typeof uniforms } }).userData.uniforms = uniforms;
  return m;
}

/** Vertical light beam: bright at the base, fading up. Additive, no depth writes. */
export function createBeamMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      void main() {
        float fade = pow(1.0 - vUv.y, 2.2);
        float band = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 4.0);
        float edge = smoothstep(0.0, 0.5, 1.0 - abs(vUv.x - 0.5) * 2.0);
        gl_FragColor = vec4(uColor * fade * band * edge * uIntensity, fade * uIntensity);
      }`,
  });
}

/** Expanding ground ring used for fills and profit/loss events. */
export function createPulseMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uProgress: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uProgress;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float ring = smoothstep(uProgress - 0.08, uProgress, r) * (1.0 - smoothstep(uProgress, uProgress + 0.02, r));
        float a = ring * (1.0 - uProgress);
        gl_FragColor = vec4(uColor * a * 2.0, a);
      }`,
  });
}

/**
 * Flat charge dial. `uProgress` is the confirmed charge (0–1, from the last
 * closed bar); `uLive` is the forming-bar preview, drawn as a faint ghost so
 * the two are never confused. Tick marks sit at the strategy thresholds.
 */
export function createChargeRingMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uProgress: { value: 0 },
      uLive: { value: 0 },
      uTicks: { value: new THREE.Vector3(0.3, 0.6, 1.0) },
      uTime: { value: 0 },
      uReady: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uProgress;
      uniform float uLive;
      uniform vec3 uTicks;
      uniform float uTime;
      uniform float uReady;
      void main() {
        vec2 p = vUv - 0.5;
        // 0 at twelve o'clock, increasing clockwise as seen from above
        float a = fract(0.25 - atan(p.y, p.x) / 6.28318530718);
        float seg = step(0.012, fract(a * 20.0)) ; // 20 segments with hairline gaps
        float filled = step(a, uProgress);
        float ghost = step(a, uLive) * (1.0 - filled);
        float tick = 0.0;
        tick += 1.0 - smoothstep(0.0, 0.004, abs(a - uTicks.x));
        tick += 1.0 - smoothstep(0.0, 0.004, abs(a - uTicks.y));
        tick += 1.0 - smoothstep(0.0, 0.004, abs(a - min(uTicks.z, 0.999)));
        float pulse = 1.0 + uReady * 0.6 * sin(uTime * 6.0);
        float alpha = seg * (filled * 0.95 * pulse + ghost * 0.22 + 0.06) + tick * 0.5;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }`,
  });
}

/**
 * Tower edge strip that doubles as a charge meter: the bright part climbs to
 * the confirmed charge, a faint ghost shows the live (forming-bar) preview.
 */
export function createMeterMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uFill: { value: 0 },
      uGhost: { value: 0 },
      uIntensity: { value: 1 },
      uBase: { value: 0.16 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uFill;
      uniform float uGhost;
      uniform float uIntensity;
      uniform float uBase;
      void main() {
        float filled = step(vUv.y, uFill);
        float ghost = step(vUv.y, uGhost) * (1.0 - filled);
        float head = filled * (1.0 - smoothstep(0.0, 0.04, uFill - vUv.y)) * step(0.001, uFill);
        float a = uBase + filled * 1.1 + ghost * 0.3 + head * 1.6;
        gl_FragColor = vec4(uColor * a * uIntensity, 1.0);
      }`,
  });
}

/** Vertical sky gradient; the horizon tint carries the environment (LIVE is red). */
export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color('#02040a') },
      uHorizon: { value: new THREE.Color('#0b1626') },
      uAlert: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform float uAlert;
      uniform float uTime;
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        float k = pow(1.0 - clamp(h, 0.0, 1.0), 6.0);
        vec3 c = mix(uTop, uHorizon, k);
        c += vec3(0.55, 0.04, 0.06) * uAlert * k * (0.75 + 0.25 * sin(uTime * 2.4));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

export const STATE_COLORS = {
  call: '#2ee6a6',
  put: '#ff4d6d',
  neutral: '#4c8dff',
  pending: '#ffb020',
  halted: '#8a93a3',
  error: '#ff4d6d',
} as const;
