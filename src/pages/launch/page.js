import { LOGOS } from './logos.js';
import WORDMARK from './wordmark.txt?raw';
import { wireWaitlistForms } from './forms';

// Every entry is a real, published change. Sources are the vendors' own changelogs and release pages.
const CHANGELOG = [
  ['node', 'Node.js', 'Node.js 20 reached end of life', 'Security fixes stopped April 30, 2026.'],
  [
    'openai',
    'OpenAI',
    'Assistants API shut down',
    'Ended August 26, 2026. Move to the Responses API.',
  ],
  [
    'next',
    'Next.js',
    'Next.js 15 makes request APIs async',
    'cookies(), headers() and params need await.',
  ],
  [
    'github',
    'GitHub Actions',
    'upload-artifact v3 stopped working',
    'Workflows on it fail since January 30, 2025.',
  ],
  [
    'stripe',
    'Stripe',
    'PaymentIntent.charges removed',
    'API 2022-11-15 drops the list. Read latest_charge.',
  ],
  ['numpy', 'NumPy', 'NumPy 2.0 removes np.float_', 'Use np.float64 instead.'],
  [
    'anthropic',
    'Anthropic',
    'claude-3-opus-20240229 retired',
    'Requests fail since January 5, 2026.',
  ],
  ['python', 'Python', 'Python 3.10 reached end of life', 'Support ended in October 2026.'],
  ['react', 'React', 'React 19 removes ReactDOM.render', 'Use createRoot from react-dom/client.'],
  [
    'github',
    'GitHub Actions',
    'actions/cache v1 and v2 retired',
    'Workflows on them fail since March 1, 2025.',
  ],
  ['slack', 'Slack', 'files.upload retired', 'Move to the two-step external upload methods.'],
  ['pandas', 'pandas', 'pandas 2.0 removes DataFrame.append', 'Use pd.concat instead.'],
  ['openai', 'OpenAI', 'gpt-4.5-preview shut down', 'Gone since July 14, 2025. Move to gpt-4.1.'],
  [
    'python',
    'Python',
    'Python 3.13 drops 19 old modules',
    'cgi, crypt, telnetlib and others are gone.',
  ],
  [
    'express',
    'Express',
    'Express 5 removes req.param()',
    'Read req.params, req.body or req.query.',
  ],
  [
    'github',
    'GitHub Actions',
    'ubuntu-20.04 runner retired',
    'Gone since April 15, 2025. Use a newer image.',
  ],
  ['shopify', 'Shopify', 'REST Admin API is legacy', 'New public apps must use GraphQL.'],
  [
    'eslint',
    'ESLint',
    'ESLint 9 makes flat config the default',
    'eslint.config.js replaces .eslintrc.',
  ],
  [
    'django',
    'Django',
    'Django 4.0 removes url()',
    'django.conf.urls.url() is gone. Use re_path().',
  ],
];
// The page that rises off the wheel to become the first card. It appears once on the wheel, with its own atlas cell after the changelog's.
const INSTALL_PAGE = 0;
const INSTALL_CELL = CHANGELOG.length;
const cellOf = (page) => (page === INSTALL_PAGE ? INSTALL_CELL : (page - 1) % CHANGELOG.length);

const PHONE_MAX = 719;
const STACKED_MAX = 1179;
const SCROLL_DAMPING = 9;

// Scroll beats of the pinned story, in viewport heights.
const BEATS = [
  ['spin', 0.8],
  ['hold', 0.2],
  ['pull', 0.5],
  ['rest0', 0.6],
  ['fold1', 0.45],
  ['rest1', 0.6],
  ['fold2', 0.45],
  ['rest2', 0.6],
  ['fold3', 0.45],
  ['rest3', 0.6],
];
const SPIN_TURNS = 3.5;
const STEP_COUNT = 4;

const WHEEL_DESKTOP = {
  pages: 40,
  width: 440,
  height: 242,
  lift: 110,
  hub: 280,
  axisX: 0.67,
  axisY: 0.65,
  depth: -180,
  tipX: 6,
  tipY: -30,
  tipZ: -14,
  originX: 0.46,
  originY: 0.44,
  perspective: 1100,
  front: -58,
};
const WHEEL_PHONE = {
  pages: 20,
  width: 280,
  height: 168,
  lift: 64,
  hub: 150,
  axisX: 0.86,
  axisY: 0.62,
  depth: -90,
  tipX: 6,
  tipY: -24,
  tipZ: -10,
  originX: 0.5,
  originY: 0.5,
  perspective: 900,
  front: -58,
};
const ATLAS_COLUMNS = 4;
const ATLAS_ROWS = Math.ceil((INSTALL_CELL + 1) / ATLAS_COLUMNS);
const ATLAS_DESKTOP = { columns: ATLAS_COLUMNS, rows: ATLAS_ROWS, cellWidth: 880, cellHeight: 484 };
const ATLAS_PHONE = { columns: ATLAS_COLUMNS, rows: ATLAS_ROWS, cellWidth: 600, cellHeight: 360 };
const DRAG = { mouseY: 0.35, mouseX: 0.15, touchX: 0.35, friction: 1.5, settle: 9, restSpeed: 8 };
const PULL_LIFT = 110;
const PULL_CENTER_LEAD = 2;
const CORNER = 16;
const WHEEL_EXIT = { drop: 1.5, right: 0.1, depth: 520, spin: 70 };
const WHEEL_SHADE = 0.86;
const PAGE_RIM = 0.55;
const SLIVER_EDGE = { from: 0.6, to: 0.85 };
const SETTLE_FROM = 0.8;
// Speed softens the print a touch and no more: past one mip level the pages turn to fog, and the geometry stays sharp either way.
const SPIN_BLUR = { rate: 0.0025, max: 0.6 };
// A page that has gone past folds edge on behind the next, so a card at rest stands alone.
const FOLD_BACK = 90;
const FOLD_SHADE = 0.36;
const STRIP_SWAY = { yaw: -7, pitch: 3, roll: -1 };
// Mid-fold the strip backs off by this share of a card, so its ridge never comes nearer than a resting card and nothing grows out of the card's column.
const FOLD_BACK_OFF = 0.34;
// All of these are for a 720 wide card and scale with it.
const LEAF_BASE_WIDTH = 720;
const WHEEL_PANEL_WIDTH = 1100;
const LEAF_MARGIN = 40;
const TITLE_GAP = 32;
const TITLE_MAX = 400;
const MARKS_GAP = 16;
const STACK_GAP = 24;
const PHONE_MARKS_GAP = 0;
const PHONE_STACK_GAP = 16;
const PANEL_INSET = 8;
// The caption and numerals come in once the card has nearly landed, clear of the wheel falling away behind it.
const CAPTION_FROM = 0.8;
const INK = '#000';
const QUIET_INK = '#6b6b6b';
const HAIRLINE = '#e5e5e5';
const MONOGRAM = { letters: 2, corner: 0.25, type: 0.46, baseline: 0.66 };

