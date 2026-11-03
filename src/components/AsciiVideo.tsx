import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useReducedMotion } from './Workflow';

// Darkest to brightest, the ramp the ASCII wordmark uses.
const RAMP = ' .:-=+*#%@';
// Characters across the box: fine enough to make out what the footage shows.
const COLUMNS = 480;
// Share of the darkest and of the brightest light left out when a frame's levels are stretched.
const CLIP = 0.03;
// The contrast curve: levels below the first point drop out, levels above the second are full
// ink, so mid-tones like grass fall back and the light shapes stand out.
const CURVE = [0.4, 0.95];
// How strongly a cell's difference from its neighbours is exaggerated, to sharpen outlines.
const DETAIL = 0.5;
// The darkest and the lightest ink, as 0-1 RGB.
const DIM = [0.13, 0.14, 0.16];
const BRIGHT = [0.84, 0.86, 0.89];
const FILL: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

const VERTEX = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// For each pixel: find its character cell, average the footage over the cell, sharpen it against
// the cells around it, stretch and curve that light into a level, then draw the level's glyph
// from the atlas in an ink as light as the level.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_video;
uniform sampler2D u_glyphs;
uniform vec2 u_size;
uniform vec2 u_cell;
uniform vec2 u_origin;
uniform vec2 u_span;
uniform vec2 u_levels;
uniform vec2 u_curve;
uniform float u_detail;
uniform float u_count;
uniform vec3 u_dim;
uniform vec3 u_bright;

vec2 center(vec2 cell) {
  return u_origin + (cell + 0.5) * u_cell / u_size * u_span;
}