// The logo and name as drawn on tryrefit.dev. Black and white on purpose.
const WORDMARK_RAMP = ' .:-=+*#%@';
const WORDMARK_MOTION = {
  decode: 1100,
  flicker: 50,
  sweep: 0.25,
  shimmerEvery: 110,
  shimmerShare: 0.025,
  shimmerHold: 600,
};

// The shadow root holding the page, its host and the signal that ends it, set by startLaunchPage.
let shadow;
let root;
let stopped;
// The story panel's dust: scattered around the wheel, then gathered into one stream on the bird's heading once the cards come forward.
const DUST = {
  count: 1500,
  phoneCount: 380,
  scattered: 640,
  loose: 0.3,
  tones: [
    'rgba(255,255,255,.16)',
    'rgba(255,255,255,.28)',
    'rgba(255,255,255,.44)',
    'rgba(255,255,255,.66)',
  ],
  sizes: [1, 1, 1.5, 2],
  flow: 0.016,
  scrollFlow: 0.1,
  // Bezier course in panel fractions: low on the left under the caption, behind the card, out at the top right.
  course: [
    [-0.04, 0.9],
    [0.32, 1],
    [0.58, 0.42],
    [1.04, 0.06],
  ],
  width: 0.13,
};
const MAX_PIXEL_RATIO = 2;
const byId = (id) => shadow.getElementById(id);
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const progress = (value, from, to) => clamp((value - from) / (to - from));
const easeOut = (t) => 1 - (1 - t) ** 4;
const easeMove = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);
const isPhone = () => innerWidth <= PHONE_MAX;
const docTop = (element) => element.getBoundingClientRect().top + scrollY;

function wireFocusLinks() {
  for (const link of shadow.querySelectorAll('[data-focus-form]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      scrollTo(0, 0);
      byId('email-hero').focus({ preventScroll: true });
    });
  }
}

function logoMarkup(key, provider) {
  if (!LOGOS[key])
    return `<span class="logo monogram" aria-hidden="true">${provider.slice(0, MONOGRAM.letters)}</span>`;
  const { box, odd, paths, fills } = LOGOS[key];
  const svg = paths
    .map(
      (d, index) =>
        `<path fill="${fills[index % fills.length]}" d="${d}"${odd ? ' fill-rule="evenodd"' : ''}/>`,
    )
    .join('');
  return `<span class="logo" aria-hidden="true"><svg viewBox="0 0 ${box} ${box}">${svg}</svg></span>`;
}

function fillPagesList() {
  const list = byId('pages-list');
  for (const [key, provider, title, line] of CHANGELOG) {
    const item = document.createElement('li');
    item.innerHTML = `${logoMarkup(key, provider)}<span>${provider}</span><b>${title}</b><span>${line}</span>`;
    list.append(item);
  }
}

/* Matrices follow CSS: y down, z toward the viewer, column major. */
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}
const translate = (x, y, z) => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};
function rotateX(degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}
function rotateY(degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}
function rotateZ(degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const m = identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

function compile(gl, vertex, fragment) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < count; index += 1) {
    const { name } = gl.getActiveUniform(program, index);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

/* The changelog pages, printed once into an atlas: black ink and the real logo colors on white paper. */
function setFont(ctx, font, spacing = 0) {
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
}

function drawLogo(ctx, key, x, y, size) {
  const { box, odd, paths, fills } = LOGOS[key];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / box, size / box);
  paths.forEach((d, index) => {
    ctx.fillStyle = fills[index % fills.length];
    ctx.fill(new Path2D(d), odd ? 'evenodd' : 'nonzero');
  });
  ctx.restore();
}

function drawMonogram(ctx, provider, x, y, size) {
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, size * MONOGRAM.corner);
  ctx.fill();
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  setFont(ctx, `600 ${size * MONOGRAM.type}px "Geist Variable"`);
  ctx.fillText(provider.slice(0, MONOGRAM.letters), x + size / 2, y + size * MONOGRAM.baseline);
  ctx.restore();
}