float light(vec2 uv) {
  return dot(texture2D(u_video, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 cell = floor(pixel / u_cell);
  vec2 inside = pixel - cell * u_cell;
  vec2 quarter = 0.25 * u_cell / u_size * u_span;
  vec2 middle = center(cell);
  float here = 0.25 * (light(middle - quarter) + light(middle + quarter)
    + light(middle + vec2(quarter.x, -quarter.y)) + light(middle + vec2(-quarter.x, quarter.y)));
  float around = 0.25 * (light(center(cell + vec2(-1.0, 0.0))) + light(center(cell + vec2(1.0, 0.0)))
    + light(center(cell + vec2(0.0, -1.0))) + light(center(cell + vec2(0.0, 1.0))));
  float sharp = here + u_detail * (here - around);
  float level = clamp((sharp - u_levels.x) / max(u_levels.y - u_levels.x, 0.01), 0.0, 1.0);
  float tone = smoothstep(u_curve.x, u_curve.y, level);
  float glyph = floor(tone * (u_count - 1.0) + 0.5);
  float ink = texture2D(u_glyphs, vec2((glyph * u_cell.x + inside.x) / (u_cell.x * u_count),
    inside.y / u_cell.y)).a;
  gl_FragColor = vec4(mix(u_dim, u_bright, tone) * ink, ink);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function texture(gl: WebGLRenderingContext, unit: number, filter: number) {
  const created = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, created);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return created;
}

// A muted video played out of sight and redrawn on the GPU, frame by frame, as ASCII on a canvas
// that fills the box. It plays only while on screen; under reduced motion it shows one still frame.
// Without WebGL the box stays empty.
export function AsciiVideo({ src, className = '' }: { src: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const element = canvas.current!;
    const footage = video.current!;
    const gl = element.getContext('webgl', { antialias: false });
    if (!gl) return;
    let cancelled = false;

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    // One triangle that covers the whole canvas.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const videoTexture = texture(gl, 0, gl.LINEAR);
    const glyphTexture = texture(gl, 1, gl.NEAREST);
    gl.uniform1i(uniform('u_video'), 0);
    gl.uniform1i(uniform('u_glyphs'), 1);
    gl.uniform2fv(uniform('u_curve'), CURVE);
    gl.uniform1f(uniform('u_detail'), DETAIL);
    gl.uniform1f(uniform('u_count'), RAMP.length);
    gl.uniform3fv(uniform('u_dim'), DIM);
    gl.uniform3fv(uniform('u_bright'), BRIGHT);

    // Each frame's levels come from a small copy of it.
    const meter = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    meter.canvas.width = 64;
    meter.canvas.height = 36;
    let low = 0;
    let high = 1;
    const measure = () => {
      meter.drawImage(footage, 0, 0, 64, 36);
      const pixels = meter.getImageData(0, 0, 64, 36).data;
      const histogram = new Uint32Array(256);
      for (let at = 0; at < pixels.length; at += 4)
        histogram[(pixels[at] * 54 + pixels[at + 1] * 183 + pixels[at + 2] * 19) >> 8]++;
      const cut = 64 * 36 * CLIP;
      let lo = 0;
      for (let seen = histogram[0]; lo < 255 && seen < cut;) seen += histogram[++lo];
      let hi = 255;
      for (let seen = histogram[255]; hi > lo && seen < cut;) seen += histogram[--hi];
      // Eased, so the picture doesn't pump as the levels move.
      low += (lo / 255 - low) * 0.1;
      high += (hi / 255 - high) * 0.1;
    };

    let dirty = true;
    // The glyphs, white on clear, one cell each, side by side; redrawn when the cell size changes.
    let cell = 0;
    const drawGlyphs = (width: number) => {
      cell = width;
      dirty = true;
      const height = Math.round((width / 0.6) * 1.1);
      const atlas = document.createElement('canvas').getContext('2d')!;
      atlas.canvas.width = width * RAMP.length;
      atlas.canvas.height = height;
      atlas.font = `${width / 0.6}px 'Geist Mono Variable', monospace`;
      atlas.textBaseline = 'middle';
      atlas.fillStyle = '#fff';
      [...RAMP].forEach((char, index) => {
        atlas.save();
        atlas.beginPath();
        atlas.rect(index * width, 0, width, height);
        atlas.clip();
        atlas.fillText(char, index * width, height / 2);
        atlas.restore();
      });
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
      gl.uniform2f(uniform('u_cell'), width, height);
    };

    let shown = -1;
    const render = () => {
      if (footage.readyState < 2 || !cell) return;
      dirty = false;
      shown = footage.currentTime;
      measure();
      gl.activeTexture(gl.TEXTURE0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, footage);
      gl.uniform2f(uniform('u_levels'), low, high);
      // Crop the footage to the canvas's shape, like object-fit: cover.
      const shape = element.width / element.height / (footage.videoWidth / footage.videoHeight);
      const span = shape > 1 ? [1, 1 / shape] : [shape, 1];
      gl.uniform2f(uniform('u_span'), span[0], span[1]);
      gl.uniform2f(uniform('u_origin'), (1 - span[0]) / 2, (1 - span[1]) / 2);
      gl.uniform2f(uniform('u_size'), element.width, element.height);
      gl.viewport(0, 0, element.width, element.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Draws whenever the footage has moved on, or the size or the glyphs changed.
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (dirty || footage.currentTime !== shown) render();
    };

    const resizer = new ResizeObserver(([entry]) => {
      const ratio = Math.min(window.devicePixelRatio, 2);
      element.width = Math.round(entry.contentRect.width * ratio);
      element.height = Math.round(entry.contentRect.height * ratio);
      // No cell under 4 device pixels, where the glyphs would blur into each other.
      const width = Math.max(4, Math.round(element.width / COLUMNS));
      if (width !== cell) drawGlyphs(width);
      dirty = true;
    });
    // Mostly off screen counts as gone: a page may slide it away while an edge still shows.
    const watcher = new IntersectionObserver(
      ([entry]) => {
        cancelAnimationFrame(frame);
        if (!entry.isIntersecting) return footage.pause();
        frame = requestAnimationFrame(tick);
        footage.muted = true;
        if (!reduced) footage.play().catch(() => {});
      },
      { threshold: 0.25 },
    );
    const redraw = () => {
      dirty = true;
    };
    // The glyphs need Geist Mono itself, not the fallback.
    document.fonts?.load(`16px 'Geist Mono Variable'`).then(() => {
      if (!cancelled && cell) drawGlyphs(cell);
    });
    footage.addEventListener('loadeddata', redraw);
    resizer.observe(element);
    watcher.observe(element);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resizer.disconnect();
      watcher.disconnect();
      footage.removeEventListener('loadeddata', redraw);
      footage.pause();
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(videoTexture);
      gl.deleteTexture(glyphTexture);
    };
  }, [reduced]);

  return (
    <div className={`ascii-video ${className}`} aria-hidden="true">
      <video
        ref={video}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        style={{ ...FILL, opacity: 0 }}
      />
      <canvas ref={canvas} style={FILL} />
    </div>
  );
}