function wrapLines(ctx, text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

function drawChangelogPage(ctx, [key, provider, title, line], wheel) {
  const unit = wheel.width / WHEEL_DESKTOP.width;
  const margin = 24 * unit;
  const inner = wheel.width - margin * 2;
  if (LOGOS[key]) drawLogo(ctx, key, margin, 18 * unit, 24 * unit);
  else drawMonogram(ctx, provider, margin, 18 * unit, 24 * unit);
  ctx.fillStyle = INK;
  setFont(ctx, `500 ${16 * unit}px "Geist Variable"`);
  ctx.fillText(provider, margin + 32 * unit, 36 * unit);
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(margin, 58 * unit, inner, unit);
  ctx.fillStyle = INK;
  setFont(ctx, `600 ${28 * unit}px "Geist Variable"`, -0.56 * unit);
  let top = 96 * unit;
  for (const text of wrapLines(ctx, title, inner).slice(0, 2)) {
    ctx.fillText(text, margin, top);
    top += 32 * unit;
  }
  ctx.fillStyle = QUIET_INK;
  setFont(ctx, `400 ${15 * unit}px "Geist Variable"`);
  top += 2 * unit;
  for (const text of wrapLines(ctx, line, inner).slice(0, 2)) {
    ctx.fillText(text, margin, top);
    top += 20 * unit;
  }
}

function baselineIn(ctx, rect) {
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  return rect.top + (rect.height - (ascent + descent)) / 2 + ascent;
}

/* The install page prints the same layout as the DOM leaf it turns into, measured from that leaf, with its boxes still empty as they are when it arrives. */
function drawInstallPage(ctx, leaf, wheel) {
  const base = leaf.getBoundingClientRect();
  const factor = wheel.width / base.width;
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: (rect.left - base.left) * factor,
      top: (rect.top - base.top) * factor,
      width: rect.width * factor,
      height: rect.height * factor,
    };
  };
  const useFontOf = (style) => {
    setFont(
      ctx,
      `${style.fontWeight} ${parseFloat(style.fontSize) * factor}px ${style.fontFamily}`,
      (parseFloat(style.letterSpacing) || 0) * factor,
    );
  };
  const text = (element) => {
    const style = getComputedStyle(element);
    useFontOf(style);
    ctx.fillStyle = style.color;
    const rect = rectOf(element);
    ctx.fillText(element.textContent, rect.left, baselineIn(ctx, rect));
  };
  const logo = rectOf(leaf.querySelector('.leaf-head .logo'));
  drawLogo(ctx, 'github', logo.left, logo.top, logo.width);
  text(byId('install-source'));
  const head = rectOf(leaf.querySelector('.leaf-head'));
  ctx.fillStyle = HAIRLINE;
  ctx.fillRect(0, head.top + head.height - factor, wheel.width, factor);

  const pill = byId('install-pill');
  const pillRect = rectOf(pill);
  const pillStyle = getComputedStyle(pill);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pillRect.left, pillRect.top, pillRect.width, pillRect.height, pillRect.height / 2);
  ctx.lineWidth = Math.max(1, factor);
  ctx.strokeStyle = HAIRLINE;
  ctx.stroke();
  useFontOf(pillStyle);
  ctx.fillStyle = pillStyle.color;
  ctx.textAlign = 'center';
  ctx.fillText(pill.textContent, pillRect.left + pillRect.width / 2, baselineIn(ctx, pillRect));
  ctx.restore();

  text(byId('install-title'));
  text(byId('install-meta'));
  for (const repo of byId('repos').children) {
    const box = repo.querySelector('.repo-box');
    const boxRect = rectOf(box);
    const boxStyle = getComputedStyle(box);
    ctx.beginPath();
    ctx.roundRect(
      boxRect.left,
      boxRect.top,
      boxRect.width,
      boxRect.height,
      parseFloat(boxStyle.borderTopLeftRadius) * factor,
    );
    ctx.lineWidth = Math.max(1, factor);
    ctx.strokeStyle = boxStyle.borderTopColor;
    ctx.stroke();
    text(repo.querySelector('code'));
  }
}

function paintAtlas(canvas, config, wheel, installLeaf) {
  const ctx = canvas.getContext('2d');
  canvas.width = config.columns * config.cellWidth;
  canvas.height = config.rows * config.cellHeight;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'alphabetic';
  const scale = config.cellWidth / wheel.width;
  const printCell = (cell, draw) => {
    ctx.save();
    ctx.translate(
      (cell % config.columns) * config.cellWidth,
      Math.floor(cell / config.columns) * config.cellHeight,
    );
    ctx.scale(scale, scale);
    // On a phone the install card runs past the wheel page's height, where the next cell starts.
    ctx.beginPath();
    ctx.rect(0, 0, wheel.width, wheel.height);
    ctx.clip();
    draw();
    ctx.restore();
  };
  CHANGELOG.forEach((entry, cell) => printCell(cell, () => drawChangelogPage(ctx, entry, wheel)));
  printCell(INSTALL_CELL, () => drawInstallPage(ctx, installLeaf, wheel));
}

/* The wheel: real quads through a depth buffer, so pages sort and mirror themselves, with flat shading for depth. */
function createWheel(canvas, installLeaf) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true });
  if (!gl) return null;
  stopped.addEventListener('abort', () => gl.getExtension('WEBGL_lose_context')?.loseContext());
  const { program, uniforms } = compile(
    gl,
    `#version 300 es
    uniform mat4 uModel;
    uniform vec2 uView, uOrigin;
    uniform float uPerspective;
    uniform vec3 uPage;
    out vec2 vUv;
    void main() {
      vec2 uv = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
      vUv = uv;
      vec3 local = vec3((uv.x - .5) * uPage.x, -uPage.z - (1. - uv.y) * uPage.y, 0.);
      vec3 world = (uModel * vec4(local, 1.)).xyz;
      float w = 1. - world.z / uPerspective;
      vec2 relative = world.xy - uOrigin;
      gl_Position = vec4(
        (uOrigin.x * w + relative.x) * 2. / uView.x - w,
        -((uOrigin.y * w + relative.y) * 2. / uView.y - w),
        (-world.z / 3000.) * w,
        w);
    }`,
    `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform sampler2D uAtlas;
    uniform vec4 uCellRect;
    uniform vec2 uSize;
    uniform float uShade, uBias, uRadius, uFront;
    const float PAGE_RIM = ${PAGE_RIM.toFixed(2)};
    out vec4 color;
    void main() {
      vec2 p = (vUv - .5) * uSize;
      vec2 q = abs(p) - uSize * .5 + uRadius;
      float d = length(max(q, vec2(0.))) + min(max(q.x, q.y), 0.) - uRadius;
      if (d > 0.) discard;
      vec2 slot = p - vec2(clamp(p.x, -uSize.x * .06, uSize.x * .06), uSize.y * .5 - uSize.y * .07);
      if (length(slot) < uSize.y * .026 * (1. - uFront)) discard;
      vec3 page = texture(uAtlas, uCellRect.xy + vUv * uCellRect.zw, uBias).rgb;
      // A soft dark edge, so paper stacked on paper stays separate sheets.
      float edge = smoothstep(-1.6 * fwidth(d), 0., d);
      color = vec4(page * (1. - uShade) * (1. - PAGE_RIM * edge), 1.);
    }`,
  );
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');

  let config = WHEEL_DESKTOP;
  let atlasConfig = ATLAS_DESKTOP;
  let width = 1;
  let height = 1;
  let lastKey = '';
  const atlas = document.createElement('canvas');

  const pageCorner = () => CORNER * (config.width / WHEEL_DESKTOP.width);

  function printAtlas() {
    atlasConfig = isPhone() ? ATLAS_PHONE : ATLAS_DESKTOP;
    paintAtlas(atlas, atlasConfig, config, installLeaf);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (anisotropic) gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    lastKey = '';
  }

  function baseMatrix(exit = 0) {
    const m = multiply(
      translate(
        (config.axisX + WHEEL_EXIT.right * exit) * width,
        (config.axisY + WHEEL_EXIT.drop * exit) * height,
        config.depth - config.exitDepth * exit,
      ),
      rotateZ(config.tipZ),
    );
    return multiply(multiply(m, rotateY(config.tipY)), rotateX(config.tipX));
  }

  function resize(unit) {
    const base = isPhone() ? WHEEL_PHONE : WHEEL_DESKTOP;
    config = {
      ...base,
      width: base.width * unit,
      height: base.height * unit,
      lift: base.lift * unit,
      hub: base.hub * unit,
      depth: base.depth * unit,
      perspective: base.perspective * unit,
      exitDepth: WHEEL_EXIT.depth * unit,
    };
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    lastKey = '';
  }

  return {
    printAtlas,
    resize,
    get config() {
      return config;
    },
    /* Where the stopped install page sits, as a CSS transform's pieces for the DOM leaf that replaces it. */
    seatPose(leafWidth) {
      const theta = config.front;
      const model = multiply(baseMatrix(), rotateX(theta));
      const top = -config.hub - config.lift - config.height;
      return {
        x: model[4] * top + model[12],
        y: model[5] * top + model[13],
        z: model[6] * top + model[14],
        rz: config.tipZ,
        ry: config.tipY,
        rx: config.tipX + theta,
        scale: config.width / leafWidth,
        height: (leafWidth * config.height) / config.width,
        corner: pageCorner() * (leafWidth / config.width),
        rim: leafWidth / config.width,
      };
    },
    draw({ spin, exit, speed, hideInstall, settle }) {
      const key = `${spin}|${exit}|${hideInstall}|${speed}|${settle}`;
      if (key === lastKey) return;
      lastKey = key;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const step = 360 / config.pages;
      const base = baseMatrix(exit);
      gl.uniform2f(uniforms.uView, width, height);
      gl.uniform2f(uniforms.uOrigin, config.originX * width, config.originY * height);
      gl.uniform1f(uniforms.uPerspective, config.perspective);
      gl.uniform2f(uniforms.uSize, config.width, config.height);
      gl.uniform1f(uniforms.uRadius, pageCorner());
      gl.uniform1f(uniforms.uBias, clamp(speed * SPIN_BLUR.rate, 0, SPIN_BLUR.max));
      const cellWidth = 1 / atlasConfig.columns;
      const cellHeight = 1 / atlasConfig.rows;
      const reach = config.hub + config.height / 2;
      for (let page = 0; page < config.pages; page += 1) {
        if (hideInstall && page === INSTALL_PAGE) continue;
        const theta = (page - INSTALL_PAGE) * step + config.front + spin;
        const model = multiply(base, rotateX(theta));
        const centerZ = model[6] * -reach + model[14] - config.depth + config.exitDepth * exit;
        const edgeOn = 1 - Math.abs(model[10]);
        const depth = 0.5 - centerZ / (2 * reach);
        // White paper up close. Only distance and turning away from the light darken a page.
        const tone = clamp(depth ** 2.2 * 1.1 + edgeOn * 0.2 - 0.2);
        const wrapped = ((((theta - config.front) % 360) + 540) % 360) - 180;
        // As the wheel slows, the page at the front rises out of the barrel and comes up to pure white.
        const closeness = settle * clamp(1 - Math.abs(wrapped) / step) ** 2;
        // A page turned nearly edge on catches the light, or the middle of the wheel would go dark.
        const lit =
          tone * (1 - closeness) * (1 - progress(edgeOn, SLIVER_EDGE.from, SLIVER_EDGE.to));
        gl.uniform3f(
          uniforms.uPage,
          config.width,
          config.height,
          config.hub + config.lift * closeness,
        );
        const cell = cellOf(page);
        gl.uniformMatrix4fv(uniforms.uModel, false, model);
        gl.uniform1f(uniforms.uShade, lit * WHEEL_SHADE);
        gl.uniform1f(uniforms.uFront, closeness);
        gl.uniform4f(
          uniforms.uCellRect,
          (cell % atlasConfig.columns) * cellWidth,
          Math.floor(cell / atlasConfig.columns) * cellHeight,
          cellWidth,
          cellHeight,
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
  };
}

/* The closing logo: it decodes from noise when first seen, then a few characters keep stepping to a neighbouring glyph. */
function createWordmark(root) {
  const [base, lens] = root.querySelectorAll('pre');
  const cells = WORDMARK.split('\n').map((line) => [...line]);
  const inked = cells.flatMap((line, row) =>
    line.flatMap((char, column) => (char === ' ' ? [] : [[row, column]])),
  );
  const swapped = new Map();
  const { decode, flicker, sweep, shimmerEvery, shimmerShare, shimmerHold } = WORDMARK_MOTION;
  let visible = false;

  const show = (grid) => {
    const text = grid.map((line) => line.join('')).join('\n');
    base.textContent = text;
    lens.textContent = text;
  };
  const noise = (a, b) => ((((a * 73856093) ^ (b * 19349663)) >>> 0) % 1000) / 1000;
  const anyGlyph = () => WORDMARK_RAMP[1 + Math.floor(Math.random() * (WORDMARK_RAMP.length - 1))];
  function neighbour(char) {
    const index = WORDMARK_RAMP.indexOf(char);
    const step =
      index >= WORDMARK_RAMP.length - 1 ? -1 : index <= 1 || Math.random() < 0.5 ? 1 : -1;
    return WORDMARK_RAMP[index + step];
  }

  function shimmer() {
    if (!visible || document.hidden) return;
    const now = performance.now();
    for (const [key, swap] of swapped) if (swap.until <= now) swapped.delete(key);
    for (let count = 0; count < Math.ceil(inked.length * shimmerShare); count += 1) {
      const [row, column] = inked[Math.floor(Math.random() * inked.length)];
      swapped.set(`${row}:${column}`, {
        char: neighbour(cells[row][column]),
        until: now + shimmerHold * (0.5 + Math.random()),
      });
    }
    show(
      cells.map((line, row) =>
        line.map((char, column) => swapped.get(`${row}:${column}`)?.char ?? char),
      ),
    );
  }

  function play() {
    const began = performance.now();
    let shown = 0;
    function frame(now) {
      if (stopped.aborted) return;
      const done = (now - began) / decode;
      if (done >= 1) {
        show(cells);
        const shimmering = setInterval(shimmer, shimmerEvery);
        stopped.addEventListener('abort', () => clearInterval(shimmering));
        return;
      }
      requestAnimationFrame(frame);
      if (now - shown < flicker) return;
      shown = now;
      show(
        cells.map((line, row) =>
          line.map((char, column) =>
            char === ' ' || column / line.length + noise(row, column) * sweep < done
              ? char
              : anyGlyph(),
          ),
        ),
      );
    }
    requestAnimationFrame(frame);
  }

  root.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    const box = root.getBoundingClientRect();
    lens.style.setProperty('--x', `${event.clientX - box.left}px`);
    lens.style.setProperty('--y', `${event.clientY - box.top}px`);
  });

  return {
    hold: () => show(cells),
    watch() {
      // Blank cells hold the logo's size until it is first on screen.
      show(cells.map((line) => line.map(() => ' ')));
      let played = false;
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (!visible || played) return;
        played = true;
        play();
      });
      observer.observe(root);
      stopped.addEventListener('abort', () => observer.disconnect());
    },
  };
}

function createDust(canvas) {
  const ctx = canvas.getContext('2d');
  const fract = (value) => value - Math.floor(value);
  const particles = Array.from({ length: isPhone() ? DUST.phoneCount : DUST.count }, () => ({
    x: Math.random(),
    y: Math.random(),
    along: Math.random(),
    // The sum of two randoms crowds the middle of the stream and thins its edges.
    across: Math.random() + Math.random() - 1,
    pace: 0.7 + Math.random() * 0.6,
    tone: Math.floor(Math.random() ** 1.5 * DUST.tones.length),
    // A few faint ones never join the stream, so the rest of the panel isn't bare.
    loose: Math.random() < DUST.loose,
  }));
  const [p0, p1, p2, p3] = DUST.course;
  const bezier = (axis, k) => {
    const j = 1 - k;
    return (
      j * j * j * p0[axis] +
      3 * j * j * k * p1[axis] +
      3 * j * k * k * p2[axis] +
      k * k * k * p3[axis]
    );
  };
  let [width, height, flow] = [0, 0, 0];
  return {
    resize() {
      const ratio = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
      [width, height] = [canvas.clientWidth, canvas.clientHeight];
      [canvas.width, canvas.height] = [Math.round(width * ratio), Math.round(height * ratio)];
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    },
    draw(dt, scrolled, gather) {
      flow += dt * DUST.flow + scrolled * DUST.scrollFlow;
      ctx.clearRect(0, 0, width, height);
      const showing = Math.round(
        lerp(Math.min(DUST.scattered, particles.length), particles.length, gather),
      );
      DUST.tones.forEach((tone, level) => {
        ctx.fillStyle = tone;
        const size = DUST.sizes[level];
        for (let index = 0; index < showing; index += 1) {
          const dot = particles[index];
          if (dot.tone !== level) continue;
          const joined = dot.loose && dot.tone < 2 ? 0 : gather;
          const along = fract(dot.along + flow * dot.pace);
          const x = lerp(fract(dot.x + flow * dot.pace * 0.5), bezier(0, along), joined);
          const y = lerp(dot.y, bezier(1, along) + dot.across * DUST.width, joined);
          ctx.fillRect(x * width, y * height, size, size);
        }
      });
    },
  };
}

export function startLaunchPage(shadowRoot, signal) {
  shadow = shadowRoot;
  root = shadowRoot.host;
  stopped = signal;
  wireWaitlistForms(shadow);
  wireFocusLinks();
  fillPagesList();

  const wheelCanvas = byId('wheel');
  const stage = byId('stage');
  const stagePanel = byId('stage-panel');
  const story = byId('story');
  const sheet = byId('sheet');
  const steps = [...shadow.querySelectorAll('.step')];
  const leaves = steps.map((step) => step.querySelector('.leaf'));
  const titles = steps.map((step) => step.querySelector('.step-title'));
  const marksList = byId('marks');
  const marks = [...marksList.querySelectorAll('button')];

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heroVideo = byId('hero-video');
  const calm = reduced || !document.createElement('canvas').getContext('webgl2');
  root.classList.toggle('calm', calm);
  const wordmark = createWordmark(byId('wordmark'));

  if (calm) {
    heroVideo.pause();
    wordmark.hold();
    return;
  }

  const wheel = createWheel(wheelCanvas, leaves[0]);
  const dust = createDust(byId('dust'));
  for (const leaf of leaves) leaf.classList.add('armed');

  const beats = {};
  let total = 0;
  for (const [name, length] of BEATS) {
    beats[name] = { start: total, end: total + length };
    total += length;
  }

  const layout = {
    width: 0,
    height: 0,
    stageHeight: 0,
    unit: 1,
    leafX: 0,
    leafCenter: 0,
    leafWidth: 0,
    leafHeight: 0,
    pullLift: 0,
    pullFit: 1,
  };
  const metrics = { storyTop: 0, seat: null };

  function measure() {
    layout.stageHeight = stage.clientHeight;
    layout.width = stagePanel.clientWidth;
    layout.height = stagePanel.clientHeight;
    for (const leaf of leaves) {
      leaf.style.transform = 'none';
      leaf.style.height = '';
    }
    story.style.setProperty('--story-height', `${Math.round((total + 1) * layout.stageHeight)}px`);
    const phone = isPhone();
    const stacked = innerWidth <= STACKED_MAX;
    stagePanel.style.removeProperty('--leaf-h');
    // Text wraps on a phone, so there the tallest card sets the height all four share.
    if (phone)
      stagePanel.style.setProperty(
        '--leaf-h',
        `${Math.max(...leaves.map((leaf) => leaf.offsetHeight))}px`,
      );
    layout.leafWidth = leaves[0].offsetWidth;
    layout.leafHeight = leaves[0].offsetHeight;
    layout.unit = phone ? 1 : layout.leafWidth / LEAF_BASE_WIDTH;
    const { width, height, unit, leafWidth, leafHeight } = layout;
    // On a wide panel the caption and the card close up and center, so they don't drift to its two edges.
    const margin = stacked
      ? (width - leafWidth) / 2
      : Math.max(LEAF_MARGIN, (width - (TITLE_MAX + TITLE_GAP) * unit - leafWidth) / 2);
    layout.leafX = stacked ? width / 2 : width - margin - leafWidth / 2;
    stagePanel.style.setProperty('--stage-margin', `${Math.round(margin)}px`);
    stagePanel.style.setProperty(
      '--title-w',
      `${Math.round(stacked ? leafWidth : layout.leafX - leafWidth / 2 - margin - TITLE_GAP * unit)}px`,
    );
    const marksHeight = marksList.offsetHeight;
    const captionHeight = Math.max(...titles.map((title) => title.offsetHeight));
    const marksGap = (phone ? PHONE_MARKS_GAP : MARKS_GAP) * unit;
    const stackGap = stacked ? (phone ? PHONE_STACK_GAP : STACK_GAP) * unit : 0;
    const caption = marksHeight + marksGap + captionHeight;
    // Numerals, caption and card are one block: stacked it is centered in the panel, side by side the caption centers on the card.
    const marksTop = Math.max(
      PANEL_INSET,
      (height - caption - (stacked ? stackGap + leafHeight : 0)) / 2,
    );
    const leafTop = marksTop + caption + stackGap;
    layout.leafCenter = stacked ? leafTop + leafHeight / 2 : height / 2;
    stagePanel.style.setProperty('--marks-top', `${Math.round(marksTop)}px`);
    stagePanel.style.setProperty(
      '--caption-top',
      `${Math.round(marksTop + marksHeight + marksGap)}px`,
    );
    stagePanel.style.setProperty('--roof', stacked ? `${Math.round(leafTop)}px` : '0px');
    metrics.storyTop = docTop(story);
    // The wheel keeps its desktop framing in a narrower panel, where a card-sized wheel would run off the side.
    wheel.resize(phone ? unit : Math.min(unit, width / WHEEL_PANEL_WIDTH));
    dust.resize();
    sheet.style.perspective = `${wheel.config.perspective}px`;
    metrics.seat = wheel.seatPose(leafWidth);
    // The biggest the page may look once it is centered, with its side edges still inside the panel.
    layout.pullFit = (Math.min(layout.leafX, width - layout.leafX) - PANEL_INSET) / (leafWidth / 2);
    layout.pullLift = PULL_LIFT * unit;
  }

  const spinState = {
    offset: 0,
    velocity: 0,
    held: false,
    pointer: null,
    lastX: 0,
    lastY: 0,
    lastTime: 0,
    target: null,
  };
  let previousSpin = 0;
  let spinSpeed = 0;

  function placeLeaves(foldTotal, pullAmount) {
    const { leafHeight, leafCenter, leafX, leafWidth, unit } = layout;
    const tops = [];
    let chainY = 0;
    let chainZ = 0;
    for (let index = 0; index < leaves.length; index += 1) {
      const distance = foldTotal - index;
      let angle;
      if (distance >= 0) angle = FOLD_BACK * easeMove(clamp(distance));
      else if (distance > -1) angle = -180 * (1 - easeOut(1 + distance));
      else angle = -180;
      tops.push({ y: chainY, z: chainZ, angle, distance });
      const radians = (angle * Math.PI) / 180;
      chainY += leafHeight * Math.cos(radians);
      chainZ += leafHeight * Math.sin(radians);
    }
    const centerOf = (index) => {
      const top = tops[index];
      const radians = (top.angle * Math.PI) / 180;
      return {
        y: top.y + (leafHeight / 2) * Math.cos(radians),
        z: top.z + (leafHeight / 2) * Math.sin(radians),
      };
    };
    const current = Math.min(Math.floor(foldTotal), leaves.length - 1);
    const next = Math.min(current + 1, leaves.length - 1);
    const amount = easeMove(foldTotal - current);
    const from = centerOf(current);
    const to = centerOf(next);
    const focusY = lerp(from.y, to.y, amount);
    const focusZ = lerp(from.z, to.z, amount);
    const sway = Math.sin(Math.PI * (foldTotal - current)) ** 2;
    const yaw = STRIP_SWAY.yaw * sway;
    const pitch = STRIP_SWAY.pitch * sway;
    const roll = STRIP_SWAY.roll * sway;
    const backOff = FOLD_BACK_OFF * leafHeight * sway;
    const seat = metrics.seat;
    const eased = easeMove(pullAmount);
    // The wheel's vanishing point while the page leaves it, the card's own center once it has landed, so a fold recedes straight back.
    const centered = easeMove(clamp(pullAmount * PULL_CENTER_LEAD));
    const vanishing = `${lerp(wheel.config.originX * layout.width, leafX, centered).toFixed(1)}px ${lerp(wheel.config.originY * layout.height, leafCenter, eased).toFixed(1)}px`;
    if (sheet.dataset.vanishing !== vanishing) {
      sheet.dataset.vanishing = vanishing;
      sheet.style.perspectiveOrigin = vanishing;
    }
    leaves.forEach((leaf, index) => {
      const top = tops[index];
      const shown = pullAmount > 0 && Math.abs(top.distance) < 1;
      leaf.style.visibility = shown ? 'visible' : 'hidden';
      if (!shown) return;
      // Two cards share the flat stack: the next tucks behind this one early in a fold, this one behind the next late in it, and they don't overlap in between.
      const layer = index === Math.round(foldTotal) ? '2' : '1';
      if (leaf.style.zIndex !== layer) leaf.style.zIndex = layer;
      const shade =
        (FOLD_SHADE * Math.round(Math.abs(Math.sin((top.angle * Math.PI) / 180)) * 100)) / 100;
      if (leaf.dataset.shade !== String(shade)) {
        leaf.dataset.shade = String(shade);
        leaf.style.setProperty('--shade', shade);
      }
      const corner = CORNER * unit;
      const hinged = top.distance > 0 && index < leaves.length - 1;
      const pulling = index === 0 && pullAmount < 1;
      const pullCorner = lerp(seat.corner, corner, eased);
      const bottomCorner = pulling
        ? pullCorner
        : hinged
          ? corner * (1 - clamp(top.distance * 6))
          : corner;
      const topCorner = pulling ? pullCorner : corner * clamp(1 - Math.abs(top.distance) * 6);
      const corners = `${topCorner.toFixed(2)}px ${topCorner.toFixed(2)}px ${bottomCorner.toFixed(2)}px ${bottomCorner.toFixed(2)}px`;
      if (leaf.dataset.corners !== corners) {
        leaf.dataset.corners = corners;
        leaf.style.borderRadius = corners;
      }
      const left = leafX - leafWidth / 2;
      if (index === 0) {
        // The page has the wheel's proportions and printed rim in its seat, and opens to the card's as it comes forward.
        const opening =
          pullAmount < 1 ? `${lerp(seat.height, leafHeight, eased).toFixed(2)}px` : '';
        if (leaf.style.height !== opening) leaf.style.height = opening;
        leaf.style.boxShadow =
          pullAmount < 1
            ? `inset 0 0 0 ${seat.rim.toFixed(2)}px rgb(0 0 0 / ${(PAGE_RIM * (1 - eased)).toFixed(3)})`
            : '';
      }
      if (pulling) {
        const restY = leafCenter - leafHeight / 2;
        // It squares up and centers first, so it faces forward before it comes close enough to reach the panel's edges.
        const x = lerp(seat.x, leafX, centered);
        const y = lerp(seat.y, restY, eased);
        const scale = lerp(seat.scale, 1, eased);
        const { perspective } = wheel.config;
        const biggest = lerp(
          seat.scale * (perspective / (perspective - seat.z)),
          layout.pullFit,
          centered,
        );
        const z = Math.min(
          lerp(seat.z, 0, eased) + layout.pullLift * Math.sin(Math.PI * pullAmount),
          perspective * (1 - scale / biggest),
        );
        leaf.style.transform = `translate3d(${(x - leafWidth / 2).toFixed(2)}px,${y.toFixed(2)}px,${z.toFixed(2)}px) rotateZ(${lerp(seat.rz, 0, centered).toFixed(3)}deg) rotateY(${lerp(seat.ry, 0, centered).toFixed(3)}deg) rotateX(${lerp(seat.rx, 0, centered).toFixed(3)}deg) scale(${scale.toFixed(4)})`;
        return;
      }
      if (foldTotal === current) {
        // At rest it sits on whole pixels with no 3D at all, so the text is as crisp as the rest of the page.
        leaf.style.transform = `translate3d(${Math.round(left)}px,${Math.round(leafCenter - leafHeight / 2)}px,0)`;
        return;
      }
      leaf.style.transform = `translate3d(${left.toFixed(2)}px,${leafCenter.toFixed(2)}px,${(-backOff).toFixed(2)}px) rotateZ(${roll.toFixed(3)}deg) rotateY(${yaw.toFixed(3)}deg) rotateX(${pitch.toFixed(3)}deg) translate3d(0,${(top.y - focusY).toFixed(2)}px,${(top.z - focusZ).toFixed(2)}px) rotateX(${top.angle.toFixed(3)}deg)`;
    });
  }

  let activeStep = -2;
  function setActiveStep(step) {
    if (step === activeStep) return;
    activeStep = step;
    steps.forEach((element, index) => element.classList.toggle('is-current', index === step));
    marks.forEach((button, index) => button.classList.toggle('is-current', index === step));
    leaves.forEach((leaf, index) => leaf.classList.toggle('armed', index > step));
    if (step >= 0) {
      // Re-arm before playing, so a card replays when you scroll back to it.
      const leaf = leaves[step];
      leaf.classList.add('armed');
      void leaf.offsetWidth;
      leaf.classList.remove('armed');
    }
    stage.classList.toggle('is-pulled', step >= 0);
  }

  function updateWheel(y, dt) {
    const { stageHeight } = layout;
    const v = (y - metrics.storyTop) / stageHeight;
    const entering = metrics.storyTop - stageHeight;
    const spinProgress = progress(y, entering, metrics.storyTop + beats.spin.end * stageHeight);
    const scrollSpin = SPIN_TURNS * 360 * (1 - spinProgress) ** 3;
    const step = 360 / wheel.config.pages;
    if (!spinState.held) {
      if (spinState.target !== null) {
        spinState.offset +=
          (spinState.target - spinState.offset) * (1 - Math.exp(-dt * DRAG.settle));
        if (Math.abs(spinState.target - spinState.offset) < 0.02) {
          spinState.offset = spinState.target;
          spinState.target = null;
        }
      } else if (Math.abs(spinState.velocity) > DRAG.restSpeed) {
        spinState.offset += spinState.velocity * dt;
        spinState.velocity *= Math.exp(-dt * DRAG.friction);
      } else {
        spinState.velocity = 0;
        const detent = Math.round(spinState.offset / step) * step;
        if (spinState.offset !== detent) spinState.target = detent;
      }
    }
    const holdAmount = easeMove(progress(v, beats.hold.start, beats.hold.end));
    const wrappedOffset =
      holdAmount > 0 ? ((((spinState.offset + 180) % 360) + 360) % 360) - 180 : spinState.offset;
    const spin = scrollSpin + wrappedOffset * (1 - holdAmount);
    const speed = dt > 0 ? Math.abs(spin - previousSpin) / dt : 0;
    spinSpeed = lerp(spinSpeed, speed, 1 - Math.exp(-dt * 12));
    previousSpin = spin;
    const pullAmount = progress(v, beats.pull.start, beats.pull.end);
    // Let go of: the wheel keeps turning and falls out of the bottom of the panel while the page comes forward.
    const exit = pullAmount ** 2;
    const inView = y > entering && exit < 1;
    wheelCanvas.style.visibility = inView ? 'visible' : 'hidden';
    wheelCanvas.style.pointerEvents = pullAmount > 0 ? 'none' : 'auto';
    if (inView) {
      wheel.draw({
        spin: Math.round((spin + WHEEL_EXIT.spin * exit) * 100) / 100,
        exit: Math.round(exit * 400) / 400,
        speed: spinSpeed < 1 ? 0 : Math.round(spinSpeed),
        hideInstall: pullAmount > 0,
        settle: Math.round(easeMove(progress(spinProgress, SETTLE_FROM, 1)) * 100) / 100,
      });
    }
    return pullAmount;
  }

  function updateStory(y, pullAmount) {
    const v = (y - metrics.storyTop) / layout.stageHeight;
    if (y < metrics.storyTop - layout.stageHeight || v > total + 1) {
      setActiveStep(-1);
      return;
    }
    let foldTotal = 0;
    for (let index = 1; index < STEP_COUNT; index += 1) {
      const beat = beats[`fold${index}`];
      foldTotal += progress(v, beat.start, beat.end);
    }
    placeLeaves(foldTotal, pullAmount);
    setActiveStep(pullAmount > CAPTION_FROM ? clamp(Math.round(foldTotal), 0, STEP_COUNT - 1) : -1);
  }

  let dustY = scrollY;
  function updateDust(y, dt, pullAmount) {
    const scrolled = (y - dustY) / layout.stageHeight;
    dustY = y;
    const v = (y - metrics.storyTop) / layout.stageHeight;
    if (v < -1 || v > total + 1) return;
    // Stacked, the card fills the panel's width, so a stream behind it would never show.
    dust.draw(dt, scrolled, innerWidth <= STACKED_MAX ? 0 : easeMove(pullAmount));
  }

  function wireWheelInput() {
    wheelCanvas.addEventListener('pointerdown', (event) => {
      if (spinState.pointer !== null) return;
      spinState.pointer = event.pointerId;
      spinState.held = true;
      spinState.target = null;
      spinState.velocity = 0;
      spinState.lastX = event.clientX;
      spinState.lastY = event.clientY;
      spinState.lastTime = event.timeStamp;
      wheelCanvas.setPointerCapture(event.pointerId);
      wheelCanvas.classList.add('is-held');
    });
    wheelCanvas.addEventListener('pointermove', (event) => {
      if (event.pointerId !== spinState.pointer) return;
      const touch = event.pointerType === 'touch';
      const dx = event.clientX - spinState.lastX;
      const dy = event.clientY - spinState.lastY;
      const delta = touch ? dx * DRAG.touchX : dy * DRAG.mouseY + dx * DRAG.mouseX;
      const elapsed = Math.max(1, event.timeStamp - spinState.lastTime) / 1000;
      spinState.offset += delta;
      spinState.velocity = lerp(spinState.velocity, delta / elapsed, 0.4);
      spinState.lastX = event.clientX;
      spinState.lastY = event.clientY;
      spinState.lastTime = event.timeStamp;
    });
    const release = (event) => {
      if (event.pointerId !== spinState.pointer) return;
      spinState.pointer = null;
      spinState.held = false;
      wheelCanvas.classList.remove('is-held');
      if (event.timeStamp - spinState.lastTime > 80) spinState.velocity = 0;
    };
    wheelCanvas.addEventListener('pointerup', release);
    wheelCanvas.addEventListener('pointercancel', release);
    wheelCanvas.addEventListener('keydown', (event) => {
      const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!direction) return;
      event.preventDefault();
      const step = 360 / wheel.config.pages;
      spinState.velocity = 0;
      spinState.target =
        Math.round((spinState.target ?? spinState.offset) / step + direction) * step;
      const page =
        (((INSTALL_PAGE - Math.round(spinState.target / step)) % wheel.config.pages) +
          wheel.config.pages) %
        wheel.config.pages;
      wheelCanvas.setAttribute('aria-valuenow', String(page));
      wheelCanvas.setAttribute(
        'aria-valuetext',
        page === INSTALL_PAGE ? byId('install-title').textContent : CHANGELOG[cellOf(page)][2],
      );
    });
  }

  function wireMarks() {
    marks.forEach((button, index) => {
      button.addEventListener('click', () => {
        const beat = beats[`rest${index}`];
        scrollTo({
          top: metrics.storyTop + ((beat.start + beat.end) / 2) * layout.stageHeight,
          behavior: 'smooth',
        });
      });
    });
  }

  /* The wheel's install page has to match the card at the moment it turns into it, so it is measured at that card's seat height. */
  function printAtlas() {
    measure();
    leaves[0].style.height = `${metrics.seat.height}px`;
    wheel.printAtlas();
    leaves[0].style.height = '';
  }

  function printAtlasWhenReady() {
    const faces = [
      '400 16px "Geist Variable"',
      '500 16px "Geist Variable"',
      '600 28px "Geist Variable"',
      '500 72px "Geist Mono Variable"',
    ];
    Promise.all(faces.map((face) => document.fonts.load(face))).then(printAtlas, printAtlas);
  }

  wireWheelInput();
  wireMarks();

  printAtlas();
  printAtlasWhenReady();
  document.fonts.ready.then(measure);
  addEventListener('load', measure, { signal: stopped });

  let resizeWasPhone = isPhone();
  addEventListener(
    'resize',
    () => {
      measure();
      if (isPhone() !== resizeWasPhone) {
        resizeWasPhone = isPhone();
        printAtlas();
      }
    },
    { signal: stopped },
  );

  const heroObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) heroVideo.pause();
    // A blocked autoplay (Low Power Mode) rejects here and just leaves the still frame showing.
    else heroVideo.play().catch(() => {});
  });
  heroObserver.observe(heroVideo);
  stopped.addEventListener('abort', () => heroObserver.disconnect());
  wordmark.watch();

  let liveY = scrollY;
  addEventListener(
    'scroll',
    () => {
      liveY = scrollY;
    },
    { passive: true, signal: stopped },
  );

  let smoothY = liveY;
  let lastNow = performance.now();
  function frame(now) {
    if (stopped.aborted) return;
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    smoothY += (liveY - smoothY) * (1 - Math.exp(-dt * SCROLL_DAMPING));
    if (Math.abs(liveY - smoothY) < 0.1) smoothY = liveY;
    const pullAmount = updateWheel(smoothY, dt);
    updateStory(smoothY, pullAmount);
    updateDust(smoothY, dt, pullAmount);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
